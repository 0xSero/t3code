import type {
  LaunchPhase,
  LaunchProgress,
  RecipeRow,
  SelectionRow,
  Snapshot,
} from "@local-studio/contracts/client";
import { fmt } from "@local-studio/contracts/client";

import type { MachineView } from "./view.ts";

export type GpuSelection = Readonly<Record<string, ReadonlyArray<string>>>;
export type SelectionEntry = readonly [machineId: string, gpuKeys: ReadonlyArray<string>];

export const ACTIVE_LAUNCH_PHASES: ReadonlyArray<LaunchPhase> = [
  "planning",
  "weights",
  "pulling",
  "starting",
  "loading",
];

export const isActiveLaunch = (launch: Pick<LaunchProgress, "phase">): boolean =>
  ACTIVE_LAUNCH_PHASES.includes(launch.phase);

export const LAUNCH_PHASE_LABEL: Record<LaunchPhase, string> = {
  planning: "Planning",
  weights: "Downloading weights",
  pulling: "Pulling image",
  starting: "Starting",
  loading: "Loading",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const LAUNCH_PHASE_ORDER: ReadonlyArray<LaunchPhase> = [
  "planning",
  "weights",
  "pulling",
  "starting",
  "loading",
  "ready",
];

export interface GpuChoice {
  readonly label: string;
  readonly free: boolean;
}

export const gpuChoice = (snapshot: Snapshot | null, key: string): GpuChoice => {
  const launch = snapshot?.launches.find(
    (item) => (item.gpuKeys ?? []).includes(key) && isActiveLaunch(item),
  );
  if (launch)
    return {
      label: `${launch.phase === "weights" ? "downloading" : "starting"} ${launch.recipeId.split(".")[0]}`,
      free: false,
    };
  const group = snapshot?.groups.find((item) => item.gpuKeys.includes(key));
  if (!group || group.state === "available") return { label: "free", free: true };
  if (group.state === "foreign") return { label: "other program", free: false };
  const names = (group.modelIds ?? []).map(
    (id) => snapshot?.models.find((model) => model.id === id)?.primaryModel ?? id,
  );
  return { label: names.join(", ") || group.state, free: false };
};

export const selectionEntries = (selection: GpuSelection): SelectionEntry[] =>
  Object.entries(selection)
    .filter(([, keys]) => keys.length > 0)
    .map(([machineId, keys]) => [machineId, keys] as const);

export const toggleGpu = (
  selection: GpuSelection,
  machineId: string,
  key: string,
): GpuSelection => {
  const current = selection[machineId] ?? [];
  return {
    ...selection,
    [machineId]: current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key].toSorted(),
  };
};

export const shortGpuName = (name: string): string =>
  name
    .replace(/ Blackwell Workstation Edition| Workstation Edition| Generation| Max-Q/g, "")
    .replace(/^NVIDIA /, "")
    .replace(/^RTX PRO/, "PRO");

export const selectionSummary = (
  ms: ReadonlyArray<MachineView>,
  entries: ReadonlyArray<SelectionEntry>,
): string =>
  entries
    .map(([id, keys]) => {
      const machine = ms.find((item) => item.id === id);
      const gpu = machine?.snap?.gpus.find((item) => item.key === keys[0]);
      return `${keys.length} × ${shortGpuName(gpu?.name ?? "GPU")} on ${machine?.name ?? id}`;
    })
    .join(" + ");

export const selectionHolders = (
  ms: ReadonlyArray<MachineView>,
  entries: ReadonlyArray<SelectionEntry>,
): string[] => [
  ...new Set(
    entries.flatMap(([id, keys]) => {
      const machine = ms.find((item) => item.id === id);
      if (!machine) return [];
      return keys
        .map((key) => gpuChoice(machine.snap, key))
        .filter((choice) => !choice.free)
        .map((choice) => choice.label);
    }),
  ),
];

export const needsSetup = (row: RecipeRow): string | null => {
  if (row.blocked) return row.blocked;
  if (row.weightsPresent === false && row.source === "local")
    return "Its weights are not on this machine, and a local config has no source to download them from.";
  return null;
};

export type RowAction =
  | { readonly kind: "running"; readonly modelId: string }
  | { readonly kind: "setup"; readonly reason: string }
  | { readonly kind: "pod"; readonly machines: number; readonly ready: boolean }
  | { readonly kind: "run"; readonly stop: boolean; readonly ready: boolean };

