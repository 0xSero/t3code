import * as NodeOS from "node:os";

import {
  DEFAULT_LOCAL_STUDIO_CONTROLLER_URL,
  LOCAL_STUDIO_GATEWAY_URL_ENV,
} from "@local-studio/t3-providers";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { ChildProcess } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";
import {
  controllerIsUp,
  gatewayKeyIsValid,
  issueGatewayKey,
  listReadyGatewayModels,
} from "./gatewayHttp.ts";
import { PROVIDER_PROFILES, type ProfileFile, type ProviderProfile } from "./providerProfiles.ts";

const SYNC_INTERVAL = "20 seconds";
const AGENT_HOME_ENV = "LOCAL_STUDIO_AGENT_HOME";
const STATE_FILE = "t3-instances.json";

const instanceIdFor = (profile: ProviderProfile) => `localstudio-${profile.driver}`;

const gatewayUrl = () =>
  (
    process.env[LOCAL_STUDIO_GATEWAY_URL_ENV]?.trim() || DEFAULT_LOCAL_STUDIO_CONTROLLER_URL
  ).replace(/\/+$/, "");

const agentHome = () =>
  process.env[AGENT_HOME_ENV]?.trim() || `${NodeOS.homedir()}/.local-studio/agents/t3`;

const readText = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(filePath);
  }).pipe(Effect.orElseSucceed(() => null));

const readCreated = (home: string) =>
  readText(`${home}/${STATE_FILE}`).pipe(
    Effect.map((text): ReadonlyArray<string> => {
      if (!text) return [];
      try {
        const parsed = JSON.parse(text) as { created?: unknown };
        return Array.isArray(parsed.created)
          ? parsed.created.filter((id): id is string => typeof id === "string")
          : [];
      } catch {
        return [];
      }
    }),
  );

const stateContents = (created: ReadonlySet<string>) =>
  `${JSON.stringify({ created: [...created].toSorted() }, null, 2)}\n`;

const writeProfileFile = (file: ProfileFile) =>
  Effect.gen(function* () {
    const existing = yield* readText(file.path);
    const contents = file.merge ? file.merge(existing) : file.contents;
    if (existing === contents) return;
    yield* writeFileStringAtomically({ filePath: file.path, contents });
  });

const isOnPath = (binary: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (binary.includes("/")) {
      return yield* fs.exists(binary).pipe(Effect.orElseSucceed(() => false));
    }
    const searchPath = process.env.PATH ?? "";
    for (const directory of searchPath.split(searchPath.includes(";") ? ";" : ":")) {
      if (!directory) continue;
      const found = yield* fs
        .exists(path.join(directory, binary))
        .pipe(Effect.orElseSucceed(() => false));
      if (found) return true;
    }
    return false;
  });

const configuredBinary = (settings: ServerSettings, profile: ProviderProfile) => {
  const legacy = (settings.providers as Record<string, { binaryPath?: unknown } | undefined>)[
    profile.driver
  ];
  const value = typeof legacy?.binaryPath === "string" ? legacy.binaryPath.trim() : "";
  return value.length > 0 ? value : profile.defaultBinary;
};

const warmUp = (
  binary: string,
  profile: ProviderProfile,
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
) =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const variable of environment) env[variable.name] = variable.value;
    for (const args of profile.warmup) {
      const spawnCommand = yield* resolveSpawnCommand(binary, args, { env });
      yield* spawnAndCollect(
        binary,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env,
          shell: spawnCommand.shell,
        }),
      ).pipe(Effect.timeout("90 seconds"), Effect.ignore);
    }
  }).pipe(Effect.ignore);

const envKey = (variable: ProviderInstanceEnvironmentVariable) =>
  `${variable.name}\u0000${variable.sensitive ? "1" : "0"}\u0000${variable.value}`;

const sameEnvelope = (
  current: ProviderInstanceConfig | undefined,
  next: ProviderInstanceConfig,
): boolean =>
  current !== undefined &&
  current.driver === next.driver &&
  current.displayName === next.displayName &&
  current.enabled === next.enabled &&
  JSON.stringify(current.config ?? null) === JSON.stringify(next.config ?? null) &&
  (current.environment ?? []).map(envKey).join("\n") ===
    (next.environment ?? []).map(envKey).join("\n");

const currentKey = (
  current: ProviderInstanceConfig | undefined,
  profile: ProviderProfile,
): string | undefined =>
  current?.environment?.findLast((variable) => variable.name === profile.keyVariable)?.value ||
  undefined;

const syncOnce = Effect.gen(function* () {
  const url = gatewayUrl();
  if (!(yield* controllerIsUp(url))) return;
  const models = yield* listReadyGatewayModels(url);
  if (Option.isNone(models) || models.value.length === 0) return;

  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings;
  const home = agentHome();
  const created = new Set(yield* readCreated(home));
  const updates: Record<string, ProviderInstanceConfig> = {};

  for (const profile of PROVIDER_PROFILES) {
    const id = instanceIdFor(profile);
    const current = settings.providerInstances[ProviderInstanceId.make(id)];
    if (!current && created.has(id)) continue;
    const binary = configuredBinary(settings, profile);
    if (!(yield* isOnPath(binary))) continue;

    let key = currentKey(current, profile);
    const valid = key ? yield* gatewayKeyIsValid(url, key) : Option.some(false);
    if (Option.isNone(valid)) continue;
    if (!valid.value) {
      const issued = yield* issueGatewayKey(url, profile.client);
      if (Option.isNone(issued)) continue;
      key = issued.value.key;
      yield* Effect.logInfo("Local Studio issued a gateway key", {
        instanceId: id,
        keyId: issued.value.id,
      });
    }
    if (!key) continue;

    const built = profile.build({
      gatewayUrl: url,
      home,
      models: models.value,
      key,
      binaryPath: binary === profile.defaultBinary ? undefined : binary,
    });
    for (const file of built.files) {
      yield* writeProfileFile(file);
    }
    const envelope: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make(profile.driver),
      displayName: current?.displayName ?? `${profile.label} · Local Studio`,
      ...(current?.accentColor ? { accentColor: current.accentColor } : {}),
      enabled: current?.enabled ?? true,
      environment: built.environment,
      config: built.config,
    };
    if (!current) yield* warmUp(binary, profile, built.environment);
    created.add(id);
    if (!sameEnvelope(current, envelope)) updates[id] = envelope;
  }

  if (Object.keys(updates).length > 0) {
    const latest = yield* settingsService.getSettings;
    yield* settingsService.updateSettings({
      providerInstances: {
        ...latest.providerInstances,
        ...updates,
      } as ServerSettings["providerInstances"],
    });
    yield* Effect.logInfo("Local Studio provider instances synced", {
      models: models.value.map((model) => model.id),
    });
  }
  yield* writeFileStringAtomically({
    filePath: `${home}/${STATE_FILE}`,
    contents: stateContents(created),
  });
});

export const localStudioProviderSyncLayer = Layer.effectDiscard(
  syncOnce.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Local Studio provider sync failed", cause)),
    Effect.repeat(Schedule.spaced(SYNC_INTERVAL)),
    Effect.forkScoped,
  ),
);
