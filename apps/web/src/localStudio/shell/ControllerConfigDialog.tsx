import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { controllerFetch, controllerJson } from "../state/controllerClient";
import { restartLocalAi } from "../state/localAiStore";

type ControllerMode = "sidecar" | "remote" | "off";

interface ControllerConfig {
  readonly mode: ControllerMode;
  readonly url?: string | null;
  readonly hasKey: boolean;
}

const MODES: ReadonlyArray<{ readonly value: ControllerMode; readonly label: string }> = [
  { value: "sidecar", label: "On this machine" },
  { value: "remote", label: "Remote" },
  { value: "off", label: "Off" },
];

const MODE_HINT: Record<ControllerMode, string> = {
  sidecar: "T3 reuses a Local Studio controller already running here, or starts the bundled one.",
  remote: "T3 talks to a Local Studio controller on another machine. The key stays on this server.",
  off: "T3 does not start or contact a Local Studio controller.",
};

const isMode = (value: unknown): value is ControllerMode =>
  value === "sidecar" || value === "remote" || value === "off";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function ControllerConfigDialog({
  environmentId,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [config, setConfig] = useState<ControllerConfig | null>(null);
  const [mode, setMode] = useState<ControllerMode>("sidecar");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setNotice(null);
    controllerFetch<ControllerConfig>(environmentId, "/_config").then(
      (next) => {
        if (cancelled) return;
        setConfig(next);
        setMode(isMode(next.mode) ? next.mode : "sidecar");
        setUrl(next.url ?? "");
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId, open]);

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      const body =
        mode === "remote"
          ? { mode, url: url.trim(), ...(key.trim() ? { key: key.trim() } : {}) }
          : { mode };
      const next = await controllerFetch<ControllerConfig>(
        environmentId,
        "/_config",
        controllerJson("PUT", body),
      );
      setConfig(next);
      setKey("");
      restartLocalAi(environmentId);
      onOpenChange(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    setBusy("install");
    setError(null);
    setNotice(null);
    try {
      await controllerFetch<unknown>(environmentId, "/_install", controllerJson("POST", {}));
      setNotice("The Local Studio controller is installed.");
      restartLocalAi(environmentId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const canSave = busy === null && (mode !== "remote" || /^https?:\/\/\S+$/.test(url.trim()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md" data-testid="local-ai-controller-config">
        <DialogHeader>
          <DialogTitle>Local Studio controller</DialogTitle>
          <DialogDescription>
            Local AI reads machines, GPUs and models from this environment's Local Studio
            controller.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave) void save();
            }}
          >
            <div className="grid gap-1.5">
              <Label>Controller</Label>
              <ToggleGroup
                aria-label="Controller mode"
                variant="segmented"
                value={[mode]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (isMode(value)) setMode(value);
                }}
              >
                {MODES.map((item) => (
                  <Toggle key={item.value} value={item.value}>
                    {item.label}
                  </Toggle>
                ))}
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">{MODE_HINT[mode]}</p>
            </div>
            {mode === "remote" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="local-ai-controller-url">Controller URL</Label>
                  <Input
                    id="local-ai-controller-url"
                    placeholder="http://pop-os.tailnet.ts.net:8080"
                    value={url}
                    spellCheck={false}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="local-ai-controller-key">Key</Label>
                  <Input
                    id="local-ai-controller-key"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      config?.hasKey ? "Saved; leave empty to keep it" : "Admin or federation key"
                    }
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                  />
                </div>
              </>
            ) : null}
            {mode === "sidecar" ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-3">
                <p className="text-xs text-muted-foreground">
                  No controller on this machine? Install the pinned Local Studio release.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void install()}
                >
                  {busy === "install" ? "Installing…" : "Install controller"}
                </Button>
              </div>
            ) : null}
            {notice ? <p className="text-xs text-foreground">{notice}</p> : null}
            {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
