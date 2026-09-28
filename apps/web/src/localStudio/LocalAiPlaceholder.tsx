import { initialLocalAiState, onEvent, type LocalAiState } from "@local-studio/local-ai-model";
import { useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { controllerEvents, controllerFetch } from "./state/controllerClient";

type ControllerStatus =
  | { readonly kind: "checking" }
  | { readonly kind: "connected" }
  | { readonly kind: "unavailable"; readonly reason: string };

export function LocalAiPlaceholder() {
  const environmentId = usePrimaryEnvironmentId();
  const [fetchedStatus, setStatus] = useState<ControllerStatus>({ kind: "checking" });
  const [state, setState] = useState<LocalAiState>(initialLocalAiState);
  const status: ControllerStatus =
    environmentId === null
      ? { kind: "unavailable", reason: "No environment is connected." }
      : fetchedStatus;

  useEffect(() => {
    if (environmentId === null) return;
    let cancelled = false;
    controllerFetch<unknown>(environmentId, "/health").then(
      () => {
        if (!cancelled) setStatus({ kind: "connected" });
      },
      (error: unknown) => {
        if (!cancelled) {
          setStatus({
            kind: "unavailable",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    const unsubscribe = controllerEvents(environmentId, ["snapshot", "fleet"], (event) =>
      setState((current) => onEvent(current, event)),
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [environmentId]);

  const machineCount = state.fleet?.machines.length ?? (state.snapshot ? 1 : 0);

  return (
    <section className="flex flex-col gap-3" data-testid="local-ai-placeholder">
      <p className="text-sm text-foreground">
        Machines, GPUs, run configs, running models, endpoints, usage and agents from your Local
        Studio controller will appear here.
      </p>
      <p className="text-sm text-muted-foreground">
        {status.kind === "checking"
          ? "Checking the Local Studio controller…"
          : status.kind === "connected"
            ? `Controller connected. ${machineCount} machine${machineCount === 1 ? "" : "s"} reported.`
            : "The Local Studio controller is not connected yet."}
      </p>
      {status.kind === "unavailable" ? (
        <p className="text-xs text-muted-foreground">{status.reason}</p>
      ) : null}
    </section>
  );
}
