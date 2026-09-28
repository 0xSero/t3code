import { LOCAL_AI_DRIVER_KIND, LOCAL_AI_ROUTE_PATH } from "@local-studio/t3-providers";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

function isLocalAiSetupLocation(location: { pathname: string; search: string }): boolean {
  if (location.pathname !== "/settings/providers") return false;
  const instanceId = new URLSearchParams(location.search).get("instanceId");
  return instanceId === LOCAL_AI_DRIVER_KIND || instanceId === `"${LOCAL_AI_DRIVER_KIND}"`;
}

export function useLocalAiSetupRedirect(): void {
  const router = useRouter();
  useEffect(
    () =>
      router.history.subscribe(({ location }) => {
        if (isLocalAiSetupLocation(location)) {
          void router.navigate({ to: LOCAL_AI_ROUTE_PATH, replace: true });
        }
      }),
    [router],
  );
}
