import { via } from "@local-studio/local-ai-model";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../../../components/ui/button";
import { controllerFetch, controllerJson } from "../../state/controllerClient";

interface LabRun {
  readonly id: string;
  readonly phase: string;
  readonly detail: string;
  readonly gates: Readonly<Record<string, boolean>>;
  readonly proof: { readonly tps: number; readonly prefill: number | null } | null;
}

const POLL_MS = 3_000;
const done = (run: LabRun) => run.phase === "passed" || run.phase === "failed";
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function VerifyAction({
  environmentId,
  peerId,
  modelId,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly peerId: string | null;
  readonly modelId: string;
  readonly disabled: boolean;
}) {
  const [run, setRun] = useState<LabRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!run || done(run)) return;
    const timer = setTimeout(() => {
      controllerFetch<LabRun>(
        environmentId,
        via(peerId, `/api/lab/runs/${encodeURIComponent(run.id)}`),
      ).then(setRun, (cause) => setError(messageOf(cause)));
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [run, environmentId, peerId]);

  const start = async () => {
    setError(null);
    try {
      setRun(
        await controllerFetch<LabRun>(
          environmentId,
          via(peerId, "/api/lab/verify"),
          controllerJson("POST", { model: modelId }),
          60_000,
        ),
      );
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const busy = run !== null && !done(run);
  const gates = run
    ? Object.entries(run.gates)
        .map(([gate, ok]) => `${gate} ${ok ? "✓" : "✗"}`)
        .join(" · ")
    : "";
  const tail = run
    ? run.proof
      ? ` · ${run.proof.tps} tok/s`
      : busy
        ? ` · ${run.detail}`
        : run.phase === "failed" && gates === ""
          ? run.detail
          : ""
    : "";

  return (
    <span className="flex min-w-0 items-center gap-2" data-testid="local-ai-verify">
      <Button size="xs" variant="outline" onClick={() => void start()} disabled={busy || disabled}>
        {busy ? "Verifying…" : "Verify"}
      </Button>
      {run ? (
        <span
          className={`truncate text-xs ${run.phase === "failed" ? "text-destructive-foreground" : "text-muted-foreground"}`}
        >
          {`${gates}${tail}`}
        </span>
      ) : null}
      {error ? <span className="truncate text-xs text-destructive-foreground">{error}</span> : null}
    </span>
  );
}
