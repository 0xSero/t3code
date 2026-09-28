import { createFileRoute } from "@tanstack/react-router";

import { LocalAiPlaceholder } from "../localStudio/LocalAiPlaceholder";

export const Route = createFileRoute("/local-ai/")({
  component: LocalAiPlaceholder,
});
