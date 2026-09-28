import {
  gpuChoice,
  type GpuSelection,
  isSpark,
  type MachineView,
  shortGpuName,
} from "@local-studio/local-ai-model";

import { Button } from "../../../components/ui/button";
import { Toggle } from "../../../components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { cn } from "../../../lib/utils";

interface PickerGroup {
  readonly name: string;
  readonly members: ReadonlyArray<MachineView>;
}

const groupsOf = (ms: ReadonlyArray<MachineView>): PickerGroup[] => {
  const withGpus = ms.filter((m) => m.online && (m.snap?.gpus.length ?? 0) > 0);
  const sparks = withGpus.filter(isSpark);
  return [
    ...withGpus.filter((m) => !isSpark(m)).map((m) => ({ name: m.name, members: [m] })),
    ...(sparks.length ? [{ name: "DGX Sparks", members: sparks }] : []),
  ];
};

export function GpuPicker({
  machines,
  selection,
  onToggle,
  onSelectFree,
  onClear,
}: {
  readonly machines: ReadonlyArray<MachineView>;
  readonly selection: GpuSelection;
  readonly onToggle: (machine: MachineView, key: string) => void;
  readonly onSelectFree: (machine: MachineView) => void;
  readonly onClear: () => void;
}) {
  const groups = groupsOf(machines);
  if (groups.length === 0)
    return <p className="text-xs text-muted-foreground">No machine in the fleet reports a GPU.</p>;
  return (
    <div className="flex flex-col gap-4" data-testid="local-ai-gpu-picker">
      {groups.map((group) => (
        <div key={group.name} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground">{group.name}</span>
            {group.members.length === 1 && group.members[0] ? (
              <Button
                size="micro"
                variant="ghost-muted"
                onClick={() => group.members[0] && onSelectFree(group.members[0])}
              >
                Pick free GPUs
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {group.members.flatMap((machine) =>
              (machine.snap?.gpus ?? []).map((gpu) => {
                const choice = gpuChoice(machine.snap, gpu.key);
                const pressed = (selection[machine.id] ?? []).includes(gpu.key);
                const label =
                  group.members.length > 1
                    ? machine.name.replace(/^spark-/, "")
                    : `${shortGpuName(gpu.name)} ${gpu.index}`;
                return (
                  <div
                    key={`${machine.id}/${gpu.key}`}
                    className="flex w-32 flex-col gap-1"
                    data-testid="local-ai-gpu-chip"
                    data-machine={machine.name}
                    data-gpu={gpu.key}
                    data-free={choice.free ? "true" : "false"}
                    data-selected={pressed ? "true" : "false"}
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Toggle
                            variant="outline"
                            size="sm"
                            pressed={pressed}
                            onPressedChange={() => onToggle(machine, gpu.key)}
                            aria-label={`${machine.name} ${gpu.key}`}
                          >
                            {label}
                          </Toggle>
                        }
                      />
                      <TooltipPopup side="bottom">{`${machine.name} · ${gpu.product || gpu.name} · ${choice.label}`}</TooltipPopup>
                    </Tooltip>
                    <span
                      className={cn(
                        "truncate text-2xs",
                        choice.free ? "text-success-foreground" : "text-muted-foreground",
                      )}
                    >
                      {choice.label}
                    </span>
                  </div>
                );
              }),
            )}
          </div>
        </div>
      ))}
      <div>
        <Button size="xs" variant="ghost-muted" onClick={onClear}>
          Clear selection
        </Button>
      </div>
    </div>
  );
}
