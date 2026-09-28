import type { LaunchProgress } from "@local-studio/contracts/client";
import {
  type CardView,
  homeCards,
  isActiveLaunch,
  machines as machineViews,
  withTrackedLaunches,
} from "@local-studio/local-ai-model";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { controllerFetch, controllerJson } from "../../state/controllerClient";
import { useLocalAiEnvironmentId } from "../../state/environment";
import { reloadLocalAi, useLocalAi } from "../../state/localAiStore";
import { Meter } from "../machines/Meter";
import { cancelLaunch, dismissLaunch, useTrackedLaunches } from "../run/launchTracker";
import { ExportRecipeDialog, type ExportTarget } from "./ExportRecipeDialog";
import { LaunchProgressRow } from "./LaunchProgressRow";
import { StopModelDialog, type StopTarget } from "./StopModelDialog";
import { VerifyAction } from "./VerifyAction";

const MODALITY_LABEL: Record<CardView["modality"], string> = {
  chat: "chat",
  embedding: "embedding",
  stt: "speech to text",
  tts: "text to speech",
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const newest = (items: ReadonlyArray<LaunchProgress | undefined>): LaunchProgress | undefined =>
  items
    .filter((item): item is LaunchProgress => item !== undefined)
    .toSorted((a, b) => b.updatedAt - a.updatedAt)[0];

function ModelCard({
  card,
  onStop,
  onStopPod,
  onExport,
  onCancel,
  cancelling,
  children,
}: {
  readonly card: CardView;
  readonly onStop: () => void;
  readonly onStopPod: () => void;
  readonly onExport: () => void;
  readonly onCancel: () => void;
  readonly cancelling: boolean;
  readonly children?: ReactNode;
}) {
  const stopButton = card.pod ? (
    <Button size="xs" variant="destructive-outline" onClick={onStopPod} disabled={card.readOnly}>
      Stop pod
    </Button>
  ) : card.modelId ? (
    card.stopBlocked ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <span>
              <Button size="xs" variant="destructive-outline" disabled>
                Stop
              </Button>
            </span>
          }
        />
        <TooltipPopup side="bottom" className="max-w-72">
          {card.stopBlocked}
        </TooltipPopup>
      </Tooltip>
    ) : (
      <Button
        size="xs"
        variant="destructive-outline"
        onClick={onStop}
        disabled={card.readOnly}
        data-testid="local-ai-model-stop"
      >
        Stop
      </Button>
    )
  ) : card.launchId ? (
    <Button
      size="xs"
      variant="destructive-outline"
      onClick={onCancel}
      disabled={card.readOnly || cancelling}
    >
      {cancelling ? "Cancelling…" : "Cancel"}
    </Button>
  ) : null;

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border px-3 py-2.5"
      data-testid="local-ai-model"
      data-model={card.servedModel ?? card.name}
      data-machine={card.machine}
      data-ready={card.ready ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{card.name}</h3>
        <span className="text-xs text-muted-foreground">{card.machine}</span>
        {card.ready ? (
          <Badge variant="success">Ready</Badge>
        ) : card.subAlert ? (
          <Badge variant="error">Not answering</Badge>
        ) : (
          <Badge variant="info">Loading</Badge>
        )}
        {card.modality !== "chat" ? (
          <Badge variant="outline">{MODALITY_LABEL[card.modality]}</Badge>
        ) : null}
        {card.pod ? <Badge variant="outline">{`pod ${card.pod}`}</Badge> : null}
        {card.watchdog ? <Badge variant="warning">{`watchdog ${card.watchdog}`}</Badge> : null}
        <span className="ms-auto flex items-center gap-2">
          {card.modelId && card.ready ? (
            <Button size="xs" variant="outline" onClick={onExport}>
              Save config
            </Button>
          ) : null}
          {stopButton}
        </span>
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {[card.gpu, card.mem, card.stack].filter(Boolean).join(" · ")}
      </p>
      {card.figs ? (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          {(
            [
              ["total tokens", card.figs.total],
              ["decode tok/s", card.figs.decode],
              ["prefill tok/s", card.figs.prefill],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-1.5">
              <dd className="font-medium text-foreground tabular-nums">{value}</dd>
              <dt className="text-muted-foreground">{label}</dt>
            </div>
          ))}
        </dl>
      ) : (
        <p
          className={
            card.subAlert ? "text-xs text-destructive-foreground" : "text-xs text-muted-foreground"
          }
        >
          {card.sub}
        </p>
      )}
      {card.progress !== null ? <Meter pct={card.progress} label={`${card.name} loading`} /> : null}
      {children}
    </section>
  );
}

