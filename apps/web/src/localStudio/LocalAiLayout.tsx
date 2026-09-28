import { LOCAL_AI_PROVIDER_LABEL } from "@local-studio/t3-providers";
import type { ReactNode } from "react";

import { isElectron } from "../env";
import { ScrollArea } from "../components/ui/scroll-area";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";

export function LocalAiLayout({ children }: { readonly children: ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="text-sm font-medium">{LOCAL_AI_PROVIDER_LABEL}</h1>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">{children}</WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
