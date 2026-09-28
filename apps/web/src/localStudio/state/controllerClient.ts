import type { ControllerEvent, ControllerEventType } from "@local-studio/contracts/client";
import type { EnvironmentId } from "@t3tools/contracts";

const LOCAL_STUDIO_PROXY_PREFIX = "/api/local-studio";

export function controllerFetch<T>(
  environmentId: EnvironmentId,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const method = init?.method ?? "GET";
  return Promise.reject(
    new Error(
      `Local Studio controller is not connected for ${environmentId} (${method} ${LOCAL_STUDIO_PROXY_PREFIX}${path})`,
    ),
  );
}

export function controllerEvents(
  _environmentId: EnvironmentId,
  _types: ReadonlyArray<ControllerEventType>,
  _onEvent: (event: ControllerEvent) => void,
): () => void {
  return () => {};
}
