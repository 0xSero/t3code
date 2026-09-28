import { useAtomValue } from "@effect/atom-react";
import type {
  ControllerHealth,
  FleetSnapshot,
  GpuSample,
  HourlyRow,
  MetricsSummary,
  RecipeRow,
  RequestRecord,
  Snapshot,
  TtftHour,
} from "@local-studio/contracts/client";
import {
  applyFleet,
  applyRequests,
  applySnapshot,
  initialLocalAiState,
  LOCAL_AI_EVENT_TYPES,
  LOCAL_AI_POLLING,
  onEvent,
  via,
  type LocalAiState,
} from "@local-studio/local-ai-model";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { type ControllerConnection, controllerEvents, controllerFetch } from "./controllerClient";

export interface MachineStats {
  readonly summary: MetricsSummary | null;
  readonly health: ControllerHealth | null;
  readonly hourly: ReadonlyArray<HourlyRow>;
  readonly ttft: ReadonlyArray<TtftHour>;
  readonly gpus: ReadonlyArray<GpuSample>;
  readonly gpusAt: number;
  readonly requests: ReadonlyArray<RequestRecord>;
}

export interface LocalAiStore {
  readonly model: LocalAiState;
  readonly connection: ControllerConnection;
  readonly retryMs: number | null;
  readonly error: string | null;
  readonly loaded: boolean;
  readonly recipes: Readonly<Record<string, ReadonlyArray<RecipeRow> | null>>;
  readonly stats: Readonly<Record<string, MachineStats>>;
  readonly fresh: ReadonlySet<string>;
}

const initialStore: LocalAiStore = {
  model: initialLocalAiState,
  connection: "connecting",
  retryMs: null,
  error: null,
  loaded: false,
  recipes: {},
  stats: {},
  fresh: new Set(),
};

const localAiStoreAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<LocalAiStore>(initialStore).pipe(
    Atom.keepAlive,
    Atom.withLabel(`local-ai-store:${environmentId}`),
  ),
);

const update = (environmentId: EnvironmentId, f: (store: LocalAiStore) => LocalAiStore) =>
  appAtomRegistry.update(localAiStoreAtom(environmentId), f);

const read = (environmentId: EnvironmentId) => appAtomRegistry.get(localAiStoreAtom(environmentId));

const settle = async <T>(promise: Promise<T>): Promise<T | null> => {
  try {
    return await promise;
  } catch {
    return null;
  }
};

const arrayOf = <T>(value: unknown): ReadonlyArray<T> => (Array.isArray(value) ? value : []);

const onlineMachines = (fleet: FleetSnapshot | null) =>
  (fleet?.machines ?? []).filter((machine) => machine.online);

async function loadRecipes(
  environmentId: EnvironmentId,
  machineId: string,
  peerId: string | null,
): Promise<void> {
  const rows = await settle(
    controllerFetch<RecipeRow[]>(environmentId, via(peerId, "/api/recipes")),
  );
  update(environmentId, (store) => ({
    ...store,
    recipes: { ...store.recipes, [machineId]: Array.isArray(rows) ? rows : null },
  }));
}

