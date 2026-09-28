import type {
  ControllerEvent,
  EngineRates,
  FleetSnapshot,
  LaunchProgress,
  RequestRecord,
  Snapshot,
} from "@local-studio/contracts/client";
import { normalizeSnapshot } from "@local-studio/contracts/client";

export type EngineHistKey = "dec" | "pre" | "ttft" | "kv" | "hit" | "spec";
export type EngineHist = Record<EngineHistKey, ReadonlyArray<number | null>>;

export interface LocalAiState {
  readonly snapshot: Snapshot | null;
  readonly fleet: FleetSnapshot | null;
  readonly updatedAt: number | null;
  readonly launches: Readonly<Record<string, LaunchProgress>>;
  readonly engines: Readonly<Record<string, EngineRates>>;
  readonly requests: ReadonlyArray<RequestRecord>;
  readonly hist: Readonly<Record<string, ReadonlyArray<number>>>;
  readonly ehist: Readonly<Record<string, EngineHist>>;
}

export const GPU_HISTORY_POINTS = 90;
export const ENGINE_HISTORY_POINTS = 60;
export const REQUEST_BUFFER = 500;

export const LOCAL_AI_POLLING = {
  statsMs: 10_000,
  recipesMs: 60_000,
  gpuHistoryMs: 55_000,
  eventsMinBackoffMs: 1_000,
  eventsMaxBackoffMs: 15_000,
  requestTimeoutMs: 15_000,
  freshRequestMs: 1_500,
} as const;

export const LOCAL_AI_EVENT_TYPES = ["snapshot", "fleet", "request", "launch", "engine"] as const;

export const nextEventsBackoff = (delayMs: number): number =>
  Math.min(delayMs * 2, LOCAL_AI_POLLING.eventsMaxBackoffMs);

export const initialLocalAiState: LocalAiState = {
  snapshot: null,
  fleet: null,
  updatedAt: null,
  launches: {},
  engines: {},
  requests: [],
  hist: {},
  ehist: {},
};

const list = <T>(value: ReadonlyArray<T> | null | undefined): T[] =>
  Array.isArray(value) ? [...value] : [];

const fleetFromSnapshot = (snapshot: Snapshot): FleetSnapshot => ({
  at: snapshot.at,
  self: snapshot.machine.machineId,
  machines: [
    {
      machineId: snapshot.machine.machineId,
      peerId: null,
      online: true,
      error: null,
      snapshot,
    },
  ],
  peers: [],
  activity: snapshot.activity,
  harnesses: [],
  sessions: [],
});

const trackGpus = (
  hist: LocalAiState["hist"],
  machines: FleetSnapshot["machines"],
): LocalAiState["hist"] => {
  const next: Record<string, ReadonlyArray<number>> = { ...hist };
  for (const machine of machines) {
    for (const gpu of machine.snapshot?.gpus ?? []) {
      if (gpu.utilPct === null) continue;
      const key = `${machine.machineId}/${gpu.key}`;
      next[key] = [...(next[key] ?? []), gpu.utilPct].slice(-GPU_HISTORY_POINTS);
    }
  }
  return next;
};

const pickRates = (rates: EngineRates): Record<EngineHistKey, number | null> => ({
  dec: rates.decodeTps ?? rates.generationTpsWall,
  pre: rates.prefillTps ?? rates.promptTpsWall,
  ttft: rates.meanTtftMs,
  kv: rates.kvCacheUsage === null ? null : rates.kvCacheUsage * 100,
  hit: rates.prefixHitRate === null ? null : rates.prefixHitRate * 100,
  spec: rates.specAcceptLength,
});

export const ENGINE_HISTORY_KEYS: ReadonlyArray<EngineHistKey> = [
  "dec",
  "pre",
  "ttft",
  "kv",
  "hit",
  "spec",
];