export function ModelsView() {
  const environmentId = useLocalAiEnvironmentId();
  const store = useLocalAi(environmentId);
  const tracked = useTrackedLaunches(environmentId);
  const [stopping, setStopping] = useState<StopTarget | null>(null);
  const [exporting, setExporting] = useState<ExportTarget | null>(null);
  const [pod, setPod] = useState<{ id: string; name: string } | null>(null);
  const [podBusy, setPodBusy] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fleet = store.model.fleet;
  const live = store.model.launches;
  const engines = store.model.engines;

  const ms = useMemo(
    () => withTrackedLaunches(machineViews(fleet, live), tracked),
    [fleet, live, tracked],
  );
  const cards = useMemo(
    () =>
      homeCards(
        ms,
        live,
        fleet?.self ?? null,
        Object.fromEntries(
          Object.entries(store.recipes).map(([id, rows]) => [id, rows ? [...rows] : null]),
        ),
        engines,
      ),
    [ms, live, fleet, store.recipes, engines],
  );

  const settled = useMemo(
    () =>
      tracked
        .map((entry) => {
          const machine = ms.find((item) => item.id === entry.machineId);
          const progress =
            newest([
              entry.progress,
              live[entry.progress.launchId],
              machine?.snap?.launches.find((item) => item.launchId === entry.progress.launchId),
            ]) ?? entry.progress;
          const recipe = store.recipes[entry.machineId]?.find(
            (item) => item.id === progress.recipeId,
          );
          return { entry, progress, machine, name: recipe?.name ?? progress.recipeId };
        })
        .filter((item) => !isActiveLaunch(item.progress)),
    [tracked, ms, live, store.recipes],
  );

  if (environmentId === null) return null;

  const cancel = async (peerId: string | null, launchId: string) => {
    setCancelling(launchId);
    setMessage(null);
    try {
      await cancelLaunch(environmentId, peerId, launchId);
      void reloadLocalAi(environmentId);
    } catch (cause) {
      setMessage(messageOf(cause));
    } finally {
      setCancelling(null);
    }
  };

  const stopPod = async () => {
    if (!pod) return;
    setPodBusy(true);
    setMessage(null);
    try {
      const result = await controllerFetch<{
        results: ReadonlyArray<{ machine: string; removed: number; error?: string }>;
      }>(
        environmentId,
        `/api/pods/${encodeURIComponent(pod.id)}/stop`,
        controllerJson("POST"),
        120_000,
      );
      setMessage(
        `Pod ${pod.id} stopped: ${result.results
          .map(
            (item) =>
              `${item.machine} ${item.error ? `failed (${item.error})` : `removed ${item.removed}`}`,
          )
          .join(", ")}`,
      );
      setPod(null);
      void reloadLocalAi(environmentId);
    } catch (cause) {
      setMessage(messageOf(cause));
    } finally {
      setPodBusy(false);
    }
  };

  const chat = cards.filter((card) => card.modality === "chat");
  const others = cards.filter((card) => card.modality !== "chat");

  const renderCard = (card: CardView) => (
    <ModelCard
      key={card.key}
      card={card}
      cancelling={card.launchId !== null && cancelling === card.launchId}
      onStop={() =>
        card.modelId &&
        setStopping({
          peerId: card.peerId,
          modelId: card.modelId,
          name: card.name,
          machine: card.machine,
          watchdog: card.watchdog,
          stopBlocked: card.stopBlocked,
          readOnly: card.readOnly,
        })
      }
      onStopPod={() => card.pod && setPod({ id: card.pod, name: card.name })}
      onExport={() =>
        card.modelId &&
        setExporting({
          peerId: card.peerId,
          modelId: card.modelId,
          name: card.name,
          readOnly: card.readOnly,
        })
      }
      onCancel={() => card.launchId && void cancel(card.peerId, card.launchId)}
    >
      {card.ready && card.modelId && card.modality === "chat" ? (
        <VerifyAction
          environmentId={environmentId}
          peerId={card.peerId}
          modelId={card.modelId}
          disabled={card.readOnly}
        />
      ) : null}
    </ModelCard>
  );

  return (
    <div className="flex flex-col gap-6" data-testid="local-ai-models">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Running models</h2>
          <p className="text-xs text-muted-foreground">
            {fleet
              ? `${chat.filter((card) => card.ready).length} ready across ${ms.filter((item) => item.online).length} machines`
              : "Waiting for the Local Studio fleet"}
          </p>
        </div>
        <Button size="sm" variant="outline" render={<Link to="/local-ai/run" />}>
          Run a model
        </Button>
      </div>
      {message ? (
        <p className="text-xs text-muted-foreground" data-testid="local-ai-models-message">
          {message}
        </p>
      ) : null}
      {settled.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">Recent launches</h3>
          {settled.map((item) => (
            <LaunchProgressRow
              key={item.progress.launchId}
              name={item.name}
              machine={item.machine?.name ?? item.entry.machineId}
              progress={item.progress}
              busy={false}
              readOnly={false}
              onCancel={() => undefined}
              onDismiss={() => dismissLaunch(environmentId, item.progress.launchId)}
            />
          ))}
        </div>
      ) : null}
      {fleet ? (
        <>
          {chat.length === 0 ? (
            <p className="text-sm text-muted-foreground">No chat model is running in the fleet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {chat.map((card) => {
                const launch = card.launchId
                  ? newest([
                      live[card.launchId],
                      ms
                        .find((item) => item.id === card.machineId)
                        ?.snap?.launches.find((item) => item.launchId === card.launchId),
                    ])
                  : undefined;
                return launch && !card.modelId ? (
                  <LaunchProgressRow
                    key={card.key}
                    name={card.name}
                    machine={card.machine}
                    progress={launch}
                    busy={cancelling === launch.launchId}
                    readOnly={card.readOnly}
                    onCancel={() => void cancel(card.peerId, launch.launchId)}
                    onDismiss={null}
                  />
                ) : (
                  renderCard(card)
                );
              })}
            </div>
          )}
          {others.length > 0 ? (
            <div className="flex flex-col gap-3">
              <h3 className="text-xs font-medium text-muted-foreground">Other endpoints</h3>
              {others.map(renderCard)}
            </div>
          ) : null}
        </>
      ) : store.loaded ? (
        <p className="text-sm text-muted-foreground">No fleet data yet.</p>
      ) : (
        <div className="grid gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      <StopModelDialog
        environmentId={environmentId}
        target={stopping}
        onClose={() => setStopping(null)}
      />
      <ExportRecipeDialog
        environmentId={environmentId}
        target={exporting}
        onClose={() => setExporting(null)}
      />
      <AlertDialog
        open={pod !== null}
        onOpenChange={(open) => {
          if (!open && !podBusy) setPod(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Stop pod ${pod?.id ?? ""}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {`${pod?.name ?? "The model"} stops on every machine of the pod.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={podBusy}
              render={<Button variant="outline" disabled={podBusy} />}
            >
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={podBusy} onClick={() => void stopPod()}>
              {podBusy ? "Stopping…" : "Stop pod"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
