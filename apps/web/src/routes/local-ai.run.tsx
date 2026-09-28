import { createFileRoute } from "@tanstack/react-router";

import { RunView } from "../localStudio/views/run/RunView";

function LocalAiRunRoute() {
  const search = Route.useSearch();
  return <RunView machine={search.machine ?? null} gpus={search.gpus ?? null} />;
}

export const Route = createFileRoute("/local-ai/run")({
  validateSearch: (raw: Record<string, unknown>): { machine?: string; gpus?: string } => ({
    ...(typeof raw.machine === "string" && raw.machine.trim() ? { machine: raw.machine } : {}),
    ...(typeof raw.gpus === "string" && raw.gpus.trim() ? { gpus: raw.gpus } : {}),
  }),
  component: LocalAiRunRoute,
});
