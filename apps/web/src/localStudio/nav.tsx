import { LOCAL_AI_PROVIDER_LABEL, LOCAL_AI_ROUTE_PATH } from "@local-studio/t3-providers";
import { useNavigate } from "@tanstack/react-router";
import { CpuIcon } from "lucide-react";
import { useCallback } from "react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useLocalAiSetupRedirect } from "./providers/useLocalAiSetupRedirect";

export function isLocalAiPath(pathname: string): boolean {
  return pathname === LOCAL_AI_ROUTE_PATH || pathname.startsWith(`${LOCAL_AI_ROUTE_PATH}/`);
}

export function LocalAiUtilityButton() {
  useLocalAiSetupRedirect();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: LOCAL_AI_ROUTE_PATH });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={LOCAL_AI_PROVIDER_LABEL}
              onClick={handleClick}
              size="icon"
            >
              <CpuIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{LOCAL_AI_PROVIDER_LABEL}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
