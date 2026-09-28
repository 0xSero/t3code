import { useAtomValue } from "@effect/atom-react";
import type { LaunchProgress } from "@local-studio/contracts/client";
import { isActiveLaunch, type TrackedLaunch, via } from "@local-studio/local-ai-model";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../../../rpc/atomRegistry";
import { controllerFetch, controllerJson } from "../../state/controllerClient";

const PEER_POLL_MS = 2_000;

const trackedLaunchesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<ReadonlyArray<TrackedLaunch>>([]).pipe(
    Atom.keepAlive,
    Atom.withLabel(`local-ai-launches:${environmentId}`),
  ),
);

const pollers = new Map<string, ReturnType<typeof setInterval>>();

const put = (environmentId: EnvironmentId, entry: TrackedLaunch) =>
  appAtomRegistry.update(trackedLaunchesAtom(environmentId), (list) => {
    const previous = list.find((item) => item.progress.launchId === entry.progress.launchId);
    if (previous && previous.progress.updatedAt > entry.progress.updatedAt) return list;
    return [entry, ...list.filter((item) => item.progress.launchId !== entry.progress.launchId)];
  });

const stopPolling = (launchId: string) => {
  const timer = pollers.get(launchId);
  if (timer !== undefined) clearInterval(timer);
  pollers.delete(launchId);
};

const pollPeer = (environmentId: EnvironmentId, entry: TrackedLaunch) => {
  if (entry.peerId === null || pollers.has(entry.progress.launchId)) return;
  const timer = setInterval(() => {
    void controllerFetch<LaunchProgress[]>(environmentId, via(entry.peerId, "/api/launches")).then(
      (list) => {
        const next = Array.isArray(list)
          ? list.find((item) => item.launchId === entry.progress.launchId)
          : undefined;
        if (next) put(environmentId, { ...entry, progress: next });
        if (!next || !isActiveLaunch(next)) stopPolling(entry.progress.launchId);
      },
      () => undefined,
    );
  }, PEER_POLL_MS);
  pollers.set(entry.progress.launchId, timer);
};

export function trackLaunch(environmentId: EnvironmentId, entry: TrackedLaunch): void {
  put(environmentId, entry);
  if (isActiveLaunch(entry.progress)) pollPeer(environmentId, entry);
}

export function dismissLaunch(environmentId: EnvironmentId, launchId: string): void {
  stopPolling(launchId);
  appAtomRegistry.update(trackedLaunchesAtom(environmentId), (list) =>
    list.filter((item) => item.progress.launchId !== launchId),
  );
}

export async function cancelLaunch(
  environmentId: EnvironmentId,
  peerId: string | null,
  launchId: string,
): Promise<void> {
  await controllerFetch<unknown>(
    environmentId,
    via(peerId, `/api/launches/${encodeURIComponent(launchId)}/cancel`),
    controllerJson("POST"),
  );
}

const EMPTY_ATOM = Atom.make<ReadonlyArray<TrackedLaunch>>([]).pipe(
  Atom.withLabel("local-ai-launches:empty"),
);

export function useTrackedLaunches(
  environmentId: EnvironmentId | null,
): ReadonlyArray<TrackedLaunch> {
  return useAtomValue(environmentId === null ? EMPTY_ATOM : trackedLaunchesAtom(environmentId));
}
