import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePathWith } from "../pathExpansion.ts";

const LOCAL_STUDIO_BIN_ENV = "LOCAL_STUDIO_BIN";

export type ControllerBinarySource = "bundled" | "env" | "home" | "path";

export interface ControllerBinary {
  readonly path: string;
  readonly source: ControllerBinarySource;
}

const binaryName = (platform: NodeJS.Platform) =>
  platform === "win32" ? "local-studio.exe" : "local-studio";

const bundledResourceDirs = (
  executablePath: string,
  platform: NodeJS.Platform,
  path: Path.Path,
) => {
  const executableDir = path.dirname(executablePath);
  return platform === "darwin"
    ? [path.join(executableDir, "..", "Resources"), path.join(executableDir, "resources")]
    : [path.join(executableDir, "resources")];
};

const isExecutableFile = (candidate: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(candidate);
    return info.type === "File" && (info.mode & 0o111) !== 0;
  }).pipe(Effect.orElseSucceed(() => false));

const controllerBinaryCandidates = Effect.gen(function* () {
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const executablePath = yield* HostProcessExecutablePath;
  const name = binaryName(platform);
  const candidates: Array<ControllerBinary> = bundledResourceDirs(
    executablePath,
    platform,
    path,
  ).map((dir) => ({ path: path.join(dir, "local-studio", name), source: "bundled" }));
  const fromEnv = environment[LOCAL_STUDIO_BIN_ENV]?.trim();
  if (fromEnv) candidates.push({ path: expandHomePathWith(fromEnv, path), source: "env" });
  candidates.push({
    path: expandHomePathWith(`~/.local-studio/bin/${name}`, path),
    source: "home",
  });
  const pathValue = environment.PATH ?? environment.Path ?? "";
  const separator = platform === "win32" ? ";" : ":";
  for (const dir of pathValue.split(separator)) {
    if (dir.trim().length > 0) candidates.push({ path: path.join(dir, name), source: "path" });
  }
  return candidates;
});

export const locateControllerBinary = Effect.gen(function* () {
  const candidates = yield* controllerBinaryCandidates;
  for (const candidate of candidates) {
    if (yield* isExecutableFile(candidate.path)) return candidate;
  }
  return null;
});
