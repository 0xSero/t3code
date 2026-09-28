import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { type ControllerBinarySource, locateControllerBinary } from "./ControllerLocator.ts";
import { isLoopbackUrl, readSettings } from "./LocalStudioConfig.ts";

const HEALTH_PROBE_TIMEOUT = Duration.seconds(2);
const HEALTH_POLL_INTERVAL = Duration.millis(250);
const HEALTH_POLL_ATTEMPTS = 60;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const STABLE_UPTIME_MS = 60_000;
const WATCH_INTERVAL = Duration.seconds(5);
const KILL_GRACE = Duration.seconds(3);

const ControllerHealth = Schema.Struct({
  status: Schema.String,
  service: Schema.Literal("local-studio"),
  version: Schema.optional(Schema.String),
  machineId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  api: Schema.optional(Schema.Number),
  readOnly: Schema.optional(Schema.Boolean),
});
export type ControllerHealth = typeof ControllerHealth.Type;

const decodeHealth = Schema.decodeUnknownEffect(ControllerHealth);

export type SidecarState =
  | "checking"
  | "external"
  | "starting"
  | "running"
  | "unavailable"
  | "failed"
  | "remote"
  | "off";

export interface SidecarStatus {
  readonly state: SidecarState;
  readonly url: string;
  readonly owned: boolean;
  readonly pid: number | null;
  readonly binary: string | null;
  readonly source: ControllerBinarySource | null;
  readonly detail: string | null;
  readonly health: ControllerHealth | null;
}

const probeHealth = (
  httpClient: HttpClient.HttpClient,
  url: string,
): Effect.Effect<ControllerHealth | null> =>
  httpClient.execute(HttpClientRequest.get(`${url}/health`)).pipe(
    Effect.flatMap((response): Effect.Effect<unknown, unknown> =>
      response.status === 200 ? response.json : Effect.succeed(null),
    ),
    Effect.flatMap((body) => decodeHealth(body)),
    Effect.scoped,
    Effect.timeout(HEALTH_PROBE_TIMEOUT),
    Effect.option,
    Effect.map((option) => (option._tag === "Some" ? option.value : null)),
  );

