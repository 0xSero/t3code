import type { Gpu, Snapshot } from "@local-studio/contracts/client";
import { gpuRow } from "@local-studio/local-ai-model";

import { cn } from "../../../lib/utils";
import { Meter } from "./Meter";

export function GpuTile({
  gpu,
  index,
  snapshot,
  online,
}: {
  readonly gpu: Gpu;
  readonly index: number;
  readonly snapshot: Snapshot | null;
  readonly online: boolean;
}) {
  const row = gpuRow(gpu, snapshot);
  const util = online ? gpu.utilPct : null;
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 p-3"
      data-testid="local-ai-gpu"
      data-gpu-key={gpu.key}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="truncate text-sm text-foreground">{row.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {`#${index}`}
          {row.temp ? ` · ${row.temp}` : ""}
        </span>
      </div>
      <div className="grid gap-1">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">Utilization</span>
          <span className="text-foreground tabular-nums" data-testid="local-ai-gpu-util">
            {util === null ? "–" : `${Math.round(util)}%`}
          </span>
        </div>
        <Meter pct={util} label={`${row.name} #${index} utilization`} />
      </div>
      <div className="grid gap-1">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">Memory</span>
          <span className="text-foreground tabular-nums" data-testid="local-ai-gpu-mem">
            {row.mem}
          </span>
        </div>
        <Meter pct={online ? row.pct : null} label={`${row.name} #${index} memory`} />
      </div>
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
        <span
          className={cn(
            "truncate",
            row.statusAlert ? "text-warning-foreground" : "text-muted-foreground",
          )}
        >
          {row.status || "free"}
        </span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {gpu.powerW === null ? "–" : `${Math.round(gpu.powerW)} W`}
        </span>
      </div>
    </div>
  );
}
