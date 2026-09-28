import * as NodeOS from "node:os";

import { PI_ACP_BUNDLE_SHA256, PI_ACP_BUNDLE_SOURCE } from "@local-studio/pi-acp/bundle";
import {
  buildHarnessEnvironment,
  buildHarnessModelsConfig,
  harnessModelId,
  ompApprovalModeFor,
  piNeedsApprovalGate,
  type GatewayModel,
  type LocalStudioHarness,
} from "@local-studio/t3-providers";
import type { ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  LocalStudioGatewayError,
  type LocalStudioGateway,
} from "../../localStudio/LocalStudioGateway.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";

let tempCounter = 0;
const isGatewayError = Schema.is(LocalStudioGatewayError);

export interface LocalStudioHarnessLaunch {
  readonly harness: LocalStudioHarness;
  readonly binaryPath: string;
  readonly extraArgs: ReadonlyArray<string>;
  readonly thinkingLevel: string;
}

export interface PreparedHarnessHome {
  readonly agentDir: string;
  readonly keyFile: string;
  readonly models: ReadonlyArray<GatewayModel>;
}

export function splitExtraArgs(raw: string | undefined): ReadonlyArray<string> {
  const text = raw?.trim() ?? "";
  if (!text) return [];
  const matches = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((part) =>
    (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))
      ? part.slice(1, -1)
      : part,
  );
}

const writeAtomic = (target: string, content: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    tempCounter += 1;
    const temporary = `${target}.${process.pid}.${tempCounter}.tmp`;
    yield* fileSystem.writeFileString(temporary, content, { mode: 0o600 });
    yield* fileSystem.rename(temporary, target);
  });

