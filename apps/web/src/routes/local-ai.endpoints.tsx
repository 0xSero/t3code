import { createFileRoute } from "@tanstack/react-router";

import { EndpointsView } from "../localStudio/views/endpoints/EndpointsView";

export const Route = createFileRoute("/local-ai/endpoints")({
  component: EndpointsView,
});
