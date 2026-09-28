import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import type { PiRecord } from "./piRpc.ts";

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type AcpContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export type AcpToolContent =
  | { readonly type: "content"; readonly content: AcpContentBlock }
  | {
      readonly type: "diff";
      readonly path: string;
      readonly oldText: string | null;
      readonly newText: string;
    };

export interface AcpToolCallFields {
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: ToolKind;
  readonly status?: ToolStatus;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly content?: ReadonlyArray<AcpToolContent>;
  readonly locations?: ReadonlyArray<{ readonly path: string; readonly line?: number }>;
}

export type AcpSessionUpdate =
  | {
      readonly sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
      readonly content: AcpContentBlock;
      readonly messageId?: string;
    }
  | ({ readonly sessionUpdate: "tool_call" } & AcpToolCallFields)
  | ({ readonly sessionUpdate: "tool_call_update" } & AcpToolCallFields)
  | { readonly sessionUpdate: "session_info_update"; readonly title: string | null }
  | {
      readonly sessionUpdate: "usage_update";
      readonly used: number;
      readonly size: number;
      readonly cost?: { readonly amount: number; readonly currency: string };
    };

export interface PiUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
  readonly totalTokens: number;
  readonly cost: number;
}

export interface AssistantOutcome {
  readonly stopReason: string;
  readonly errorMessage: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  read: "read",
  ls: "read",
  grep: "search",
  find: "search",
  edit: "edit",
  write: "edit",
  bash: "execute",
  powershell: "execute",
  fetch: "fetch",
  web_fetch: "fetch",
  webfetch: "fetch",
  web_search: "fetch",
};

export const toolKind = (toolName: string): ToolKind =>
  TOOL_KINDS[toolName.toLowerCase()] ?? "other";

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export const toolTitle = (toolName: string, input: unknown): string => {
  const args = asRecord(input) ?? {};
  const path = asString(args.path) ?? asString(args.file_path);
  const pattern = asString(args.pattern) ?? asString(args.query);
  switch (toolName) {
    case "bash":
    case "powershell": {
      const command = asString(args.command);
      return command ? truncate(command.split("\n", 1)[0] ?? command, 120) : toolName;
    }
    case "read":
      return path ? `Read ${path}` : "Read";
    case "ls":
      return path ? `List ${path}` : "List";
    case "edit":
      return path ? `Edit ${path}` : "Edit";
    case "write":
      return path ? `Write ${path}` : "Write";
    case "grep":
      return pattern ? `Search ${truncate(pattern, 80)}` : "Search";
    case "find":
      return pattern ? `Find ${truncate(pattern, 80)}` : "Find";
    default:
      return toolName;
  }
};

const toolLocations = (
  cwd: string,
  input: unknown,
): ReadonlyArray<{ readonly path: string }> | undefined => {
  const args = asRecord(input);
  const path = args ? (asString(args.path) ?? asString(args.file_path)) : null;
  if (!path) return undefined;
  return [{ path: NodePath.isAbsolute(path) ? path : NodePath.resolve(cwd, path) }];
};

const toolDiffs = (cwd: string, toolName: string, input: unknown): AcpToolContent[] => {
  const args = asRecord(input);
  const rawPath = args ? asString(args.path) : null;
  if (!args || !rawPath) return [];
  const path = NodePath.isAbsolute(rawPath) ? rawPath : NodePath.resolve(cwd, rawPath);
  if (toolName === "write") {
    const content = asString(args.content);
    return content === null ? [] : [{ type: "diff", path, oldText: null, newText: content }];
  }
  if (toolName === "edit") {
    const edits = Array.isArray(args.edits) ? args.edits : [args];
    const diffs: AcpToolContent[] = [];
    for (const edit of edits) {
      const entry = asRecord(edit);
      const oldText = entry ? asString(entry.oldText) : null;
      const newText = entry ? asString(entry.newText) : null;
      if (oldText !== null && newText !== null)
        diffs.push({ type: "diff", path, oldText, newText });
    }
    return diffs;
  }
  return [];
};

export const contentBlocks = (value: unknown): AcpContentBlock[] => {
  if (typeof value === "string") return value.length > 0 ? [{ type: "text", text: value }] : [];
  if (!Array.isArray(value)) return [];
  const blocks: AcpContentBlock[] = [];
  for (const item of value) {
    const block = asRecord(item);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    } else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  return blocks;
};

const toolResultContent = (result: unknown): AcpToolContent[] => {
  const record = asRecord(result);
  const blocks = contentBlocks(record ? record.content : result);
  return blocks.map((content) => ({ type: "content", content }));
};

