import type { EnvironmentId } from "@t3tools/contracts";
import { CircleAlertIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import type { LocalAiStore } from "../state/localAiStore";
import { restartLocalAi } from "../state/localAiStore";

const seconds = (ms: number | null) => (ms === null ? null : Math.max(1, Math.round(ms / 1000)));

export function ControllerBanner({
  environmentId,
  store,
  onConfigure,
}: {
  readonly environmentId: EnvironmentId;
  readonly store: LocalAiStore;
  readonly onConfigure: () => void;
}) {
  const down = store.connection === "retrying" || store.error !== null;
  if (!down) return null;
  const retry = seconds(store.retryMs);
  const detail =
    store.error ??
    (store.model.fleet
      ? "Lost the live connection. Showing the last data received."
      : "Could not reach the controller.");
  return (
    <Alert variant="warning" data-testid="local-ai-controller-banner">
      <CircleAlertIcon />
      <AlertTitle>Local Studio controller unavailable</AlertTitle>
      <AlertDescription>
        <span>
          {detail}
          {store.connection === "retrying" && retry !== null ? ` Retrying in ${retry}s.` : ""}
        </span>
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={() => restartLocalAi(environmentId)}>
          Retry now
        </Button>
        <Button size="sm" variant="outline" onClick={onConfigure}>
          Controller settings
        </Button>
      </AlertAction>
    </Alert>
  );
}
