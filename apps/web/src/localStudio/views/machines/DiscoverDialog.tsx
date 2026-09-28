import type { Peer, TailnetCandidate } from "@local-studio/contracts/client";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "../../../components/ui/badge";
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
import { Spinner } from "../../../components/ui/spinner";
import { controllerFetch, controllerJson } from "../../state/controllerClient";
import { reloadLocalAi } from "../../state/localAiStore";

interface TailnetInfo {
  readonly signedIn: boolean;
  readonly login: string | null;
  readonly tailnet: string | null;
  readonly trust: boolean;
  readonly auto: boolean;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const candidateDetail = (candidate: TailnetCandidate) => {
  const os = candidate.os ? `${candidate.os} · ` : "";
  if (candidate.kind === "legacy-controller") return `${os}older controller; update it to connect`;
  if (!candidate.mine) return `${os}signed in to another account`;
  return `${os}${candidate.url.replace(/^https?:\/\//, "")}`;
};

export function DiscoverDialog({
  environmentId,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [info, setInfo] = useState<TailnetInfo | null>(null);
  const [candidates, setCandidates] = useState<ReadonlyArray<TailnetCandidate> | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const scan = useCallback(() => {
    setCandidates(null);
    setScanError(null);
    controllerFetch<TailnetCandidate[]>(environmentId, "/api/machines/discover").then(
      (rows) => setCandidates(Array.isArray(rows) ? rows.filter((row) => row.kind !== "none") : []),
      (cause: unknown) => {
        setCandidates([]);
        setScanError(messageOf(cause));
      },
    );
  }, [environmentId]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    controllerFetch<TailnetInfo>(environmentId, "/api/tailnet").then(setInfo, () => setInfo(null));
    scan();
  }, [environmentId, open, scan]);

  const connect = async (target: string, withKey?: string) => {
    setBusy(target);
    setError(null);
    setNotice(null);
    try {
      const body = withKey ? { url: target.trim(), key: withKey.trim() } : { url: target.trim() };
      const peer = await controllerFetch<(Peer & { warning?: string }) | null>(
        environmentId,
        "/api/machines",
        controllerJson("POST", body),
      );
      setKey("");
      setNotice(
        peer?.warning
          ? `Connected ${peer.name}. ${peer.warning}`
          : `Connected ${peer?.name ?? target}.`,
      );
      void reloadLocalAi(environmentId);
      scan();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const connected = candidates?.filter((candidate) => candidate.alreadyConnected).length ?? 0;
  const canConnectManually =
    busy === null && /^https?:\/\/\S+$/.test(url.trim()) && key.trim().length >= 16;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg" data-testid="local-ai-discover">
        <DialogHeader>
          <DialogTitle>Connect a machine</DialogTitle>
          <DialogDescription>
            Machines on your tailnet that run Local Studio join this controller's fleet.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-5">
            <section className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">
                  {info === null
                    ? "Tailscale status unknown"
                    : info.signedIn
                      ? `Tailscale · ${info.login ?? "signed in"}`
                      : "Tailscale is not running here"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {info?.signedIn
                    ? info.auto
                      ? "Machines on this account connect automatically."
                      : "Machines on this account connect without a key."
                    : "Install Tailscale and sign in, or connect by address below."}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={scan} disabled={candidates === null}>
                Scan again
              </Button>
            </section>
            <section className="grid gap-2">
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-medium text-foreground">On your tailnet</h3>
                {candidates && candidates.length > 0 ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {`${connected} of ${candidates.length} connected`}
                  </span>
                ) : null}
              </div>
              {candidates === null ? (
                <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                  <Spinner size="sm" />
                  Scanning
                </div>
              ) : candidates.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">
                  {scanError ?? "No other machines on this tailnet run Local Studio."}
                </p>
              ) : (
                <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
                  {candidates.map((candidate) => (
                    <li
                      key={candidate.dnsName}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                      data-testid="local-ai-candidate"
                      data-host={candidate.hostName}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-foreground">{candidate.hostName}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {candidateDetail(candidate)}
                        </p>
                      </div>
                      {candidate.alreadyConnected ? (
                        <Badge variant="success">Connected</Badge>
                      ) : candidate.kind === "local-studio" ? (
                        <Button
                          size="sm"
                          variant={candidate.mine ? "default" : "outline"}
                          disabled={busy !== null}
                          onClick={() => {
                            if (candidate.mine) void connect(candidate.url);
                            else setUrl(candidate.url);
                          }}
                        >
                          {busy === candidate.url
                            ? "Connecting…"
                            : candidate.mine
                              ? "Connect"
                              : "Use a key"}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (canConnectManually) void connect(url, key);
              }}
            >
              <div>
                <h3 className="text-sm font-medium text-foreground">By address</h3>
                <p className="text-xs text-muted-foreground">
                  For a controller outside your tailnet. Run{" "}
                  <code className="text-foreground">local-studio key --federation</code> there.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="local-ai-connect-url">Controller URL</Label>
                <Input
                  id="local-ai-connect-url"
                  placeholder="http://host:8080"
                  spellCheck={false}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="local-ai-connect-key">Key</Label>
                <Input
                  id="local-ai-connect-key"
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                />
              </div>
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={!canConnectManually}>
                  Connect
                </Button>
              </div>
            </form>
            {notice ? (
              <p className="text-xs text-foreground" data-testid="local-ai-connect-notice">
                {notice}
              </p>
            ) : null}
            {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