const trackEngines = (
  ehist: LocalAiState["ehist"],
  machines: FleetSnapshot["machines"],
): LocalAiState["ehist"] => {
  const next: Record<string, EngineHist> = { ...ehist };
  for (const machine of machines) {
    for (const rates of machine.snapshot?.engines ?? []) {
      const key = `${machine.machineId}/${rates.modelId}`;
      const values = pickRates(rates);
      const previous = next[key];
      next[key] = {
        dec: [...(previous?.dec ?? []), values.dec].slice(-ENGINE_HISTORY_POINTS),
        pre: [...(previous?.pre ?? []), values.pre].slice(-ENGINE_HISTORY_POINTS),
        ttft: [...(previous?.ttft ?? []), values.ttft].slice(-ENGINE_HISTORY_POINTS),
        kv: [...(previous?.kv ?? []), values.kv].slice(-ENGINE_HISTORY_POINTS),
        hit: [...(previous?.hit ?? []), values.hit].slice(-ENGINE_HISTORY_POINTS),
        spec: [...(previous?.spec ?? []), values.spec].slice(-ENGINE_HISTORY_POINTS),
      };
    }
  }
  return next;
};

export const applySnapshot = (state: LocalAiState, raw: Snapshot): LocalAiState => {
  const snapshot = normalizeSnapshot(raw);
  if (!snapshot) return state;
  const entry = {
    machineId: snapshot.machine.machineId,
    peerId: null,
    online: true,
    error: null,
    snapshot,
  };
  const current = state.fleet;
  const fleet: FleetSnapshot = current
    ? (() => {
        const self = current.self || snapshot.machine.machineId;
        const selfEntry = { ...entry, machineId: self };
        const has = current.machines.some((machine) => machine.machineId === self);
        const machines = has
          ? current.machines.map((machine) =>
              machine.machineId === self ? { ...machine, ...selfEntry } : machine,
            )
          : [selfEntry, ...current.machines];
        return { ...current, self, machines, at: Math.max(current.at, snapshot.at) };
      })()
    : fleetFromSnapshot(snapshot);
  return {
    ...state,
    snapshot,
    fleet,
    updatedAt: Math.max(state.updatedAt ?? 0, snapshot.at),
    hist: trackGpus(state.hist, [entry]),
    ehist: trackEngines(state.ehist, [entry]),
  };
};

export const applyFleet = (state: LocalAiState, raw: FleetSnapshot): LocalAiState => {
  const incoming: FleetSnapshot = {
    ...raw,
    peers: list(raw.peers),
    machines: list(raw.machines).map((machine) => ({
      ...machine,
      snapshot: normalizeSnapshot(machine.snapshot),
    })),
  };
  const previousSelf = state.fleet?.machines.find(
    (machine) => machine.machineId === incoming.self && machine.peerId === null,
  );
  const has = incoming.machines.some((machine) => machine.machineId === incoming.self);
  const machines = has || !previousSelf ? incoming.machines : [previousSelf, ...incoming.machines];
  const peers = incoming.machines.filter((machine) => machine.peerId !== null);
  const selfSnapshot =
    machines.find((machine) => machine.machineId === incoming.self && machine.peerId === null)
      ?.snapshot ?? state.snapshot;
  return {
    ...state,
    fleet: { ...incoming, machines },
    snapshot: selfSnapshot,
    updatedAt: Math.max(state.updatedAt ?? 0, incoming.at),
    hist: trackGpus(state.hist, peers),
    ehist: trackEngines(state.ehist, peers),
  };
};

export const applyRequests = (
  state: LocalAiState,
  requests: ReadonlyArray<RequestRecord>,
): LocalAiState => ({ ...state, requests: requests.slice(0, REQUEST_BUFFER) });

export const onEvent = (state: LocalAiState, event: ControllerEvent): LocalAiState => {
  switch (event.type) {
    case "snapshot":
      return applySnapshot(state, event.data);
    case "fleet":
      return applyFleet(state, event.data);
    case "request":
      return {
        ...state,
        requests: [
          event.data,
          ...state.requests.filter((request) => request.id !== event.data.id),
        ].slice(0, REQUEST_BUFFER),
      };
    case "launch":
      return { ...state, launches: { ...state.launches, [event.data.launchId]: event.data } };
    case "engine":
      return { ...state, engines: { ...state.engines, [event.data.modelId]: event.data } };
    default:
      return state;
  }
};

export const via = (peerId: string | null, path: string): string =>
  peerId ? `/api/peers/${encodeURIComponent(peerId)}${path}` : path;
