export const APPROVAL_REQUEST_TITLE = "pi-acp:tool-permission";

export interface ApprovalRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

interface GateToolCallEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

interface GateContext {
  readonly hasUI: boolean;
  readonly ui: { confirm(title: string, message: string): Promise<boolean> };
}

type GateResult = { readonly block: true; readonly reason: string } | undefined;

interface GateApi {
  on(
    event: "tool_call",
    handler: (event: GateToolCallEvent, ctx: GateContext) => Promise<GateResult>,
  ): unknown;
}

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

export const parseApprovalRequest = (message: unknown): ApprovalRequest | null => {
  if (typeof message !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.toolCallId !== "string" || typeof record.toolName !== "string") return null;
  return { toolCallId: record.toolCallId, toolName: record.toolName, input: record.input };
};

export default function approvalGate(pi: GateApi): void {
  pi.on("tool_call", async (event, ctx) => {
    if (READ_ONLY_TOOLS.has(event.toolName)) return undefined;
    if (!ctx.hasUI)
      return { block: true, reason: "No client is attached to approve this tool call." };
    const request: ApprovalRequest = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    };
    const allowed = await ctx.ui.confirm(APPROVAL_REQUEST_TITLE, JSON.stringify(request));
    return allowed ? undefined : { block: true, reason: "The user declined this tool call." };
  });
}
