import type { RecipeExport, RecipePr } from "@local-studio/contracts/client";
import { via } from "@local-studio/local-ai-model";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

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
import { Skeleton } from "../../../components/ui/skeleton";
import { controllerFetch, controllerJson } from "../../state/controllerClient";

export interface ExportTarget {
  readonly peerId: string | null;
  readonly modelId: string;
  readonly name: string;
  readonly readOnly: boolean;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function ExportBody({
  environmentId,
  target,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: ExportTarget;
}) {
  const [record, setRecord] = useState<RecipeExport | null>(null);
  const [pr, setPr] = useState<RecipePr | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = via(target.peerId, `/api/models/${encodeURIComponent(target.modelId)}/export`);

  useEffect(() => {
    let active = true;
    controllerFetch<RecipeExport>(environmentId, base, controllerJson("POST"), 60_000).then(
      (value) => {
        if (active) setRecord(value);
      },
      (cause) => {
        if (active) setError(messageOf(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [environmentId, base]);

  const openPr = async () => {
    setBusy(true);
    setError(null);
    try {
      setPr(
        await controllerFetch<RecipePr>(
          environmentId,
          `${base}/pr`,
          controllerJson("POST", { draft: true }),
          180_000,
        ),
      );
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogPanel>
        <div className="flex flex-col gap-3">
          {record ? (
            <>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Recipe</dt>
                <dd className="text-foreground">{record.recipeId}</dd>
                <dt className="text-muted-foreground">Launchable</dt>
                <dd className="text-foreground">{record.launchable ? "yes" : "no"}</dd>
                <dt className="text-muted-foreground">Saved to</dt>
                <dd className="break-all text-foreground">{record.savedTo}</dd>
              </dl>
              {record.refusals.length > 0 ? (
                <ul className="flex flex-col gap-0.5 text-xs text-destructive-foreground">
                  {record.refusals.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {record.warnings.length > 0 ? (
                <ul className="flex flex-col gap-0.5 text-xs text-warning-foreground">
                  {record.warnings.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
              <pre className="max-h-72 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-2xs leading-4 text-muted-foreground">
                {JSON.stringify(record.record, null, 2)}
              </pre>
              {pr ? (
                <a
                  className="text-sm text-foreground underline underline-offset-2"
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {pr.url}
                </a>
              ) : null}
            </>
          ) : error ? null : (
            <Skeleton className="h-40 w-full" />
          )}
          {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button
          onClick={() => void openPr()}
          disabled={!record || record.refusals.length > 0 || busy || pr !== null || target.readOnly}
        >
          {busy ? "Opening PR…" : "Open registry PR"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function ExportRecipeDialog({
  environmentId,
  target,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: ExportTarget | null;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-2xl" data-testid="local-ai-export-dialog">
        <DialogHeader>
          <DialogTitle>{`Save config for ${target?.name ?? "model"}`}</DialogTitle>
          <DialogDescription>
            Exports the running model as a recipe on its machine. A draft PR to the recipe registry
            is optional.
          </DialogDescription>
        </DialogHeader>
        {target ? (
          <ExportBody
            key={`${target.peerId}:${target.modelId}`}
            environmentId={environmentId}
            target={target}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
