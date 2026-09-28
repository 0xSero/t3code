import { via } from "@local-studio/local-ai-model";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { controllerFetch, controllerJson } from "../../state/controllerClient";
import { reloadLocalAi } from "../../state/localAiStore";

export interface StopTarget {
  readonly peerId: string | null;
  readonly modelId: string;
  readonly name: string;
  readonly machine: string;
  readonly watchdog: string | null;
  readonly stopBlocked: string | null;
  readonly readOnly: boolean;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function StopModelDialog({
  environmentId,
  target,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: StopTarget | null;
  readonly onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const close = () => {
    if (busy) return;
    setTyped("");
    setError(null);
    setDone(false);
    onClose();
  };

  const stop = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await controllerFetch<unknown>(
        environmentId,
        via(target.peerId, `/api/models/${encodeURIComponent(target.modelId)}/stop`),
        controllerJson("POST", { confirm: typed, ...(target.watchdog ? { force: true } : {}) }),
        60_000,
      );
      setDone(true);
      void reloadLocalAi(environmentId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const matches = target !== null && typed === target.modelId;
  const blocked = target?.stopBlocked ?? null;

  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="max-w-md" data-testid="local-ai-stop-dialog">
        <DialogHeader>
          <DialogTitle>{`Stop ${target?.name ?? "model"}?`}</DialogTitle>
          <DialogDescription>
            {`The model on ${target?.machine ?? "this machine"} stops serving and frees its GPUs. Requests in flight fail.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {target?.watchdog ? (
              <p className="text-xs text-warning-foreground" data-testid="local-ai-stop-watchdog">
                {`${target.watchdog} watches this model and would start it again. Stopping sends force, which stops the watchdog first.`}
              </p>
            ) : null}
            {blocked ? (
              <p className="text-xs text-destructive-foreground">{blocked}</p>
            ) : done ? (
              <p className="text-sm text-foreground" data-testid="local-ai-stop-done">
                Stopping. The model leaves the list once its GPUs are free.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="local-ai-stop-confirm">
                  Type <span className="font-mono text-foreground">{target?.modelId}</span> to
                  confirm
                </Label>
                <Input
                  id="local-ai-stop-confirm"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={target?.readOnly ?? false}
                  data-testid="local-ai-stop-input"
                />
              </div>
            )}
            {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            {done ? "Close" : "Cancel"}
          </Button>
          {!done && !blocked ? (
            <Button
              variant="destructive"
              onClick={() => void stop()}
              disabled={!matches || busy || (target?.readOnly ?? false)}
              data-testid="local-ai-stop-confirm"
            >
              {busy ? "Stopping…" : target?.watchdog ? "Force stop" : "Stop model"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