async function loadStats(environmentId: EnvironmentId): Promise<void> {
  const fleet = read(environmentId).model.fleet;
  if (!fleet) return;
  const now = Date.now();
  const hourFrom = Math.floor(now / 3_600_000) * 3_600_000 - 23 * 3_600_000;
  await Promise.all(
    onlineMachines(fleet).map(async (machine) => {
      const peerId = machine.peerId;
      const previous = read(environmentId).stats[machine.machineId];
      const gpuDue = !previous || now - previous.gpusAt > LOCAL_AI_POLLING.gpuHistoryMs;
      const get = <T>(path: string) => settle(controllerFetch<T>(environmentId, via(peerId, path)));
      const [summary, health, hourly, ttft, gpus, requests] = await Promise.all([
        get<MetricsSummary>("/api/metrics/summary?window=24h"),
        get<ControllerHealth>("/api/health/detail"),
        get<HourlyRow[]>(`/api/usage/hourly?from=${hourFrom}`),
        get<TtftHour[]>(`/api/metrics/ttft?from=${hourFrom}`),
        gpuDue ? get<GpuSample[]>(`/api/metrics/gpus?from=${now - 86_400_000}`) : null,
        peerId ? get<RequestRecord[]>("/api/metrics/requests?limit=50") : null,
      ]);
      const stats: MachineStats = {
        summary: summary && typeof summary.requests === "number" ? summary : null,
        health: health?.memory ? health : null,
        hourly: arrayOf<HourlyRow>(hourly),
        ttft: arrayOf<TtftHour>(ttft),
        gpus: gpuDue ? arrayOf<GpuSample>(gpus) : (previous?.gpus ?? []),
        gpusAt: gpuDue ? now : (previous?.gpusAt ?? 0),
        requests: arrayOf<RequestRecord>(requests),
      };
      update(environmentId, (store) => ({
        ...store,
        stats: { ...store.stats, [machine.machineId]: stats },
      }));
    }),
  );
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function reloadLocalAi(environmentId: EnvironmentId): Promise<void> {
  const [fleet, snapshot, requests] = await Promise.allSettled([
    controllerFetch<FleetSnapshot>(environmentId, "/api/fleet"),
    controllerFetch<Snapshot>(environmentId, "/api/snapshot"),
    controllerFetch<RequestRecord[]>(environmentId, "/api/metrics/requests?limit=200"),
  ]);
  update(environmentId, (store) => {
    let model = store.model;
    if (fleet.status === "fulfilled" && Array.isArray(fleet.value?.machines))
      model = applyFleet(model, fleet.value);
    if (snapshot.status === "fulfilled" && snapshot.value?.machine)
      model = applySnapshot(model, snapshot.value);
    if (requests.status === "fulfilled" && Array.isArray(requests.value))
      model = applyRequests(model, requests.value);
    const error =
      fleet.status === "rejected" && snapshot.status === "rejected"
        ? errorText(snapshot.reason)
        : null;
    return { ...store, model, error, loaded: true };
  });
  const current = read(environmentId).model.fleet;
  await Promise.all([
    ...onlineMachines(current).map((machine) =>
      loadRecipes(environmentId, machine.machineId, machine.peerId),
    ),
    loadStats(environmentId),
  ]);
}

const markFresh = (environmentId: EnvironmentId, id: string) => {
  update(environmentId, (store) => ({ ...store, fresh: new Set(store.fresh).add(id) }));
  setTimeout(() => {
    update(environmentId, (store) => {
      if (!store.fresh.has(id)) return store;
      const fresh = new Set(store.fresh);
      fresh.delete(id);
      return { ...store, fresh };
    });
  }, LOCAL_AI_POLLING.freshRequestMs);
};

function startSession(environmentId: EnvironmentId): () => void {
  let wasDown = false;
  void reloadLocalAi(environmentId);
  const stopEvents = controllerEvents(
    environmentId,
    LOCAL_AI_EVENT_TYPES,
    (event) => {
      update(environmentId, (store) => ({
        ...store,
        model: onEvent(store.model, event),
        error: null,
      }));
      if (event.type === "request") markFresh(environmentId, event.data.id);
    },
    (connection, retryMs) => {
      update(environmentId, (store) => ({ ...store, connection, retryMs }));
      if (connection === "live" && wasDown) void reloadLocalAi(environmentId);
      if (connection === "retrying") wasDown = true;
      else if (connection === "live") wasDown = false;
    },
  );
  const statsTimer = setInterval(() => void loadStats(environmentId), LOCAL_AI_POLLING.statsMs);
  const recipesTimer = setInterval(() => {
    for (const machine of onlineMachines(read(environmentId).model.fleet))
      void loadRecipes(environmentId, machine.machineId, machine.peerId);
  }, LOCAL_AI_POLLING.recipesMs);
  return () => {
    stopEvents();
    clearInterval(statsTimer);
    clearInterval(recipesTimer);
  };
}

const sessions = new Map<EnvironmentId, { count: number; stop: () => void }>();

function acquireSession(environmentId: EnvironmentId): () => void {
  const existing = sessions.get(environmentId);
  if (existing) existing.count += 1;
  else sessions.set(environmentId, { count: 1, stop: startSession(environmentId) });
  return () => {
    const session = sessions.get(environmentId);
    if (!session) return;
    session.count -= 1;
    if (session.count > 0) return;
    session.stop();
    sessions.delete(environmentId);
  };
}

export function restartLocalAi(environmentId: EnvironmentId): void {
  const session = sessions.get(environmentId);
  if (!session) return;
  session.stop();
  session.stop = startSession(environmentId);
}

const EMPTY_STORE_ATOM = Atom.make<LocalAiStore>(initialStore).pipe(
  Atom.withLabel("local-ai-store:empty"),
);

export function useLocalAi(environmentId: EnvironmentId | null): LocalAiStore {
  useEffect(
    () => (environmentId === null ? undefined : acquireSession(environmentId)),
    [environmentId],
  );
  return useAtomValue(environmentId === null ? EMPTY_STORE_ATOM : localAiStoreAtom(environmentId));
}
