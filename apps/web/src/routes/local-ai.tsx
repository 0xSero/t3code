import { createFileRoute, Outlet } from "@tanstack/react-router";

import { LocalAiLayout } from "../localStudio/LocalAiLayout";

export const Route = createFileRoute("/local-ai")({
  component: LocalAiRouteLayout,
});

function LocalAiRouteLayout() {
  return (
    <LocalAiLayout>
      <Outlet />
    </LocalAiLayout>
  );
}
