import {
  LOCAL_AI_DRIVER_KIND,
  LOCAL_AI_PROVIDER_LABEL,
  LocalAiSettings,
  OMP_DRIVER_KIND,
  OmpSettings,
  PI_DRIVER_KIND,
  PiSettings,
  type LocalStudioHarness,
} from "@local-studio/t3-providers";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { LocalStudioGateway } from "../../localStudio/LocalStudioGateway.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { withInstanceIdentity } from "../Drivers/instanceIdentity.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import type { ServerProviderPresentation } from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { splitExtraArgs, type LocalStudioHarnessLaunch } from "./LocalStudioAcpSupport.ts";
import { makeLocalStudioAgentAdapter } from "./LocalStudioAgentAdapter.ts";
import { LocalStudioGatewayLive, resolveLocalStudioAgentRoot } from "./LocalStudioGatewayLive.ts";
import {
  buildInitialLocalStudioSnapshot,
  checkLocalStudioSnapshot,
  makeHarnessResolver,
} from "./LocalStudioProvider.ts";
import { makeLocalStudioTextGeneration } from "./LocalStudioTextGeneration.ts";

export type LocalStudioAgentDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

interface LocalStudioDriverSpec<Config extends { readonly enabled: boolean }> {
  readonly driverKind: string;
  readonly displayName: string;
  readonly harnessName: string;
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly textClient: LocalStudioHarness;
  readonly candidates: (config: Config) => ReadonlyArray<LocalStudioHarnessLaunch>;
  readonly defaultModel: (config: Config) => string | undefined;
}

const REFRESH_INTERVAL = "15 seconds";

const launchFor = (
  harness: LocalStudioHarness,
  binaryPath: string,
  thinkingLevel: string,
  extraArgs?: string,
): LocalStudioHarnessLaunch => ({
  harness,
  binaryPath: binaryPath.trim() || harness,
  thinkingLevel,
  extraArgs: splitExtraArgs(extraArgs),
});

function makeLocalStudioAgentDriver<Config extends { readonly enabled: boolean }>(
  spec: LocalStudioDriverSpec<Config>,
): ProviderDriver<Config, LocalStudioAgentDriverEnv> {
  const driverKind = ProviderDriverKind.make(spec.driverKind);
  const decodeDefault = Schema.decodeUnknownSync(spec.configSchema);
  const presentation: ServerProviderPresentation = {
    displayName: spec.displayName,
    showInteractionModeToggle: true,
    supportsConversationRollback: false,
  };
  return {
    driverKind,
    metadata: { displayName: spec.displayName, supportsMultipleInstances: true },
    configSchema: spec.configSchema,
    defaultConfig: () => decodeDefault({}),
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsService;
        const serverConfig = yield* ServerConfig;
        const path = yield* Path.Path;
        const gateway = yield* Effect.service(LocalStudioGateway).pipe(
          Effect.provide(LocalStudioGatewayLive),
        );
        const agentRoot = yield* resolveLocalStudioAgentRoot;
        const agentDir = path.join(agentRoot, instanceId);
        const processEnv = mergeProviderInstanceEnvironment(environment);
        const effectiveConfig = { ...config, enabled } as Config;
        const defaultModel = spec.defaultModel(effectiveConfig)?.trim() || undefined;
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind,
          instanceId,
        });
        const stampIdentity = withInstanceIdentity({
          instanceId,
          driverKind,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });
        const resolveHarness = yield* makeHarnessResolver({
          candidates: spec.candidates(effectiveConfig),
          environment: processEnv,
          stateDir: serverConfig.stateDir,
        });
        const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: driverKind,
              packageName: null,
            }),
          ),
        );
        const snapshotSettings = makeProviderSnapshotSettingsSource(
          effectiveConfig,
          serverSettings,
        );
        const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<Config>>({
          resolveMaintenance,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          refreshInterval: REFRESH_INTERVAL,
          initialSnapshot: (settings) =>
            buildInitialLocalStudioSnapshot({
              presentation,
              enabled: settings.provider.enabled,
            }).pipe(Effect.map(stampIdentity)),
          checkProvider: checkLocalStudioSnapshot({
            presentation,
            enabled: effectiveConfig.enabled,
            defaultModel,
            resolveHarness: resolveHarness({ fresh: true }),
            listReadyModels: gateway.listReadyModels(),
          }).pipe(Effect.map(stampIdentity)),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: driverKind,
                instanceId,
                detail: `Failed to build ${spec.displayName} snapshot: ${cause.message ?? String(cause)}`,
                cause,
              }),
          ),
        );
        const adapter = yield* makeLocalStudioAgentAdapter({
          provider: driverKind,
          instanceId,
          harnessName: spec.harnessName,
          agentDir,
          environment: processEnv,
          gateway,
          resolveHarness,
          defaultModel,
        });
        const textGeneration = yield* makeLocalStudioTextGeneration({
          gateway,
          client: spec.textClient,
          defaultModel,
        });
        return {
          instanceId,
          driverKind,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          snapshot,
          refreshModels: () => snapshot.refresh.pipe(Effect.asVoid),
          adapter,
          textGeneration,
        } satisfies ProviderInstance;
      }),
  };
}

export const LocalAiDriver = makeLocalStudioAgentDriver<LocalAiSettings>({
  driverKind: LOCAL_AI_DRIVER_KIND,
  displayName: LOCAL_AI_PROVIDER_LABEL,
  harnessName: LOCAL_AI_PROVIDER_LABEL,
  configSchema: LocalAiSettings,
  textClient: "omp",
  candidates: (config) => {
    const omp = launchFor("omp", config.ompBinaryPath, config.thinkingLevel);
    const pi = launchFor("pi", config.piBinaryPath, config.thinkingLevel);
    return config.harness === "omp" ? [omp] : config.harness === "pi" ? [pi] : [omp, pi];
  },
  defaultModel: () => undefined,
});

export const OmpDriver = makeLocalStudioAgentDriver<OmpSettings>({
  driverKind: OMP_DRIVER_KIND,
  displayName: "omp",
  harnessName: "omp",
  configSchema: OmpSettings,
  textClient: "omp",
  candidates: (config) => [
    launchFor("omp", config.binaryPath, config.thinkingLevel, config.extraArgs),
  ],
  defaultModel: (config) => config.defaultModel,
});

export const PiDriver = makeLocalStudioAgentDriver<PiSettings>({
  driverKind: PI_DRIVER_KIND,
  displayName: "pi",
  harnessName: "pi",
  configSchema: PiSettings,
  textClient: "pi",
  candidates: (config) => [
    launchFor("pi", config.binaryPath, config.thinkingLevel, config.extraArgs),
  ],
  defaultModel: (config) => config.defaultModel,
});
