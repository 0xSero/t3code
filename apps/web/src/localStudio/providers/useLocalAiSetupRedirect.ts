import { LOCAL_AI_DRIVER_KIND, LOCAL_AI_ROUTE_PATH } from "@local-studio/t3-providers";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

function readInstanceId(search: unknown): string | null {
  if (typeof search !== "object" || search === null || !("instanceId" in search)) return null;
  const value = search.instanceId;
  return typeof value === "string" ? value : null;
}

export function useLocalAiSetupRedirect(): void {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const instanceId = useLocation({ select: (location) => readInstanceId(location.search) });
  useEffect(() => {
    if (pathname === "/settings/providers" && instanceId === LOCAL_AI_DRIVER_KIND) {
      void navigate({ to: LOCAL_AI_ROUTE_PATH, replace: true });
    }
  }, [instanceId, navigate, pathname]);
}
