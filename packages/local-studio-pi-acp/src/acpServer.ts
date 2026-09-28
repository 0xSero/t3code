import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";
import { APPROVAL_REQUEST_TITLE, parseApprovalRequest } from "./approvalGate.ts";
import { readJsonl, writeJsonl } from "./jsonl.ts";
import {
  EventMapper,
  replayMessages,
  toolKind,
  toolTitle,
  type AcpSessionUpdate,
  type PiUsage,
} from "./mapEvents.ts";
import { PiRpc, type PiRecord } from "./piRpc.ts";

export interface BridgeConfig {
  readonly piCommand: string;
  readonly agentDir: string;
  readonly provider: string;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly extensionPath: string | null;
  readonly piArgs: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly version: string;
}

const PROTOCOL_VERSION = 1;
const STARTUP_TIMEOUT_MS = 60_000;
const DIALOG_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);
const ALLOW_OPTION_ID = "allow_once";
const REJECT_OPTION_ID = "reject_once";

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const invalidParams = (message: string): RpcError => new RpcError(-32602, message);
const internalError = (message: string): RpcError => new RpcError(-32603, message);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

type RequestId = string | number;

interface OutgoingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface ConnectionHandler {
  readonly onRequest: (method: string, params: unknown) => Promise<unknown>;
  readonly onNotification: (method: string, params: unknown) => void;
  readonly onClose: () => void;
}

export class AcpConnection {
  private readonly output: NodeStream.Writable;
  private readonly outgoing = new Map<RequestId, OutgoingRequest>();
  private sequence = 0;
  private closed = false;

  constructor(input: NodeStream.Readable, output: NodeStream.Writable, handler: ConnectionHandler) {
    this.output = output;
    readJsonl(input, {
      onRecord: (value) => this.dispatch(value, handler),
      onInvalid: () => {
        writeJsonl(this.output, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
      },
      onEnd: () => {
        this.closed = true;
        const error = new Error("ACP client disconnected");
        for (const entry of this.outgoing.values()) entry.reject(error);
        this.outgoing.clear();
        handler.onClose();
      },
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) writeJsonl(this.output, { jsonrpc: "2.0", method, params });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("ACP client disconnected"));
    this.sequence += 1;
    const id = `pi-acp-${this.sequence}`;
    return new Promise<unknown>((resolve, reject) => {
      this.outgoing.set(id, { resolve, reject });
      writeJsonl(this.output, { jsonrpc: "2.0", id, method, params });
    });
  }

  private dispatch(value: unknown, handler: ConnectionHandler): void {
    const message = asRecord(value);
    if (!message) return;
    const id = message.id;
    const hasId = typeof id === "string" || typeof id === "number";
    if (typeof message.method === "string") {
      const method = message.method;
      if (!hasId) {
        handler.onNotification(method, message.params);
        return;
      }
      handler.onRequest(method, message.params).then(
        (result) => writeJsonl(this.output, { jsonrpc: "2.0", id, result: result ?? null }),
        (error: unknown) => {
          const code = error instanceof RpcError ? error.code : -32603;
          writeJsonl(this.output, {
            jsonrpc: "2.0",
            id,
            error: { code, message: errorMessage(error) },
          });
        },
      );
      return;
    }
    if (!hasId) return;
    const entry = this.outgoing.get(id);
    if (!entry) return;
    this.outgoing.delete(id);
    const failure = asRecord(message.error);
    if (failure) {
      entry.reject(new Error(asString(failure.message) ?? "ACP client returned an error"));
    } else {
      entry.resolve(message.result);
    }
  }
}

interface PiModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number | null;
}

interface PromptResult {
  readonly stopReason: "end_turn" | "max_tokens" | "refusal" | "cancelled";
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedReadTokens: number;
    readonly cachedWriteTokens: number;
    readonly thoughtTokens: number;
    readonly totalTokens: number;
  };
}

interface PromptWaiter {
  readonly resolve: (result: PromptResult) => void;
  readonly reject: (error: Error) => void;
}

const readModel = (value: unknown): PiModel | null => {
  const model = asRecord(value);
  if (!model) return null;
  const provider = asString(model.provider);
  const id = asString(model.id);
  if (!provider || !id) return null;
  return {
    provider,
    id,
    name: asString(model.name) ?? id,
    contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : null,
  };
};

const modelKey = (model: PiModel): string => `${model.provider}/${model.id}`;

const thinkingLabel = (level: string): string =>
  level.length === 0 ? level : `${level[0]?.toUpperCase() ?? ""}${level.slice(1)}`;

const promptUsage = (usage: PiUsage): PromptResult["usage"] => ({
  inputTokens: usage.input,
  outputTokens: usage.output,
  cachedReadTokens: usage.cacheRead,
  cachedWriteTokens: usage.cacheWrite,
  thoughtTokens: usage.reasoning,
  totalTokens: usage.totalTokens,
});

