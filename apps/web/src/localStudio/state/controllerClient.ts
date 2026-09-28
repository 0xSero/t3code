import type { ControllerEvent, ControllerEventType } from "@local-studio/contracts/client";
import { LOCAL_AI_POLLING, nextEventsBackoff } from "@local-studio/local-ai-model";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSession } from "../../state/session";

const LOCAL_STUDIO_PROXY_PREFIX = "/api/local-studio";
const ACCESS_TIMEOUT_MS = 10_000;

export type ControllerConnection = "connecting" | "live" | "retrying";

const controllerAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: LOCAL_STUDIO_PROXY_PREFIX });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`local-studio-access:${environmentId}`)),
);

function resolveAccess(environmentId: EnvironmentId): Promise<DeviceHubAccess> {
  return new Promise((resolve, reject) => {
    const atom = controllerAccessAtom(environmentId);
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
      queueMicrotask(() => unsubscribe?.());
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("The environment connection is not ready."))),
      ACCESS_TIMEOUT_MS,
    );
    const check = (result: AsyncResult.AsyncResult<DeviceHubAccess, unknown>) => {
      if (AsyncResult.isSuccess(result)) finish(() => resolve(result.value));
      else if (AsyncResult.isFailure(result) && !result.waiting)
        finish(() => reject(new Error("Could not authorize requests to this environment.")));
    };
    unsubscribe = appAtomRegistry.subscribe(atom, check, { immediate: true });
    if (settled) queueMicrotask(() => unsubscribe?.());
  });
}

const errorMessage = (body: unknown, status: number): string => {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  }
  if (status === 404) return "The Local Studio bridge is not available on this environment.";
  if (status === 401 || status === 403)
    return "This session may not reach the Local Studio controller.";
  if (status === 502 || status === 503 || status === 504)
    return "The Local Studio controller is not answering.";
  return `HTTP ${status}`;
};

const requestUrl = (access: DeviceHubAccess, path: string) =>
  withDeviceHubQuery(`${access.httpBase}${path.startsWith("/") ? path : `/${path}`}`, access);

const credentialsOf = (access: DeviceHubAccess): RequestCredentials =>
  access.credentials ? "include" : "same-origin";

async function send(
  environmentId: EnvironmentId,
  path: string,
  init: RequestInit | undefined,
  retried: boolean,
  timeoutMs: number,
): Promise<Response> {
  const access = await resolveAccess(environmentId);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (init?.body !== undefined && init.body !== null && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const response = await fetch(requestUrl(access, path), {
    ...init,
    headers,
    signal,
    cache: "no-store",
    credentials: credentialsOf(access),
  });
  if (response.status === 401 && !retried && !access.credentials) {
    appAtomRegistry.refresh(controllerAccessAtom(environmentId));
    return send(environmentId, path, init, true, timeoutMs);
  }
  return response;
}

export async function controllerFetch<T>(
  environmentId: EnvironmentId,
  path: string,
  init?: RequestInit,
  timeoutMs: number = LOCAL_AI_POLLING.requestTimeoutMs,
): Promise<T> {
  let response: Response;
  try {
    response = await send(environmentId, path, init, false, timeoutMs);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError")
      throw new Error("The Local Studio controller timed out.", { cause: error });
    throw error;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(errorMessage(body, response.status));
    return body as T;
  }
  if (!response.ok) throw new Error(errorMessage(null, response.status));
  if (contentType.startsWith("text/")) return (await response.text()) as T;
  throw new Error("The Local Studio bridge answered with an unexpected response.");
}

export function controllerJson(method: "POST" | "PUT" | "DELETE", body?: unknown): RequestInit {
  return body === undefined ? { method } : { method, body: JSON.stringify(body) };
}

const parseBlock = (block: string): ControllerEvent | null => {
  let type = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!type || !data) return null;
  try {
    return { type, data: JSON.parse(data) } as ControllerEvent;
  } catch {
    return null;
  }
};

export function controllerEvents(
  environmentId: EnvironmentId,
  types: ReadonlyArray<ControllerEventType>,
  onEvent: (event: ControllerEvent) => void,
  onConnection?: (state: ControllerConnection, retryMs: number | null) => void,
): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let delay: number = LOCAL_AI_POLLING.eventsMinBackoffMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retriedAuth = false;

  const run = async () => {
    if (stopped) return;
    controller = new AbortController();
    onConnection?.("connecting", null);
    try {
      const access = await resolveAccess(environmentId);
      const response = await fetch(requestUrl(access, `/api/events?types=${types.join(",")}`), {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
        cache: "no-store",
        credentials: credentialsOf(access),
      });
      if (response.status === 401 && !retriedAuth && !access.credentials) {
        retriedAuth = true;
        appAtomRegistry.refresh(controllerAccessAtom(environmentId));
      }
      if (
        !response.ok ||
        !response.body ||
        !(response.headers.get("content-type") ?? "").includes("text/event-stream")
      )
        throw new Error(`HTTP ${response.status}`);
      retriedAuth = false;
      onConnection?.("live", null);
      delay = LOCAL_AI_POLLING.eventsMinBackoffMs;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          const event = parseBlock(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          if (event) onEvent(event);
          index = buffer.indexOf("\n\n");
        }
      }
    } catch {
      if (stopped) return;
    }
    if (stopped) return;
    onConnection?.("retrying", delay);
    timer = setTimeout(() => void run(), delay);
    delay = nextEventsBackoff(delay);
  };

  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
  };
}
