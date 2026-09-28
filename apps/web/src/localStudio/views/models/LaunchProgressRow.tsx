import type { LaunchProgress } from "@local-studio/contracts/client";
import { fmt } from "@local-studio/contracts/client";
import {
  isActiveLaunch,
  LAUNCH_PHASE_LABEL,
  LAUNCH_PHASE_ORDER,
} from "@local-studio/local-ai-model";

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import { Meter } from "../machines/Meter";

const PHASE_BADGE = {
  ready: "success",
  failed: "error",
  cancelled: "secondary",
} as const;

export function LaunchProgressRow({
  name,
  machine,
  progress,
  busy,
  readOnly,
  onCancel,
  onDismiss,
}: {
  readonly name: string;
  readonly machine: string;
  readonly progress: LaunchProgress;
  readonly busy: boolean;
  readonly readOnly: boolean;
  readonly onCancel: () => void;
  readonly onDismiss: (() => void) | null;
}) {
  const active = isActiveLaunch(progress);
  const reached = LAUNCH_PHASE_ORDER.indexOf(progress.phase);
  const badge =
    progress.phase === "ready" || progress.phase === "failed" || progress.phase === "cancelled"
      ? PHASE_BADGE[progress.phase]
      : "info";
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border px-3 py-2.5"
      data-testid="local-ai-launch"
      data-launch={progress.launchId}
      data-phase={progress.phase}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 truncate text-sm text-foreground">{name}</span>
        <span className="text-xs text-muted-foreground">{machine}</span>
        <Badge variant={badge} data-testid="local-ai-launch-phase">
          {LAUNCH_PHASE_LABEL[progress.phase]}
        </Badge>
        <span className="text-xs text-muted-foreground tabular-nums">
          {fmt.ms(progress.updatedAt - progress.startedAt)}
        </span>
        <span className="ms-auto flex items-center gap-2">
          {active ? (
            <Button
              size="xs"
              variant="destructive-outline"
              onClick={onCancel}
              disabled={busy || readOnly}
            >
              {busy ? "Cancelling…" : "Cancel"}
            </Button>
          ) : onDismiss ? (
            <Button size="xs" variant="ghost-muted" onClick={onDismiss}>
              Dismiss
            </Button>
          ) : null}
        </span>
      </div>
      <ol className="flex flex-wrap gap-1 text-2xs" aria-label="Launch phases">
        {LAUNCH_PHASE_ORDER.map((phase, index) => (
          <li
            key={phase}
            className={cn(
              "rounded-sm px-1.5 py-0.5",
              index < reached || progress.phase === "ready"
                ? "bg-muted text-foreground"
                : index === reached
                  ? "bg-info/12 text-info-foreground"
                  : "text-muted-foreground",
            )}
          >
            {LAUNCH_PHASE_LABEL[phase]}
          </li>
        ))}
      </ol>
      {active && progress.percent !== null ? (
        <Meter pct={progress.percent} label={`${name} launch progress`} />
      ) : null}
      {progress.detail ? (
        <p className="truncate text-xs text-muted-foreground">
          {progress.detail}
          {progress.percent !== null && active ? ` · ${Math.round(progress.percent)}%` : ""}
        </p>
      ) : null}
      {progress.error ? (
        <p className="text-xs text-destructive-foreground">{progress.error}</p>
      ) : null}
    </div>
  );
}
