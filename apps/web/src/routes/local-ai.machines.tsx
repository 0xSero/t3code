import { createFileRoute } from "@tanstack/react-router";

import { MachinesView } from "../localStudio/views/machines/MachinesView";

export const Route = createFileRoute("/local-ai/machines")({
  component: MachinesView,
});