const toPiPrompt = (
  prompt: unknown,
): {
  readonly message: string;
  readonly images: ReadonlyArray<{ type: "image"; data: string; mimeType: string }>;
} => {
  if (!Array.isArray(prompt)) throw invalidParams("prompt must be an array of content blocks");
  const parts: string[] = [];
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const item of prompt) {
    const block = asRecord(item);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      images.push({ type: "image", data: block.data, mimeType: block.mimeType });
    } else if (block.type === "resource_link" && typeof block.uri === "string") {
      parts.push(`[${asString(block.name) ?? block.uri}](${block.uri})`);
    } else if (block.type === "resource") {
      const resource = asRecord(block.resource);
      const uri = resource ? asString(resource.uri) : null;
      const text = resource ? asString(resource.text) : null;
      if (text !== null) parts.push(`<context uri="${uri ?? ""}">\n${text}\n</context>`);
    }
  }
  return { message: parts.join("\n\n"), images };
};

class PiSession {
  readonly id: string;
  readonly cwd: string;
  readonly pi: PiRpc;
  private readonly config: BridgeConfig;
  private readonly connection: AcpConnection;
  private readonly mapper: EventMapper;
  private readonly waiters: PromptWaiter[] = [];
  private models: PiModel[] = [];
  private levels: string[] = [];
  private currentModel: PiModel | null = null;
  private thinkingLevel: string | null = null;
  private running = false;
  private runSeen = false;
  private cancelled = false;
  private closed = false;

  constructor(
    config: BridgeConfig,
    connection: AcpConnection,
    id: string,
    cwd: string,
    onExit: () => void,
  ) {
    this.id = id;
    this.cwd = cwd;
    this.config = config;
    this.connection = connection;
    this.mapper = new EventMapper(cwd, () => this.currentModel?.contextWindow ?? null);
    const modelArg =
      config.model === null
        ? []
        : [
            "--model",
            config.model.startsWith(`${config.provider}/`)
              ? config.model
              : `${config.provider}/${config.model}`,
          ];
    const args = [
      "--mode",
      "rpc",
      "--provider",
      config.provider,
      ...modelArg,
      ...(config.thinking === null ? [] : ["--thinking", config.thinking]),
      "--session-dir",
      NodePath.join(config.agentDir, "sessions"),
      "--session-id",
      id,
      "--no-themes",
      "--no-approve",
      "--offline",
      ...(config.extensionPath === null ? [] : ["--extension", config.extensionPath]),
      ...config.piArgs,
    ];
    this.pi = new PiRpc(
      {
        piCommand: config.piCommand,
        args,
        cwd,
        env: { ...config.env, PI_CODING_AGENT_DIR: config.agentDir },
      },
      (record) => this.handleRecord(record),
    );
    void this.pi.exited.then((info) => {
      this.closed = true;
      this.running = false;
      const error = internalError(
        `pi exited (code ${String(info.code)}, signal ${String(info.signal)})`,
      );
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
      onExit();
    });
  }

  async start(replay: boolean): Promise<void> {
    await withTimeout(this.refresh(), STARTUP_TIMEOUT_MS, "pi startup");
    if (!replay) return;
    const data = asRecord(await this.pi.request({ type: "get_messages" }));
    for (const update of replayMessages(this.cwd, data?.messages)) this.notify(update);
  }

