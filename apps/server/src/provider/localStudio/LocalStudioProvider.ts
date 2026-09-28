import {
  LOCAL_AI_EMPTY_STATE_MESSAGE,
  type GatewayModel,
  type LocalStudioHarness,
} from "@local-studio/t3-providers";
import type { ServerProviderModel } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { LocalStudioGatewayError } from "../../localStudio/LocalStudioGateway.ts";
import {
  buildServerProvider,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
  type ServerProviderPresentation,
} from "../providerSnapshot.ts";
import {
  materializePiBridge,
  resolvePiNodeCommand,
  type LocalStudioHarnessLaunch,
} from "./LocalStudioAcpSupport.ts";

const isGatewayError = Schema.is(LocalStudioGatewayError);

export interface ResolvedHarness {
  readonly launch: LocalStudioHarnessLaunch;
  readonly version: string | null;
  readonly bridge?: { readonly nodeCommand: string; readonly bridgePath: string };
}

const VERSION_PROBE_TIMEOUT = "6 seconds";
const HARNESS_CACHE_MS = 60_000;

const probeVersion = (launch: LocalStudioHarnessLaunch, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(launch.binaryPath, ["--version"], {
      env: environment,
    });
    const result = yield* spawnAndCollect(
      launch.binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
    if (result.code !== 0) {
      return yield* new LocalStudioGatewayError({
        operation: "probeHarness",
        detail: `${launch.binaryPath} --version exited with ${result.code}`,
      });
    }
    return parseGenericCliVersion(`${result.stdout}\n${result.stderr}`);
  }).pipe(
    Effect.timeout(VERSION_PROBE_TIMEOUT),
    Effect.mapError((cause) =>
      isGatewayError(cause)
        ? cause
        : new LocalStudioGatewayError({
            operation: "probeHarness",
            detail: `${launch.binaryPath} is not installed or did not answer`,
            cause,
          }),
    ),
  );

const resolveLaunch = (
  launch: LocalStudioHarnessLaunch,
  environment: NodeJS.ProcessEnv,
  stateDir: string,
) =>
  Effect.gen(function* () {
    const version = yield* probeVersion(launch, environment);
    if (launch.harness === "omp") {
      return { launch, version } satisfies ResolvedHarness;
    }
    const bridgePath = yield* materializePiBridge(stateDir);
    const nodeCommand = yield* resolvePiNodeCommand(launch.binaryPath);
    return { launch, version, bridge: { nodeCommand, bridgePath } } satisfies ResolvedHarness;
  });

export const makeHarnessResolver = (input: {
  readonly candidates: ReadonlyArray<LocalStudioHarnessLaunch>;
  readonly environment: NodeJS.ProcessEnv;
  readonly stateDir: string;
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cache = yield* Ref.make<{ readonly at: number; readonly value: ResolvedHarness } | null>(
      null,
    );
    const resolveFresh = Effect.gen(function* () {
      const failures: Array<string> = [];
      for (const candidate of input.candidates) {
        const result = yield* resolveLaunch(candidate, input.environment, input.stateDir).pipe(
          Effect.result,
        );
        if (Result.isSuccess(result)) {
          return result.success;
        }
        failures.push(result.failure.detail);
      }
      return yield* new LocalStudioGatewayError({
        operation: "resolveHarness",
        detail: failures.join("; ") || "no agent harness configured",
      });
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const resolve = (options?: { readonly fresh?: boolean }) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowMs = DateTime.toEpochMillis(now);
        const cached = yield* Ref.get(cache);
        if (!options?.fresh && cached && nowMs - cached.at < HARNESS_CACHE_MS) {
          return cached.value;
        }
        const value = yield* resolveFresh;
        yield* Ref.set(cache, { at: nowMs, value });
        return value;
      });
    return resolve;
  });

function gatewayModelsToProviderModels(
  models: ReadonlyArray<GatewayModel>,
  defaultModel: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const result: Array<ServerProviderModel> = [];
  for (const model of models) {
    const slug = model.id.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    result.push({
      slug,
      name: slug,
      isCustom: false,
      ...(defaultModel && slug === defaultModel ? { isDefault: true } : {}),
      capabilities: createModelCapabilities({ optionDescriptors: [] }),
    });
  }
  if (!result.some((model) => model.isDefault) && result[0]) {
    result[0] = { ...result[0], isDefault: true };
  }
  return result;
}

function harnessLabel(harness: LocalStudioHarness): string {
  return harness === "omp" ? "omp" : "pi";
}

export const buildInitialLocalStudioSnapshot = (input: {
  readonly presentation: ServerProviderPresentation;
  readonly enabled: boolean;
}): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: input.presentation,
      enabled: input.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Local Studio models...",
      },
    });
  });

export const checkLocalStudioSnapshot = (input: {
  readonly presentation: ServerProviderPresentation;
  readonly enabled: boolean;
  readonly defaultModel: string | undefined;
  readonly resolveHarness: Effect.Effect<ResolvedHarness, LocalStudioGatewayError>;
  readonly listReadyModels: Effect.Effect<ReadonlyArray<GatewayModel>, LocalStudioGatewayError>;
}): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!input.enabled) {
      return buildServerProvider({
        presentation: input.presentation,
        enabled: false,
        checkedAt,
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: `${input.presentation.displayName} is disabled in settings.`,
        },
      });
    }
    const [harness, models] = yield* Effect.all(
      [Effect.result(input.resolveHarness), Effect.result(input.listReadyModels)],
      { concurrency: "unbounded" },
    );
    const providerModels = Result.isSuccess(models)
      ? gatewayModelsToProviderModels(models.success, input.defaultModel)
      : [];
    if (Result.isFailure(harness)) {
      return {
        ...buildServerProvider({
          presentation: input.presentation,
          enabled: true,
          checkedAt,
          models: providerModels,
          probe: {
            installed: false,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: `No agent harness available: ${harness.failure.detail}`,
          },
        }),
      };
    }
    const version = harness.success.version;
    if (providerModels.length === 0) {
      return {
        ...buildServerProvider({
          presentation: input.presentation,
          enabled: true,
          checkedAt,
          models: [],
          probe: {
            installed: true,
            version,
            status: "warning",
            auth: { status: "unknown" },
            message: LOCAL_AI_EMPTY_STATE_MESSAGE,
          },
        }),
        setup: { canAuthenticate: false, canInstall: true },
      };
    }
    return buildServerProvider({
      presentation: input.presentation,
      enabled: true,
      checkedAt,
      models: providerModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: {
          status: "authenticated",
          label: `Local Studio via ${harnessLabel(harness.success.launch.harness)}`,
        },
      },
    });
  });
