import type { SelectionRow } from "@local-studio/contracts/client";
import { fmt } from "@local-studio/contracts/client";
import {
  fmtFormat,
  proofText,
  type RowAction,
  rowDetail,
  weightsText,
} from "@local-studio/local-ai-model";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import { PlanPreview } from "./PlanPreview";

export interface RowTarget {
  readonly peerId: string | null;
  readonly gpuKeys: ReadonlyArray<string>;
  readonly machineNames: ReadonlyArray<string>;
}

function ActionButton({
  action,
  busy,
  disabled,
  onRun,
  onPod,
  onSetup,
}: {
  readonly action: RowAction;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onRun: () => void;
  readonly onPod: () => void;
  readonly onSetup: () => void;
}) {
  switch (action.kind) {
    case "running":
      return <Badge variant="success">Running</Badge>;
    case "setup":
      return (
        <Button size="xs" variant="warning-outline" onClick={onSetup} data-action="setup">
          Needs setup
        </Button>
      );
    case "pod":
      return (
        <Button size="xs" onClick={onPod} disabled={disabled || !action.ready} data-action="pod">
          {busy ? "Starting…" : `Run pod of ${action.machines}`}
        </Button>
      );
    case "run":
      return (
        <Button
          size="xs"
          variant={action.stop ? "outline" : "default"}
          onClick={onRun}
          disabled={disabled || !action.ready}
          data-action={action.stop ? "stop-run" : "run"}
        >
          {busy ? "Starting…" : action.stop ? "Stop & run" : "Run"}
        </Button>
      );
  }
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

export function RecipeRowItem({
  environmentId,
  row,
  action,
  target,
  expanded,
  busy,
  disabled,
  onToggle,
  onRun,
  onPod,
}: {
  readonly environmentId: EnvironmentId;
  readonly row: SelectionRow;
  readonly action: RowAction;
  readonly target: RowTarget | null;
  readonly expanded: boolean;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly onRun: () => void;
  readonly onPod: () => void;
}) {
  const machines = row.machines ?? 1;
  return (
    <li
      className={cn("flex flex-col border-b last:border-b-0", expanded && "bg-muted/30")}
      data-testid="local-ai-recipe-row"
      data-recipe={row.id}
      data-action={action.kind === "run" && action.stop ? "stop-run" : action.kind}
    >
      <div className="flex min-w-0 items-center gap-3 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm text-foreground">{row.name}</span>
            <span className="truncate text-xs text-muted-foreground">{rowDetail(row)}</span>
          </span>
        </button>
        <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
          {row.proof?.tps ? `${fmt.tps(row.proof.tps)} tok/s` : ""}
        </span>
        <span className="flex w-32 shrink-0 justify-end">
          <ActionButton
            action={action}
            busy={busy}
            disabled={disabled}
            onRun={onRun}
            onPod={onPod}
            onSetup={() => {
              if (!expanded) onToggle();
            }}
          />
        </span>
      </div>
      {expanded ? (
        <div className="flex flex-col gap-3 px-3 pb-3 pl-8" data-testid="local-ai-recipe-detail">
          {action.kind === "setup" ? (
            <div
              className="rounded-md border border-warning/32 bg-warning-surface px-3 py-2 text-xs text-warning-foreground"
              data-testid="local-ai-setup-reason"
            >
              <span>{action.reason}</span>
              {row.publisher ? (
                <>
                  {" · "}
                  <a
                    className="underline underline-offset-2"
                    href={row.publisher}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Publisher setup
                  </a>
                </>
              ) : null}
            </div>
          ) : null}
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            <Fact label="Engine">{`${row.engine}${row.runtime === "host" ? " · native program" : " · container"}`}</Fact>
            <Fact label="Weights">{`${fmtFormat(row.format)}${row.weights[0] ? ` · ${row.weights[0].repository}` : ""} · ${weightsText(row)}`}</Fact>
            <Fact label="Proof">{proofText(row)}</Fact>
            {row.image ? <Fact label="Image">{row.image}</Fact> : null}
            {row.stops.length > 0 ? (
              <Fact label="Stops first">
                {row.stops
                  .map((stop) => `${stop.modelId ?? stop.state} on ${stop.gpuKeys.join(", ")}`)
                  .join(" · ")}
              </Fact>
            ) : null}
            {machines > 1 ? (
              <Fact label="Pod">
                {target && target.machineNames.length === machines
                  ? `${target.machineNames.join(" + ")}; the first one serves the API`
                  : `Pick GPUs on ${machines} machines`}
              </Fact>
            ) : null}
          </dl>
          {target && machines <= 1 ? (
            <PlanPreview
              environmentId={environmentId}
              peerId={target.peerId}
              recipeId={row.id}
              gpuKeys={target.gpuKeys}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
