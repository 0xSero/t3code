import { createFileRoute } from "@tanstack/react-router";

import { UsageView } from "../localStudio/views/usage/UsageView";

export const Route = createFileRoute("/local-ai/usage")({
  component: UsageView,
});
