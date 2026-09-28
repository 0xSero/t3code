import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/local-ai/")({
  beforeLoad: () => {
    throw redirect({ to: "/local-ai/machines", replace: true });
  },
});
