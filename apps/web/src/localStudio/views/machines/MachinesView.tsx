import { fmt } from "@local-studio/contracts/client";
import {
  aggOf,
  type MachineView,
  machines as machineViews,
  powerText,
  resFig,
} from "@local-studio/local-ai-model";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { Separator } from "../../../components/ui/separator";
import { Skeleton } from "../../../components/ui/skeleton";
import { controllerFetch, controllerJson } from "../../state/controllerClient";
import { useLocalAiEnvironmentId } from "../../state/environment";
import { reloadLocalAi, useLocalAi } from "../../state/localAiStore";
import { DiscoverDialog } from "./DiscoverDialog";
import { MachineSection } from "./MachineSection";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Summary({ items }: { readonly items: ReadonlyArray<{ label: string; value: string }> }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-xl font-semibold text-foreground tabular-nums">
            {item.value}
          </span>
          <span className="text-xs text-muted-foreground">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function RemoveMachineDialog({
  environmentId,
  machine,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly machine: MachineView | null;
  readonly onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    if (!machine?.peerId) return;
    setBusy(true);
    setError(null);
    try {
      await controllerFetch<unknown>(
        environmentId,
        `/api/machines/${encodeURIComponent(machine.peerId)}`,
        controllerJson("DELETE"),
      );
      void reloadLocalAi(environmentId);
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog
      open={machine !== null}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setError(null);
          onClose();
        }
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{`Remove ${machine?.name ?? "machine"}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            The machine leaves this controller's fleet. Models running on it keep running, and you
            can connect it again later.
          </AlertDialogDescription>
          {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose disabled={busy} render={<Button variant="outline" disabled={busy} />}>
            Cancel
          </AlertDialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? "Removing…" : "Remove"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export function MachinesView() {
  const environmentId = useLocalAiEnvironmentId();
  const store = useLocalAi(environmentId);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [removing, setRemoving] = useState<MachineView | null>(null);
  const fleet = store.model.fleet;
  const launches = store.model.launches;
  const engines = store.model.engines;

  const list = useMemo(
    () =>
      machineViews(fleet, launches).toSorted((a, b) =>
        a.self === b.self ? a.name.localeCompare(b.name) : a.self ? -1 : 1,
      ),
    [fleet, launches],
  );
  const online = list.filter((machine) => machine.online);
  const aggregate = useMemo(() => aggOf(online, engines), [online, engines]);

  if (environmentId === null) return null;

  const summary = [
    { label: "machines online", value: `${online.length} / ${list.length}` },
    { label: "GPUs", value: String(aggregate.gpus) },
    { label: resFig(online, "vram").k, value: resFig(online, "vram").v },
    {
      label: "average GPU load",
      value: aggregate.util === null ? "–" : `${Math.round(aggregate.util)}%`,
    },
    { label: "GPU power", value: powerText(online) },
  ];

  return (
    <div className="flex flex-col gap-6" data-testid="local-ai-machines">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Machines & GPUs</h2>
          <p className="text-xs text-muted-foreground">
            {fleet
              ? `Updated ${fmt.ago(fleet.at)} · live from the Local Studio fleet`
              : "Waiting for the Local Studio fleet"}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setDiscoverOpen(true)}>
          Connect a machine
        </Button>
      </div>
      {fleet ? (
        <>
          <Summary items={summary} />
          {list.map((machine, index) => (
            <div key={`${machine.id}:${machine.peerId ?? "self"}`} className="flex flex-col gap-6">
              {index > 0 ? <Separator /> : null}
              <MachineSection machine={machine} onRemove={setRemoving} />
            </div>
          ))}
        </>
      ) : store.loaded ? (
        <p className="text-sm text-muted-foreground">
          No fleet data yet. Check the controller settings above.
        </p>
      ) : (
        <div className="grid gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}
      <DiscoverDialog
        environmentId={environmentId}
        open={discoverOpen}
        onOpenChange={setDiscoverOpen}
      />
      <RemoveMachineDialog
        environmentId={environmentId}
        machine={removing}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}
