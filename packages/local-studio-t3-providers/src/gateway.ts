export const DEFAULT_LOCAL_STUDIO_CONTROLLER_URL = "http://127.0.0.1:8080";
export const LOCAL_STUDIO_GATEWAY_URL_ENV = "LOCAL_STUDIO_GATEWAY_URL";

export const LOCAL_STUDIO_GATEWAY_CLIENTS = [
  "pi",
  "omp",
  "codex-cli",
  "claude-code",
  "cursor",
  "opencode",
  "grok",
  "antigravity",
] as const;

export type LocalStudioGatewayClient = (typeof LOCAL_STUDIO_GATEWAY_CLIENTS)[number];

export type GatewayModelState = "ready" | "loading" | "starting" | "stopped" | (string & {});

export interface GatewayModel {
  readonly id: string;
  readonly ownedBy: string;
  readonly contextWindow: number | null;
  readonly machineId: string | null;
  readonly engine: string | null;
  readonly state: GatewayModelState;
  readonly vision: boolean | null;
  readonly via: string | null;
}