export const readUsage = (value: unknown): PiUsage | null => {
  const usage = asRecord(value);
  if (!usage) return null;
  const cost = asRecord(usage.cost);
  return {
    input: asNumber(usage.input),
    output: asNumber(usage.output),
    cacheRead: asNumber(usage.cacheRead),
    cacheWrite: asNumber(usage.cacheWrite),
    reasoning: asNumber(usage.reasoning),
    totalTokens: asNumber(usage.totalTokens),
    cost: cost ? asNumber(cost.total) : 0,
  };
};

const contextTokens = (usage: PiUsage): number =>
  usage.totalTokens > 0
    ? usage.totalTokens
    : usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

interface ToolState {
  readonly toolName: string;
  input: unknown;
  announced: boolean;
}

export class EventMapper {
  private readonly cwd: string;
  private readonly contextWindow: () => number | null;
  private readonly tools = new Map<string, ToolState>();
  private readonly toolByIndex = new Map<number, string>();
  private readonly streamed = new Map<number, string>();
  private messageId: string | null = null;
  private sessionCost = 0;
  private runUsage: PiUsage = EventMapper.emptyUsage();
  private outcome: AssistantOutcome | null = null;

  constructor(cwd: string, contextWindow: () => number | null) {
    this.cwd = cwd;
    this.contextWindow = contextWindow;
  }

