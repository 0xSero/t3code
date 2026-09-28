import { type MachineView, powerText, resOf, resText } from "@local-studio/local-ai-model";
import type { ReactNode } from "react";

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { GpuTile } from "./GpuTile";

const MARK_BADGE = {
  ready: { variant: "success", label: "Serving" },
  busy: { variant: "info", label: "Loading" },
  failed: { variant: "error", label: "Needs attention" },
} as const;

export function MachineSection({
  machine,
  onRemove,
  action,
}: {
  readonly machine: MachineView;
  readonly onRemove: ((machine: MachineView) => void) | null;
  readonly action?: ReactNode;
}) {
  const snapshot = machine.snap;
  const host = snapshot?.host ?? null;
  const resources = resOf(machine);
  const mark = machine.mark === "" ? null : MARK_BADGE[machine.mark];
  const facts: ReadonlyArray<readonly [string, string]> = [
    [
      "CPU",
      host
        ? `${host.cpu.model} · ${host.cpu.threads} threads${host.cpu.utilPct === null ? "" : ` · ${Math.round(host.cpu.utilPct)}%`}`
        : "–",
    ],
    ["RAM free", resText(resources.ram)],
    [resources.vram ? "VRAM free" : "Unified free", resText(resources.vram ?? resources.unified)],
    ["Disk free", resText(resources.disk)],
  ];

  return (
    <section
      className="flex flex-col gap-3"
      data-testid="local-ai-machine"
      data-machine-id={machine.id}
      data-online={machine.online ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium text-foreground">{machine.name}</h2>
        <Badge variant={machine.online ? "success" : "error"} data-testid="local-ai-machine-state">
          {machine.online ? "Online" : "Offline"}
        </Badge>
        {machine.self ? <Badge variant="outline">This controller</Badge> : null}
        {machine.readOnly ? <Badge variant="outline">Read only</Badge> : null}
        {mark ? <Badge variant={mark.variant}>{mark.label}</Badge> : null}
        <span className="text-xs text-muted-foreground tabular-nums">
          {machine.online ? `${machine.gpuSummary} · ${powerText([machine])}` : "not answering"}
        </span>
        <div className="ms-auto flex items-center gap-2">
          {action}
          {onRemove && machine.peerId ? (
            <Button size="xs" variant="ghost" onClick={() => onRemove(machine)}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>
      {machine.error ? (
        <p className="text-xs text-destructive-foreground">{machine.error}</p>
      ) : null}
      {snapshot && snapshot.gpus.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {snapshot.gpus.map((gpu, index) => (
            <GpuTile
              key={gpu.key}
              gpu={gpu}
              index={index}
              snapshot={snapshot}
              online={machine.online}
            />
          ))}
        </div>
      ) : machine.online ? (
        <p className="text-xs text-muted-foreground">No GPU reported.</p>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-4">
        {facts.map(([label, value]) => (
          <div key={label} className="flex min-w-0 flex-col">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate text-foreground tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
