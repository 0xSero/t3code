import type { LaunchProgress, SelectionFit, SelectionRow } from "@local-studio/contracts/client";
import {
  type GpuSelection,
  initialSelection,
  machines as machineViews,
  matchesFilter,
  rowAction,
  selectionEntries,
  selectionHolders,
  selectionSummary,
  toggleGpu,
  via,
} from "@local-studio/local-ai-model";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Input } from "../../../components/ui/input";
import { Skeleton } from "../../../components/ui/skeleton";
import { Spinner } from "../../../components/ui/spinner";
import { controllerFetch, controllerJson } from "../../state/controllerClient";
import { useLocalAiEnvironmentId } from "../../state/environment";
import { useLocalAi } from "../../state/localAiStore";
import { GpuPicker } from "./GpuPicker";
import { trackLaunch } from "./launchTracker";
import { RecipeRowItem, type RowTarget } from "./RecipeRowItem";

interface PodLaunchResult {
  readonly podId: string;
  readonly head: string;
  readonly ranks: ReadonlyArray<{
    readonly machine: string;
    readonly rank: number;
    readonly launchId: string;
    readonly phase: string;
  }>;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function RunView({
  machine,
  gpus,
}: {
  readonly machine: string | null;
  readonly gpus: string | null;
}) {
  const environmentId = useLocalAiEnvironmentId();
  const store = useLocalAi(environmentId);
  const navigate = useNavigate();
  const fleet = store.model.fleet;
  const launches = store.model.launches;
  const ms = useMemo(() => machineViews(fleet, launches), [fleet, launches]);
  const [selection, setSelection] = useState<GpuSelection>({});
  const [seeded, setSeeded] = useState(false);
  const [fit, setFit] = useState<SelectionFit | null>(null);
  const [fitError, setFitError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (seeded || ms.length === 0) return;
    setSelection(initialSelection(ms, machine, gpus));
    setSeeded(true);
  }, [seeded, ms, machine, gpus]);

  const entries = selectionEntries(selection);
  const selectionKey = JSON.stringify(entries);

  useEffect(() => {
    setFit(null);
    setFitError(null);
    if (environmentId === null || entries.length === 0) return;
    let active = true;
    controllerFetch<SelectionFit>(
      environmentId,
      "/api/recipes/fit",
      controllerJson("POST", {
        selection: entries.map(([machineId, gpuKeys]) => ({ machineId, gpuKeys })),
      }),
    ).then(
      (value) => {
        if (active) setFit(value);
      },
      (cause) => {
        if (active) setFitError(messageOf(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [environmentId, selectionKey]);

  const rows = useMemo(
    () => (fit?.rows ?? []).filter((row) => matchesFilter(row, query)),
    [fit, query],
  );

  if (environmentId === null) return null;

  const count = entries.reduce((total, [, keys]) => total + keys.length, 0);
  const holders = selectionHolders(ms, entries);
  const first = entries[0];
  const firstMachine = first ? ms.find((item) => item.id === first[0]) : undefined;
  const target: RowTarget | null =
    first && firstMachine
      ? {
          peerId: firstMachine.peerId,
          gpuKeys: first[1],
          machineNames: entries.map(([id]) => ms.find((item) => item.id === id)?.name ?? id),
        }
      : null;

  const run = async (row: SelectionRow) => {
    if (!first || !firstMachine) return;
    setBusy(row.id);
    setError(null);
    setNotice(null);
    try {
      const progress = await controllerFetch<LaunchProgress>(
        environmentId,
        via(firstMachine.peerId, `/api/recipes/${encodeURIComponent(row.id)}/launch`),
        controllerJson("POST", { gpuKeys: first[1], stop: row.fit === "busy" }),
      );
      trackLaunch(environmentId, {
        machineId: firstMachine.id,
        peerId: firstMachine.peerId,
        progress: { ...progress, machineId: progress.machineId ?? firstMachine.id },
      });
      void navigate({ to: "/local-ai/models" });
    } catch (cause) {
      setError(`${row.name} did not start: ${messageOf(cause)}`);
    } finally {
      setBusy(null);
    }
  };

  const runPod = async (row: SelectionRow) => {
    setBusy(row.id);
    setError(null);
    setNotice(null);
    try {
      const result = await controllerFetch<PodLaunchResult>(
        environmentId,
        "/api/pods/launch",
        controllerJson("POST", { recipeId: row.id, machineIds: entries.map(([id]) => id) }),
        120_000,
      );
      setNotice(
        `Pod ${result.podId} started on ${result.ranks
          .toSorted((a, b) => a.rank - b.rank)
          .map((rank) => `${rank.machine} (rank ${rank.rank}, ${rank.phase})`)
          .join(", ")}. ${result.head} serves the API.`,
      );
    } catch (cause) {
      setError(`Pod ${row.name} did not start: ${messageOf(cause)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-6" data-testid="local-ai-run">
      <div>
        <h2 className="text-sm font-medium text-foreground">Run a model</h2>
        <p className="text-xs text-muted-foreground">
          Pick GPUs on one machine, or one GPU on each machine of a pod. Configs that fit the
          selection are listed below.
        </p>
      </div>
      {fleet ? (
        <GpuPicker
          machines={ms}
          selection={selection}
          onToggle={(item, key) => setSelection((current) => toggleGpu(current, item.id, key))}
          onSelectFree={(item) => setSelection(initialSelection(ms, item.id, null))}
          onClear={() => setSelection({})}
        />
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="min-w-0 flex-1 truncate text-sm text-foreground"
            data-testid="local-ai-selection"
          >
            {count ? selectionSummary(ms, entries) : "No GPUs picked"}
          </span>
          <Input
            size="sm"
            className="w-48"
            placeholder="Filter configs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter configs"
          />
        </div>
        <p className="text-xs text-muted-foreground" data-testid="local-ai-fit-count">
          {count === 0
            ? "Pick GPUs to see which configs fit."
            : fitError
              ? ""
              : fit
                ? `${rows.length} configs fit${holders.length ? ` · Stop & run stops ${holders.join(", ")} first` : ""}`
                : "Checking which configs fit…"}
        </p>
        {notice ? (
          <Alert variant="success" data-testid="local-ai-run-notice">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}
        {error || fitError ? (
          <Alert variant="error" data-testid="local-ai-run-error">
            <CircleAlertIcon />
            <AlertTitle>{error ? "Launch failed" : "Could not check the fit"}</AlertTitle>
            <AlertDescription>{error ?? fitError}</AlertDescription>
          </Alert>
        ) : null}
        {count > 0 && !fit && !fitError ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
          </div>
        ) : null}
        {fit && rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No config fits this selection.</p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="flex flex-col rounded-lg border" data-testid="local-ai-recipe-rows">
            {rows.map((row) => (
              <RecipeRowItem
                key={row.id}
                environmentId={environmentId}
                row={row}
                action={rowAction(row, entries.length)}
                target={target}
                expanded={open === row.id}
                busy={busy === row.id}
                disabled={busy !== null || (firstMachine?.readOnly ?? false)}
                onToggle={() => setOpen((current) => (current === row.id ? null : row.id))}
                onRun={() => void run(row)}
                onPod={() => void runPod(row)}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