export const rowAction = (row: SelectionRow, chosenMachines: number): RowAction => {
  if (row.runningModelId) return { kind: "running", modelId: row.runningModelId };
  const reason = needsSetup(row);
  if (reason) return { kind: "setup", reason };
  const machines = row.machines ?? 1;
  if (machines > 1) return { kind: "pod", machines, ready: chosenMachines === machines };
  return { kind: "run", stop: row.fit === "busy", ready: chosenMachines === 1 };
};

export const proofText = (row: RecipeRow): string => {
  const proof = row.proof;
  if (!proof) return row.origin === "yours" ? "your config" : "–";
  const tps = proof.tps ? `${fmt.tps(proof.tps)} tok/s · ` : "";
  if (proof.reported) return `${tps}reported by ${proof.on}`;
  const gates = proof.gates.split(/\s+/).filter(Boolean).length;
  const where = proof.on === "vast" ? "rented GPU" : proof.on === "legacy" ? "older run" : proof.on;
  return `${tps}${gates === 6 ? "all 6 checks" : `${gates} of 6 checks`} · ${where}`;
};

export const weightsText = (row: RecipeRow): string => {
  if (row.weightsPresent === null) return "–";
  if (row.weightsPresent) return "on this machine";
  return row.source === "local" ? "missing" : "downloads on first run";
};

export const rowDetail = (row: RecipeRow): string =>
  [
    row.engine,
    `${fmt.ctx(row.ctxTokens)} context`,
    row.sizeGb ? `${Math.round(row.sizeGb)} GB` : null,
    (row.machines ?? 1) > 1 ? `${row.machines} machines` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

export const matchesFilter = (row: RecipeRow, query: string): boolean =>
  query.trim() === "" ||
  `${row.name} ${row.engine} ${row.format} ${row.id}`
    .toLowerCase()
    .includes(query.trim().toLowerCase());

export const initialSelection = (
  ms: ReadonlyArray<MachineView>,
  machineId: string | null,
  gpus: string | null,
): GpuSelection => {
  const machine = ms.find((item) => item.id === machineId);
  if (!machine) return {};
  const keys = gpus
    ? gpus.split(",").filter(Boolean)
    : [
        ...new Set(
          (machine.snap?.groups ?? [])
            .filter((group) => group.state === "available")
            .flatMap((group) => group.gpuKeys),
        ),
      ].toSorted();
  return { [machine.id]: keys };
};

export interface TrackedLaunch {
  readonly machineId: string;
  readonly peerId: string | null;
  readonly progress: LaunchProgress;
}

export const withTrackedLaunches = (
  ms: ReadonlyArray<MachineView>,
  tracked: ReadonlyArray<TrackedLaunch>,
): MachineView[] =>
  ms.map((machine) => {
    const own = tracked.filter((item) => item.machineId === machine.id);
    if (!machine.snap || own.length === 0) return machine;
    const map = new Map(machine.snap.launches.map((item) => [item.launchId, item]));
    for (const item of own) {
      const previous = map.get(item.progress.launchId);
      if (!previous || previous.updatedAt <= item.progress.updatedAt)
        map.set(item.progress.launchId, item.progress);
    }
    return { ...machine, snap: { ...machine.snap, launches: [...map.values()] } };
  });

export const gatewayUrlOf = (machine: MachineView): string | null => {
  const snapshot = machine.snap;
  if (!snapshot?.machine.url) return null;
  return `${rewriteLoopback(snapshot.machine.url, snapshot.machine.hostname).replace(/\/+$/, "")}/v1`;
};

export const rewriteLoopback = (url: string, host: string | null | undefined): string =>
  host
    ? url.replace(/\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1?\])(?=[:/]|$)/, `//${host}`)
    : url;

export const isLoopbackBind = (bind: string): boolean =>
  bind === "127.0.0.1" || bind === "::1" || bind === "localhost";

export const endpointUrl = (
  bind: string,
  port: number,
  host: string | null | undefined,
): string => {
  const wildcard = bind === "0.0.0.0" || bind === "*" || bind === "::" || bind === "";
  const target =
    wildcard || isLoopbackBind(bind)
      ? (host ?? "127.0.0.1")
      : bind.includes(":")
        ? `[${bind}]`
        : bind;
  return `http://${target}:${port}`;
};