const controllerPort = (url: string): string => {
  const parsed = new URL(url);
  if (parsed.port.length > 0) return parsed.port;
  return parsed.protocol === "https:" ? "443" : "80";
};

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const initial = yield* readSettings;
  const statusRef = yield* Ref.make<SidecarStatus>({
    state: "checking",
    url: initial.url,
    owned: false,
    pid: null,
    binary: null,
    source: null,
    detail: null,
    health: null,
  });
  const backoffRef = yield* Ref.make(0);

  const setStatus = (patch: Partial<SidecarStatus> & { readonly state: SidecarState }) =>
    Ref.update(statusRef, (current) => ({
      ...current,
      owned: false,
      pid: null,
      detail: null,
      ...patch,
    }));

  const nextBackoff = Ref.modify(backoffRef, (current) => {
    const next = current === 0 ? MIN_BACKOFF_MS : Math.min(current * 2, MAX_BACKOFF_MS);
    return [next, next];
  });

  const settingsChanged = (mode: string, url: string) =>
    Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(WATCH_INTERVAL);
        const settings = yield* readSettings;
        if (settings.mode !== mode || settings.url !== url) return;
      }
    });

  const waitHealthy = (url: string, child: ChildProcessSpawner.ChildProcessHandle) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < HEALTH_POLL_ATTEMPTS; attempt += 1) {
        const health = yield* probeHealth(httpClient, url);
        if (health) return health;
        const running = yield* child.isRunning.pipe(Effect.orElseSucceed(() => false));
        if (!running) return null;
        yield* Effect.sleep(HEALTH_POLL_INTERVAL);
      }
      return null;
    });

  const runOwned = (url: string, mode: string) =>
    Effect.gen(function* () {
      const binary = yield* locateControllerBinary;
      if (!binary) {
        yield* setStatus({
          state: "unavailable",
          url,
          binary: null,
          source: null,
          health: null,
          detail:
            "No Local Studio controller found in the app bundle, LOCAL_STUDIO_BIN, ~/.local-studio/bin or PATH",
        });
        return yield* Effect.race(
          Effect.sleep(Duration.millis(MAX_BACKOFF_MS)),
          settingsChanged(mode, url),
        );
      }
      const scope = yield* Scope.make("sequential");
      const outcome = yield* Effect.gen(function* () {
        const child = yield* spawner
          .spawn(
            ChildProcess.make(
              binary.path,
              ["serve", "--host", "127.0.0.1", "--port", controllerPort(url), "--tailnet"],
              {
                shell: false,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                killSignal: "SIGTERM",
                forceKillAfter: KILL_GRACE,
              },
            ),
          )
          .pipe(Effect.provideService(Scope.Scope, scope));
        const pid = Number(child.pid);
        yield* Effect.forkIn(
          child.all.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line.trim().length > 0),
            Stream.runForEach((line) =>
              Effect.logDebug("Local Studio controller output", { pid, output: line }),
            ),
            Effect.ignoreCause,
          ),
          scope,
        );
        yield* setStatus({
          state: "starting",
          url,
          owned: true,
          pid,
          binary: binary.path,
          source: binary.source,
          health: null,
        });
        const startedAt = yield* Clock.currentTimeMillis;
        const health = yield* waitHealthy(url, child);
        if (!health) {
          return { kind: "failed" as const, detail: "controller did not answer /health in time" };
        }
        yield* setStatus({
          state: "running",
          url,
          owned: true,
          pid,
          binary: binary.path,
          source: binary.source,
          health,
        });
        yield* Effect.logInfo("Local Studio controller sidecar running", {
          pid,
          url,
          binary: binary.path,
          source: binary.source,
        });
        const ended = yield* Effect.raceFirst(
          child.exitCode.pipe(
            Effect.map((code) => ({ kind: "exited" as const, detail: `exited with code ${code}` })),
            Effect.orElseSucceed(() => ({ kind: "exited" as const, detail: "exited" })),
          ),
          settingsChanged(mode, url).pipe(Effect.as({ kind: "reconfigured" as const, detail: "" })),
        );
        const uptime = (yield* Clock.currentTimeMillis) - startedAt;
        if (uptime >= STABLE_UPTIME_MS) yield* Ref.set(backoffRef, 0);
        return ended;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed({ kind: "failed" as const, detail: `could not start: ${String(cause)}` }),
        ),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );
      if (outcome.kind === "reconfigured") return;
      const delay = yield* nextBackoff;
      yield* Effect.logWarning("Local Studio controller sidecar stopped; retrying", {
        detail: outcome.detail,
        delayMs: delay,
      });
      yield* setStatus({
        state: "failed",
        url,
        binary: binary.path,
        source: binary.source,
        health: null,
        detail: outcome.detail,
      });
      yield* Effect.race(Effect.sleep(Duration.millis(delay)), settingsChanged(mode, url));
    });

  const step = Effect.gen(function* () {
    const settings = yield* readSettings;
    if (settings.mode === "off") {
      yield* setStatus({ state: "off", url: settings.url, health: null });
      return yield* settingsChanged(settings.mode, settings.url);
    }
    const health = yield* probeHealth(httpClient, settings.url);
    if (settings.mode === "remote" || !isLoopbackUrl(settings.url)) {
      yield* setStatus({
        state: settings.mode === "remote" ? "remote" : "external",
        url: settings.url,
        health,
        binary: null,
        source: null,
        detail: health ? null : "controller is not answering /health",
      });
      return yield* Effect.sleep(WATCH_INTERVAL);
    }
    if (health) {
      yield* Ref.set(backoffRef, 0);
      yield* setStatus({
        state: "external",
        url: settings.url,
        health,
        binary: null,
        source: null,
      });
      return yield* Effect.sleep(WATCH_INTERVAL);
    }
    yield* runOwned(settings.url, settings.mode);
  });

  yield* Effect.forkScoped(
    Effect.forever(
      step.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Local Studio sidecar supervisor step failed", { cause }).pipe(
            Effect.andThen(Effect.sleep(WATCH_INTERVAL)),
          ),
        ),
      ),
    ),
  );

  return { status: Ref.get(statusRef) };
});