  configOptions(): ReadonlyArray<Record<string, unknown>> {
    const models = [...this.models];
    if (this.currentModel && !models.some((m) => modelKey(m) === modelKey(this.currentModel!))) {
      models.unshift(this.currentModel);
    }
    const levels = this.levels.length > 0 ? this.levels : ["off"];
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: this.currentModel ? modelKey(this.currentModel) : "",
        options: models.map((model) => ({
          value: modelKey(model),
          name: model.name,
          description: model.provider,
        })),
      },
      {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: this.thinkingLevel ?? levels[0] ?? "off",
        options: levels.map((level) => ({ value: level, name: thinkingLabel(level) })),
      },
    ];
  }

  async setConfigOption(configId: string, value: unknown): Promise<void> {
    this.assertOpen();
    if (typeof value !== "string") throw invalidParams("value must be a string");
    if (configId === "model") {
      const target =
        this.models.find((model) => modelKey(model) === value) ??
        this.models.find(
          (model) => model.id === value && model.provider === this.config.provider,
        ) ??
        this.models.find((model) => model.id === value) ??
        null;
      const provider = target?.provider ?? this.config.provider;
      const modelId =
        target?.id ??
        (value.startsWith(`${this.config.provider}/`)
          ? value.slice(this.config.provider.length + 1)
          : value);
      await this.pi.request({ type: "set_model", provider, modelId }).catch((error: unknown) => {
        throw invalidParams(errorMessage(error));
      });
      await this.refresh();
      return;
    }
    if (configId === "thinking") {
      await this.pi
        .request({ type: "set_thinking_level", level: value })
        .catch((error: unknown) => {
          throw invalidParams(errorMessage(error));
        });
      await this.refresh();
      return;
    }
    throw invalidParams(`unknown config option ${configId}`);
  }

  async prompt(blocks: unknown): Promise<PromptResult> {
    this.assertOpen();
    const { message, images } = toPiPrompt(blocks);
    const busy = this.running || this.waiters.length > 0;
    if (!busy) {
      this.mapper.beginRun();
      this.runSeen = false;
      this.cancelled = false;
    }
    let waiter: PromptWaiter | undefined;
    const result = new Promise<PromptResult>((resolve, reject) => {
      waiter = { resolve, reject };
      this.waiters.push(waiter);
    });
    try {
      await this.pi.request({
        type: "prompt",
        message,
        ...(images.length > 0 ? { images } : {}),
        ...(busy ? { streamingBehavior: "steer" } : {}),
      });
    } catch (error) {
      const index = waiter === undefined ? -1 : this.waiters.indexOf(waiter);
      if (index !== -1) this.waiters.splice(index, 1);
      throw internalError(errorMessage(error));
    }
    if (!busy && !this.runSeen) {
      const state = asRecord(await this.pi.request({ type: "get_state" }).catch(() => null));
      const idle =
        state !== null &&
        state.isStreaming !== true &&
        state.isCompacting !== true &&
        (typeof state.pendingMessageCount !== "number" || state.pendingMessageCount === 0);
      if (idle && !this.runSeen) this.settle();
    }
    return result;
  }

  cancel(): void {
    if (this.closed || (!this.running && this.waiters.length === 0)) return;
    this.cancelled = true;
    void this.pi
      .request({ type: "clear_queue" })
      .catch(() => null)
      .then(() => this.pi.request({ type: "abort" }))
      .catch(() => null);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.pi.close();
  }

  private assertOpen(): void {
    if (this.closed || !this.pi.alive) throw internalError("pi is not running for this session");
  }

  private async refresh(): Promise<void> {
    const [state, available, levels] = await Promise.all([
      this.pi.request({ type: "get_state" }),
      this.pi.request({ type: "get_available_models" }),
      this.pi.request({ type: "get_available_thinking_levels" }),
    ]);
    const stateRecord = asRecord(state);
    this.currentModel = readModel(stateRecord?.model);
    this.thinkingLevel = asString(stateRecord?.thinkingLevel);
    const modelList = asRecord(available)?.models;
    this.models = Array.isArray(modelList)
      ? modelList.map(readModel).filter((model): model is PiModel => model !== null)
      : [];
    const levelList = asRecord(levels)?.levels;
    this.levels = Array.isArray(levelList)
      ? levelList.filter((level): level is string => typeof level === "string")
      : [];
  }

  private notify(update: AcpSessionUpdate | Record<string, unknown>): void {
    this.connection.notify("session/update", { sessionId: this.id, update });
  }

  private settle(): void {
    this.running = false;
    const waiters = this.waiters.splice(0);
    const cancelled = this.cancelled;
    this.cancelled = false;
    const outcome = this.mapper.lastOutcome;
    const usage = promptUsage(this.mapper.usage);
    if (!cancelled && outcome?.stopReason === "error") {
      const error = internalError(outcome.errorMessage ?? "pi reported a model error");
      for (const waiter of waiters) waiter.reject(error);
      return;
    }
    const stopReason: PromptResult["stopReason"] =
      cancelled || outcome?.stopReason === "aborted"
        ? "cancelled"
        : outcome?.stopReason === "length"
          ? "max_tokens"
          : "end_turn";
    for (const waiter of waiters) waiter.resolve({ stopReason, usage });
  }

  private handleRecord(record: PiRecord): void {
    switch (record.type) {
      case "agent_start":
        this.running = true;
        this.runSeen = true;
        return;
      case "agent_settled":
        this.settle();
        return;
      case "extension_ui_request":
        void this.handleUiRequest(record);
        return;
      case "thinking_level_changed": {
        const level = asString(record.level);
        if (level !== null && level !== this.thinkingLevel) {
          this.thinkingLevel = level;
          this.notify({
            sessionUpdate: "config_option_update",
            configOptions: this.configOptions(),
          });
        }
        return;
      }
      default:
        for (const update of this.mapper.map(record)) this.notify(update);
    }
  }

  private async handleUiRequest(record: PiRecord): Promise<void> {
    const id = asString(record.id);
    const method = asString(record.method);
    if (id === null || method === null || !DIALOG_METHODS.has(method)) return;
    const request =
      method === "confirm" && record.title === APPROVAL_REQUEST_TITLE
        ? parseApprovalRequest(record.message)
        : null;
    if (request === null) {
      this.pi.send({ type: "extension_ui_response", id, cancelled: true });
      return;
    }
    let confirmed = false;
    try {
      const response = asRecord(
        await this.connection.request("session/request_permission", {
          sessionId: this.id,
          toolCall: {
            toolCallId: request.toolCallId,
            title: toolTitle(request.toolName, request.input),
            kind: toolKind(request.toolName),
            status: "pending",
            rawInput: request.input,
          },
          options: [
            { optionId: ALLOW_OPTION_ID, name: "Allow", kind: "allow_once" },
            { optionId: REJECT_OPTION_ID, name: "Reject", kind: "reject_once" },
          ],
        }),
      );
      const outcome = asRecord(response?.outcome);
      confirmed = outcome?.outcome === "selected" && outcome.optionId === ALLOW_OPTION_ID;
    } catch (error) {
      process.stderr.write(`pi-acp: permission request failed: ${errorMessage(error)}\n`);
    }
    this.pi.send({ type: "extension_ui_response", id, confirmed: confirmed && !this.cancelled });
  }
}

