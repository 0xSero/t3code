import { createFileRoute, Outlet } from "@tanstack/react-router";

import { LocalAiShell } from "../localStudio/shell/LocalAiShell";

export const Route = createFileRoute("/local-ai")({
  component: LocalAiRouteLayout,
});

function LocalAiRouteLayout() {
  return (
    <LocalAiShell>
      <Outlet />
    </LocalAiShell>
  );
}
