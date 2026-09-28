import type { UsageColumn } from "@local-studio/local-ai-model";
import { formatTokens } from "@t3tools/shared/usageFormat";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";

const SERIES = [
  { key: "input", label: "Input", className: "bg-info/70" },
  { key: "cached", label: "Cached", className: "bg-success/60" },
  { key: "output", label: "Output", className: "bg-foreground/70" },
] as const;

export function TokenColumns({ columns }: { readonly columns: ReadonlyArray<UsageColumn> }) {
  const top = Math.max(1, ...columns.map((column) => column.input + column.cached + column.output));
  return (
    <div className="flex flex-col gap-2" data-testid="local-ai-usage-chart">
      <div className="flex h-36 items-end gap-px">
        {columns.map((column, index) => {
          const total = column.input + column.cached + column.output;
          return (
            <Tooltip key={`${column.label}-${index}`}>
              <TooltipTrigger
                render={
                  <div className="flex h-full min-w-0 flex-1 cursor-default flex-col-reverse rounded-sm hover:bg-muted/60">
                    {SERIES.map((series) => (
                      <div
                        key={series.key}
                        className={series.className}
                        style={{ height: `${(column[series.key] / top) * 100}%` }}
                      />
                    ))}
                  </div>
                }
              />
              <TooltipPopup side="top">
                {`${column.label} · ${formatTokens(total)} tokens · in ${formatTokens(column.input)} · cached ${formatTokens(column.cached)} · out ${formatTokens(column.output)}`}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
      <div className="flex justify-between text-2xs text-muted-foreground">
        <span>{columns[0]?.label ?? ""}</span>
        <span className="flex gap-3">
          {SERIES.map((series) => (
            <span key={series.key} className="flex items-center gap-1">
              <span className={`size-2 rounded-sm ${series.className}`} />
              {series.label}
            </span>
          ))}
        </span>
        <span>{columns.at(-1)?.label ?? ""}</span>
      </div>
    </div>
  );
}
