import { createFileRoute } from "@tanstack/react-router";

import { AgentsView } from "../localStudio/views/agents/AgentsView";

export const Route = createFileRoute("/local-ai/agents")({
  component: AgentsView,
});
