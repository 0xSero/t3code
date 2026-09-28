import { LOCAL_AI_PROVIDER_LABEL } from "@local-studio/t3-providers";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { useLocalAiEnvironmentId } from "../state/environment";
import { type LocalAiStore, useLocalAi } from "../state/localAiStore";
import { ControllerBanner } from "./ControllerBanner";
import { ControllerConfigDialog } from "./ControllerConfigDialog";
import { activeTabOf, LOCAL_AI_TABS } from "./tabs";

function ConnectionBadge({ store }: { readonly store: LocalAiStore }) {
  if (store.connection === "live")
    return (
      <Badge variant="success" data-testid="local-ai-connection" data-state="live">
        Live
      </Badge>
    );
  if (store.connection === "retrying")
    return (
      <Badge variant="warning" data-testid="local-ai-connection" data-state="retrying">
        Reconnecting
      </Badge>
    );
  return (
    <Badge variant="secondary" data-testid="local-ai-connection" data-state="connecting">
      Connecting
    </Badge>
  );
}

export function LocalAiShell({ children }: { readonly children: ReactNode }) {
  const environmentId = useLocalAiEnvironmentId();
  const store = useLocalAi(environmentId);
  const router = useRouter();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const active = activeTabOf(pathname);
  const [configOpen, setConfigOpen] = useState(false);
  const available = (path: string) => path in router.routesByPath;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-2">
            <h1 className="text-sm font-medium">{LOCAL_AI_PROVIDER_LABEL}</h1>
            <ToggleGroup
              aria-label="Local AI sections"
              variant="segmented"
              value={active ? [active.path] : []}
              onValueChange={(next) => {
                const path = next[0];
                if (typeof path === "string" && available(path))
                  void navigate({ to: path as "/local-ai" });
              }}
            >
              {LOCAL_AI_TABS.map((tab) => (
                <Toggle
                  key={tab.id}
                  value={tab.path}
                  disabled={!available(tab.path)}
                  data-testid={`local-ai-tab-${tab.id}`}
                >
                  {tab.label}
                </Toggle>
              ))}
            </ToggleGroup>
            <div className="ms-auto flex items-center gap-2">
              <ConnectionBadge store={store} />
              {environmentId !== null ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="Controller settings"
                        size="icon"
                        variant="ghost"
                        onClick={() => setConfigOpen(true)}
                      >
                        <SettingsIcon />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">Controller settings</TooltipPopup>
                </Tooltip>
              ) : null}
            </div>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded">
            {environmentId === null ? (
              <p className="text-sm text-muted-foreground">No environment is connected.</p>
            ) : (
              <>
                <ControllerBanner
                  environmentId={environmentId}
                  store={store}
                  onConfigure={() => setConfigOpen(true)}
                />
                {children}
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {environmentId !== null ? (
        <ControllerConfigDialog
          environmentId={environmentId}
          open={configOpen}
          onOpenChange={setConfigOpen}
        />
      ) : null}
    </SidebarInset>
  );
}