export class PiAcpAgent {
  private readonly config: BridgeConfig;
  private readonly sessions = new Map<string, PiSession>();
  private readonly connection: AcpConnection;
  private shuttingDown: Promise<void> | null = null;

  constructor(
    config: BridgeConfig,
    input: NodeStream.Readable,
    output: NodeStream.Writable,
    onClosed: () => void,
  ) {
    this.config = config;
    this.connection = new AcpConnection(input, output, {
      onRequest: (method, params) => this.handleRequest(method, params),
      onNotification: (method, params) => this.handleNotification(method, params),
      onClose: () => {
        void this.shutdown().then(onClosed);
      },
    });
  }

  shutdown(): Promise<void> {
    if (this.shuttingDown === null) {
      const sessions = [...this.sessions.values()];
      this.sessions.clear();
      this.shuttingDown = Promise.all(sessions.map((session) => session.close())).then(
        () => undefined,
      );
    }
    return this.shuttingDown;
  }

  killAll(): void {
    for (const session of this.sessions.values()) session.pi.killNow();
  }

  private session(params: unknown): PiSession {
    const sessionId = asString(asRecord(params)?.sessionId);
    const session = sessionId === null ? undefined : this.sessions.get(sessionId);
    if (!session) throw invalidParams(`unknown session ${String(sessionId)}`);
    return session;
  }

  private async openSession(
    sessionId: string,
    params: unknown,
    replay: boolean,
  ): Promise<PiSession> {
    if (this.shuttingDown !== null) throw internalError("pi-acp is shutting down");
    const cwd = asString(asRecord(params)?.cwd);
    if (cwd === null || !NodePath.isAbsolute(cwd))
      throw invalidParams("cwd must be an absolute path");
    const existing = this.sessions.get(sessionId);
    if (existing) {
      await existing.close();
      this.sessions.delete(sessionId);
    }
    const session: PiSession = new PiSession(this.config, this.connection, sessionId, cwd, () => {
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    });
    this.sessions.set(sessionId, session);
    try {
      await session.start(replay);
    } catch (error) {
      this.sessions.delete(sessionId);
      session.pi.killNow();
      throw internalError(`pi failed to start: ${errorMessage(error)}`);
    }
    return session;
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            mcpCapabilities: { http: false, sse: false },
            sessionCapabilities: { resume: {}, close: {} },
          },
          agentInfo: { name: "pi-acp", title: "pi", version: this.config.version },
          authMethods: [],
        };
      case "authenticate":
        return {};
      case "session/new": {
        const session = await this.openSession(NodeCrypto.randomUUID(), params, false);
        return { sessionId: session.id, configOptions: session.configOptions() };
      }
      case "session/load":
      case "session/resume": {
        const sessionId = asString(asRecord(params)?.sessionId);
        if (sessionId === null || sessionId.length === 0)
          throw invalidParams("sessionId is required");
        const session = await this.openSession(sessionId, params, method === "session/load");
        return { configOptions: session.configOptions() };
      }
      case "session/set_config_option": {
        const session = this.session(params);
        const record = asRecord(params);
        const configId = asString(record?.configId);
        if (configId === null) throw invalidParams("configId is required");
        await session.setConfigOption(configId, record?.value);
        return { configOptions: session.configOptions() };
      }
      case "session/prompt":
        return this.session(params).prompt(asRecord(params)?.prompt);
      case "session/cancel":
        this.session(params).cancel();
        return {};
      case "session/close": {
        const session = this.session(params);
        this.sessions.delete(session.id);
        await session.close();
        return {};
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "session/cancel") return;
    const sessionId = asString(asRecord(params)?.sessionId);
    const session = sessionId === null ? undefined : this.sessions.get(sessionId);
    session?.cancel();
  }
}