  static emptyUsage(): PiUsage {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 0,
      cost: 0,
    };
  }

  beginRun(): void {
    this.runUsage = EventMapper.emptyUsage();
    this.outcome = null;
  }

  get lastOutcome(): AssistantOutcome | null {
    return this.outcome;
  }

  get usage(): PiUsage {
    return this.runUsage;
  }

  map(event: PiRecord): AcpSessionUpdate[] {
    switch (event.type) {
      case "message_start":
        return this.onMessageStart(event);
      case "message_update":
        return this.onMessageUpdate(event);
      case "message_end":
        return this.onMessageEnd(event);
      case "tool_execution_start":
        return this.onToolStart(event);
      case "tool_execution_update":
        return this.onToolUpdate(event);
      case "tool_execution_end":
        return this.onToolEnd(event);
      case "session_info_changed":
        return [{ sessionUpdate: "session_info_update", title: asString(event.name) }];
      default:
        return [];
    }
  }

  private onMessageStart(event: PiRecord): AcpSessionUpdate[] {
    const message = asRecord(event.message);
    if (!message || message.role !== "assistant") return [];
    this.messageId = NodeCrypto.randomUUID();
    this.toolByIndex.clear();
    this.streamed.clear();
    return [];
  }

  private chunk(
    kind: "agent_message_chunk" | "agent_thought_chunk",
    text: string,
  ): AcpSessionUpdate[] {
    if (text.length === 0) return [];
    return [
      {
        sessionUpdate: kind,
        content: { type: "text", text },
        ...(this.messageId ? { messageId: this.messageId } : {}),
      },
    ];
  }

  private appendStreamed(index: number, delta: string): void {
    this.streamed.set(index, (this.streamed.get(index) ?? "") + delta);
  }

  private remainder(index: number, full: string | null): string {
    if (full === null) return "";
    const sent = this.streamed.get(index) ?? "";
    this.streamed.set(index, full);
    return full.startsWith(sent) ? full.slice(sent.length) : "";
  }

  private onMessageUpdate(event: PiRecord): AcpSessionUpdate[] {
    const update = asRecord(event.assistantMessageEvent);
    if (!update) return [];
    const index = asNumber(update.contentIndex);
    switch (update.type) {
      case "text_delta": {
        const delta = asString(update.delta) ?? "";
        this.appendStreamed(index, delta);
        return this.chunk("agent_message_chunk", delta);
      }
      case "thinking_delta": {
        const delta = asString(update.delta) ?? "";
        this.appendStreamed(index, delta);
        return this.chunk("agent_thought_chunk", delta);
      }
      case "text_end":
        return this.chunk("agent_message_chunk", this.remainder(index, asString(update.content)));
      case "thinking_end":
        return this.chunk("agent_thought_chunk", this.remainder(index, asString(update.content)));
      case "toolcall_start": {
        const id = asString(update.id);
        const toolName = asString(update.toolName) ?? "tool";
        if (!id) return [];
        this.toolByIndex.set(index, id);
        return this.announceTool(id, toolName, {}, "pending");
      }
      case "toolcall_end": {
        const call = asRecord(update.toolCall);
        const id = (call ? asString(call.id) : null) ?? this.toolByIndex.get(index) ?? null;
        const toolName = (call ? asString(call.name) : null) ?? "tool";
        if (!id) return [];
        const input = call ? call.arguments : undefined;
        const known = this.tools.get(id);
        if (!known) return this.announceTool(id, toolName, input, "pending");
        known.input = input;
        const locations = toolLocations(this.cwd, input);
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            title: toolTitle(known.toolName, input),
            rawInput: input,
            ...(locations ? { locations } : {}),
          },
        ];
      }
      default:
        return [];
    }
  }

  private announceTool(
    id: string,
    toolName: string,
    input: unknown,
    status: ToolStatus,
  ): AcpSessionUpdate[] {
    const known = this.tools.get(id);
    if (known?.announced) return [];
    this.tools.set(id, { toolName, input, announced: true });
    const locations = toolLocations(this.cwd, input);
    return [
      {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: toolTitle(toolName, input),
        kind: toolKind(toolName),
        status,
        rawInput: input,
        ...(locations ? { locations } : {}),
      },
    ];
  }

  private onMessageEnd(event: PiRecord): AcpSessionUpdate[] {
    const message = asRecord(event.message);
    if (!message || message.role !== "assistant") return [];
    this.messageId = null;
    this.outcome = {
      stopReason: asString(message.stopReason) ?? "stop",
      errorMessage: asString(message.errorMessage),
    };
    const usage = readUsage(message.usage);
    if (!usage) return [];
    this.runUsage = {
      input: this.runUsage.input + usage.input,
      output: this.runUsage.output + usage.output,
      cacheRead: this.runUsage.cacheRead + usage.cacheRead,
      cacheWrite: this.runUsage.cacheWrite + usage.cacheWrite,
      reasoning: this.runUsage.reasoning + usage.reasoning,
      totalTokens: this.runUsage.totalTokens + usage.totalTokens,
      cost: this.runUsage.cost + usage.cost,
    };
    this.sessionCost += usage.cost;
    const size = this.contextWindow();
    const used = contextTokens(usage);
    if (size === null || used === 0) return [];
    return [
      {
        sessionUpdate: "usage_update",
        used,
        size,
        cost: { amount: this.sessionCost, currency: "USD" },
      },
    ];
  }

  private onToolStart(event: PiRecord): AcpSessionUpdate[] {
    const id = asString(event.toolCallId);
    if (!id) return [];
    const toolName = asString(event.toolName) ?? this.tools.get(id)?.toolName ?? "tool";
    const input = event.args ?? this.tools.get(id)?.input;
    const known = this.tools.get(id);
    if (!known?.announced) return this.announceTool(id, toolName, input, "in_progress");
    known.input = input;
    return [{ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" }];
  }

  private onToolUpdate(event: PiRecord): AcpSessionUpdate[] {
    const id = asString(event.toolCallId);
    if (!id) return [];
    const content = toolResultContent(event.partialResult);
    if (content.length === 0) return [];
    return [{ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", content }];
  }

  private onToolEnd(event: PiRecord): AcpSessionUpdate[] {
    const id = asString(event.toolCallId);
    if (!id) return [];
    const known = this.tools.get(id);
    const toolName = asString(event.toolName) ?? known?.toolName ?? "tool";
    const failed = event.isError === true;
    const diffs = failed ? [] : toolDiffs(this.cwd, toolName, known?.input);
    const content = [...diffs, ...toolResultContent(event.result)];
    this.tools.delete(id);
    return [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: failed ? "failed" : "completed",
        rawOutput: event.result,
        content,
      },
    ];
  }
}

export const replayMessages = (cwd: string, messages: unknown): AcpSessionUpdate[] => {
  if (!Array.isArray(messages)) return [];
  const updates: AcpSessionUpdate[] = [];
  const toolNames = new Map<string, { readonly toolName: string; readonly input: unknown }>();
  for (const item of messages) {
    const message = asRecord(item);
    if (!message) continue;
    const messageId = NodeCrypto.randomUUID();
    if (message.role === "user") {
      for (const content of contentBlocks(message.content)) {
        updates.push({ sessionUpdate: "user_message_chunk", content, messageId });
      }
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        const block = asRecord(part);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          updates.push({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: block.text },
            messageId,
          });
        } else if (
          block.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking.length > 0
        ) {
          updates.push({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: block.thinking },
            messageId,
          });
        } else if (block.type === "toolCall" && typeof block.id === "string") {
          const toolName = asString(block.name) ?? "tool";
          toolNames.set(block.id, { toolName, input: block.arguments });
          const locations = toolLocations(cwd, block.arguments);
          updates.push({
            sessionUpdate: "tool_call",
            toolCallId: block.id,
            title: toolTitle(toolName, block.arguments),
            kind: toolKind(toolName),
            status: "pending",
            rawInput: block.arguments,
            ...(locations ? { locations } : {}),
          });
        }
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const failed = message.isError === true;
      const call = toolNames.get(message.toolCallId);
      const diffs = failed || !call ? [] : toolDiffs(cwd, call.toolName, call.input);
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: message.toolCallId,
        status: failed ? "failed" : "completed",
        content: [
          ...diffs,
          ...contentBlocks(message.content).map((content): AcpToolContent => ({
            type: "content",
            content,
          })),
        ],
      });
    }
  }
  return updates;
};
