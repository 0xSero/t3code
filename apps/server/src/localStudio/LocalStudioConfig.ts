import {
  DEFAULT_LOCAL_STUDIO_CONTROLLER_URL,
  LOCAL_STUDIO_GATEWAY_URL_ENV,
} from "@local-studio/t3-providers";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

export const LocalStudioMode = Schema.Literals(["sidecar", "remote", "off"]);
export type LocalStudioMode = typeof LocalStudioMode.Type;

const LocalStudioConfigFile = Schema.Struct({
  mode: Schema.optional(LocalStudioMode),
  url: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
  harnessKeys: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type LocalStudioConfigFile = typeof LocalStudioConfigFile.Type;

export interface LocalStudioSettings {
  readonly mode: LocalStudioMode;
  readonly url: string;
  readonly configuredUrl: string | null;
  readonly envUrl: string | null;
  readonly key: string | null;
  readonly harnessKeys: Readonly<Record<string, string>>;
}

const decodeConfigFile = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalStudioConfigFile));
const encodeConfigFile = Schema.encodeEffect(Schema.fromJsonString(LocalStudioConfigFile));

export const normalizeControllerUrl = (url: string): string => url.trim().replace(/\/+$/, "");

export const isLoopbackUrl = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
};

const configPath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, "local-studio.json");
});

const readConfigFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* configPath;
  const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  if (raw.trim().length === 0) return {} satisfies LocalStudioConfigFile;
  return yield* decodeConfigFile(raw).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("Ignoring unreadable Local Studio config", { file, cause }),
    ),
    Effect.orElseSucceed((): LocalStudioConfigFile => ({})),
  );
});

export const readSettings = Effect.gen(function* () {
  const file = yield* readConfigFile;
  const environment = yield* HostProcessEnvironment;
  const rawEnvUrl = environment[LOCAL_STUDIO_GATEWAY_URL_ENV];
  const envUrl =
    rawEnvUrl !== undefined && rawEnvUrl.trim().length > 0
      ? normalizeControllerUrl(rawEnvUrl)
      : null;
  const configuredUrl = file.url ? normalizeControllerUrl(file.url) : null;
  const mode = file.mode ?? "sidecar";
  const url =
    mode === "remote"
      ? (configuredUrl ?? envUrl ?? DEFAULT_LOCAL_STUDIO_CONTROLLER_URL)
      : (envUrl ?? configuredUrl ?? DEFAULT_LOCAL_STUDIO_CONTROLLER_URL);
  return {
    mode,
    url,
    configuredUrl,
    envUrl,
    key: file.key && file.key.length > 0 ? file.key : null,
    harnessKeys: file.harnessKeys ?? {},
  } satisfies LocalStudioSettings;
});

const writeConfigFile = (next: LocalStudioConfigFile) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* configPath;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    const stamp = yield* Clock.currentTimeMillis;
    const temp = `${file}.${stamp.toString(36)}.tmp`;
    const text = yield* encodeConfigFile(next);
    yield* fs.writeFileString(temp, `${text}\n`, { mode: 0o600 });
    yield* fs.chmod(temp, 0o600);
    yield* fs.rename(temp, file);
  });

export const updateConfig = (patch: (current: LocalStudioConfigFile) => LocalStudioConfigFile) =>
  Effect.gen(function* () {
    const current = yield* readConfigFile;
    yield* writeConfigFile(patch(current));
    return yield* readSettings;
  });
