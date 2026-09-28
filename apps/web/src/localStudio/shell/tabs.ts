import { LOCAL_AI_ROUTE_PATH } from "@local-studio/t3-providers";

export interface LocalAiTab {
  readonly id: "machines" | "run" | "models" | "endpoints" | "usage" | "agents";
  readonly label: string;
  readonly path: string;
}

export const LOCAL_AI_TABS: ReadonlyArray<LocalAiTab> = [
  { id: "machines", label: "Machines", path: `${LOCAL_AI_ROUTE_PATH}/machines` },
  { id: "run", label: "Run", path: `${LOCAL_AI_ROUTE_PATH}/run` },
  { id: "models", label: "Models", path: `${LOCAL_AI_ROUTE_PATH}/models` },
  { id: "endpoints", label: "Endpoints", path: `${LOCAL_AI_ROUTE_PATH}/endpoints` },
  { id: "usage", label: "Usage", path: `${LOCAL_AI_ROUTE_PATH}/usage` },
  { id: "agents", label: "Agents", path: `${LOCAL_AI_ROUTE_PATH}/agents` },
];

export const activeTabOf = (pathname: string): LocalAiTab | null =>
  LOCAL_AI_TABS.find((tab) => pathname === tab.path || pathname.startsWith(`${tab.path}/`)) ?? null;
