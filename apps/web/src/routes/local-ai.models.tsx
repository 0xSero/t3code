import { createFileRoute } from "@tanstack/react-router";

import { ModelsView } from "../localStudio/views/models/ModelsView";

export const Route = createFileRoute("/local-ai/models")({
  component: ModelsView,
});