export const prepareHarnessHome = (input: {
  readonly gateway: LocalStudioGateway["Service"];
  readonly harness: LocalStudioHarness;
  readonly agentDir: string;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem
      .makeDirectory(path.join(input.agentDir, "sessions"), { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(
          (cause) =>
            new LocalStudioGatewayError({
              operation: "prepareHarnessHome",
              detail: `could not create ${input.agentDir}`,
              cause,
            }),
        ),
      );
    const models = yield* input.gateway.listReadyModels();
    const { keyFile } = yield* input.gateway.ensureHarnessKey(input.harness);
    const gatewayUrl = yield* input.gateway.gatewayUrl;
    const config = buildHarnessModelsConfig({
      harness: input.harness,
      gatewayUrl,
      keyFile,
      models,
    });
    yield* writeAtomic(path.join(input.agentDir, config.fileName), config.content).pipe(
      Effect.mapError(
        (cause) =>
          new LocalStudioGatewayError({
            operation: "prepareHarnessHome",
            detail: `could not write ${config.fileName}`,
            cause,
          }),
      ),
    );
    return { agentDir: input.agentDir, keyFile, models } satisfies PreparedHarnessHome;
  });

export const materializePiBridge = (stateDir: string) =>
  Effect.gen(function* () {
    if (!PI_ACP_BUNDLE_SOURCE) {
      return yield* new LocalStudioGatewayError({
        operation: "materializePiBridge",
        detail: "this build does not bundle the pi ACP bridge",
      });
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(stateDir, "local-studio");
    const target = path.join(directory, `pi-acp-${PI_ACP_BUNDLE_SHA256.slice(0, 8)}.mjs`);
    const present = yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
    if (!present) {
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* writeAtomic(target, PI_ACP_BUNDLE_SOURCE);
    }
    return target;
  }).pipe(
    Effect.mapError((cause) =>
      isGatewayError(cause)
        ? cause
        : new LocalStudioGatewayError({
            operation: "materializePiBridge",
            detail: "could not write the pi ACP bridge",
            cause,
          }),
    ),
  );

export const resolvePiNodeCommand = (piBinary: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const head = yield* fileSystem.readFileString(piBinary).pipe(Effect.orElseSucceed(() => ""));
    const shebang = head.startsWith("#!") ? head.slice(2, head.indexOf("\n")).trim() : "";
    const parts = shebang.split(/\s+/).filter(Boolean);
    if (parts[0]?.endsWith("/env") && parts[1] === "node") return "node";
    if (parts[0] && /\/node$/.test(parts[0])) return parts[0];
    return "node";
  });

export function buildLocalStudioSpawnInput(input: {
  readonly launch: LocalStudioHarnessLaunch;
  readonly agentDir: string;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode | undefined;
  readonly workspace: string;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly overrides?: NodeJS.ProcessEnv;
  readonly bridge?: { readonly nodeCommand: string; readonly bridgePath: string };
  readonly path: Path.Path;
}): AcpSessionRuntime.AcpSpawnInput {
  const homeDir = NodeOS.homedir();
  const relativeAgentDir = input.path.relative(homeDir, input.agentDir);
  const env = buildHarnessEnvironment({
    harness: input.launch.harness,
    base: input.baseEnvironment,
    ...(input.overrides ? { overrides: input.overrides } : {}),
    agentDir: input.agentDir,
    homeDir,
    relativeAgentDir,
    workspace: input.workspace,
  });
  if (input.launch.harness === "omp") {
    return {
      command: input.launch.binaryPath,
      args: [
        "--mode",
        "acp",
        "--approval-mode",
        ompApprovalModeFor(input.runtimeMode),
        ...input.launch.extraArgs,
      ],
      cwd: input.cwd,
      env,
      extendEnv: false,
    };
  }
  return {
    command: input.bridge?.nodeCommand ?? "node",
    args: [
      input.bridge?.bridgePath ?? "",
      "--pi",
      input.launch.binaryPath,
      "--agent-dir",
      input.agentDir,
      ...(piNeedsApprovalGate(input.runtimeMode) ? ["--approval-gate"] : []),
      ...input.launch.extraArgs.flatMap((arg) => ["--pi-arg", arg]),
    ],
    cwd: input.cwd,
    env,
    extendEnv: false,
  };
}

export const makeLocalStudioAcpRuntime = (
  input: Omit<AcpSessionRuntime.AcpSessionRuntimeOptions, "authMethodId"> & {
    readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  },
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { childProcessSpawner, ...options } = input;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({ ...options, authMethodId: "agent" }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

export function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const preferredKinds =
    decision === "acceptForSession"
      ? ["allow_always", "allow_once"]
      : decision === "accept"
        ? ["allow_once", "allow_always"]
        : ["reject_once", "reject_always"];
  for (const kind of preferredKinds) {
    const option = request.options.find((entry) => entry.kind === kind);
    const optionId = option?.optionId.trim();
    if (optionId) return optionId;
  }
  return undefined;
}

export const applyHarnessSelection = (input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly model: string | undefined;
  readonly thinkingLevel: string;
}): Effect.Effect<void, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const options = yield* input.runtime.getConfigOptions;
    const modelOption = options.find(
      (option) => option.id === "model" || option.category === "model",
    );
    if (input.model && modelOption) {
      const wanted = harnessModelId(input.model);
      const current = "currentValue" in modelOption ? modelOption.currentValue : undefined;
      if (current !== wanted) {
        yield* input.runtime.setConfigOption(modelOption.id, wanted);
      }
    }
    if (input.thinkingLevel && input.thinkingLevel !== "default") {
      const thinking = options.find(
        (option) => option.id === "thinking" || option.category === "thought_level",
      );
      const values =
        thinking && "options" in thinking && Array.isArray(thinking.options)
          ? thinking.options.flatMap((entry) =>
              typeof entry === "object" && entry !== null && "value" in entry
                ? [String(entry.value)]
                : [],
            )
          : [];
      if (thinking && values.includes(input.thinkingLevel)) {
        yield* input.runtime.setConfigOption(thinking.id, input.thinkingLevel);
      }
    }
  });
