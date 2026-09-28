import { PI_ACP_BUNDLE_SHA256 } from "@local-studio/pi-acp/bundle";
import { LOCAL_STUDIO_DRIVER_KINDS } from "@local-studio/t3-providers";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import type { SidecarStatus } from "./ControllerSidecar.ts";
import type { LocalStudioGateway } from "./LocalStudioGateway.ts";
import {
  LocalStudioMode,
  type LocalStudioSettings,
  normalizeControllerUrl,
  readSettings,
  updateConfig,
} from "./LocalStudioConfig.ts";

const LOCAL_STUDIO_ROUTE_PREFIX = "/api/local-studio";

const ALLOWED_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/(snapshot|fleet|events|health|tailnet|machines|peers|metrics|usage|recipes|launches|pods|models|lab|agents|host)(\/.*)?$/,
  /^\/v1\/models$/,
  /^\/health$/,
];

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
  "origin",
  "referer",
  "forwarded",
  "x-real-ip",
  "x-api-key",
  "tailscale-user-login",
  "tailscale-user-name",
  "cf-connecting-ip",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "connection",
  "content-length",
  "keep-alive",
  "set-cookie",
]);

const isDroppedRequestHeader = (name: string) =>
  DROPPED_REQUEST_HEADERS.has(name) || name.startsWith("x-forwarded-") || name.startsWith("sec-");

const authenticate = (requiredScope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (EnvironmentAuth.isServerAuthCredentialError(error)) {
            return yield* failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            );
          }
          return yield* failEnvironmentInternal("internal_error", error);
        }),
      ),
    );
    if (!session.scopes.includes(requiredScope)) {
      return yield* failEnvironmentScopeRequired(requiredScope);
    }
  });

const forwardHeaders = (
  request: HttpServerRequest.HttpServerRequest,
  settings: LocalStudioSettings,
) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || isDroppedRequestHeader(name.toLowerCase())) continue;
    headers[name] = value;
  }
  if (settings.mode === "remote" && settings.key) headers.authorization = `Bearer ${settings.key}`;
  return headers;
};

const errorResponse = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status });

const proxy = Effect.fn("LocalStudioRoutes.proxy")(function* (
  httpClient: HttpClient.HttpClient,
  controllerPath: string,
  search: string,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const settings = yield* readSettings;
  if (settings.mode === "off") {
    return errorResponse(503, "CONTROLLER_OFF", "Local Studio controller is turned off");
  }
  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? yield* request.arrayBuffer : null;
  const upstreamRequest = HttpClientRequest.make(method)(
    `${settings.url}${controllerPath}${search}`,
  ).pipe(HttpClientRequest.setHeaders(forwardHeaders(request, settings)), (self) =>
    body && body.byteLength > 0
      ? HttpClientRequest.bodyUint8Array(
          self,
          new Uint8Array(body),
          request.headers["content-type"] ?? "application/json",
        )
      : self,
  );
  const scopedClient = HttpClient.withScope(httpClient);
  const response = yield* scopedClient
    .execute(upstreamRequest)
    .pipe(
      Effect.catch((cause) =>
        Effect.logDebug("Local Studio controller unreachable", { cause }).pipe(Effect.as(null)),
      ),
    );
  if (response === null) {
    return errorResponse(
      502,
      "CONTROLLER_UNREACHABLE",
      `Local Studio controller at ${settings.url} is not reachable`,
    );
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    headers[name] = value;
  }
  headers["cache-control"] = "no-store, no-transform";
  const contentType = headers["content-type"];
  if (contentType?.startsWith("text/event-stream")) headers["x-accel-buffering"] = "no";
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    ...(contentType ? { contentType } : {}),
  });
});

const ConfigUpdate = Schema.Struct({
  mode: Schema.optional(LocalStudioMode),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  key: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeConfigUpdate = Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigUpdate));

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const configView = (settings: LocalStudioSettings, sidecar: SidecarStatus) => ({
  mode: settings.mode,
  url: settings.url,
  configuredUrl: settings.configuredUrl,
  envUrl: settings.envUrl,
  hasKey: settings.key !== null,
  sidecar,
});

export const makeRoutes = (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly sidecarStatus: Effect.Effect<SidecarStatus>;
  readonly gateway: LocalStudioGateway["Service"];
}) => {
  const editionRoute = HttpRouter.add(
    "GET",
    `${LOCAL_STUDIO_ROUTE_PREFIX}/_edition`,
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationReadScope);
      const settings = yield* readSettings;
      const sidecar = yield* input.sidecarStatus;
      return HttpServerResponse.jsonUnsafe({
        service: "local-studio-edition",
        stage: "bridge",
        gatewayUrl: settings.url,
        mode: settings.mode,
        controller: sidecar.state,
        drivers: LOCAL_STUDIO_DRIVER_KINDS,
        piAcpBundle: PI_ACP_BUNDLE_SHA256.slice(0, 8),
      });
    }),
  );

  const modelsRoute = HttpRouter.add(
    "GET",
    `${LOCAL_STUDIO_ROUTE_PREFIX}/_models`,
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationReadScope);
      return yield* input.gateway.listReadyModels().pipe(
        Effect.map((models) => HttpServerResponse.jsonUnsafe({ models })),
        Effect.catch((error) =>
          Effect.succeed(errorResponse(502, "CONTROLLER_UNREACHABLE", error.message)),
        ),
      );
    }),
  );

  const getConfigRoute = HttpRouter.add(
    "GET",
    `${LOCAL_STUDIO_ROUTE_PREFIX}/_config`,
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationReadScope);
      const settings = yield* readSettings;
      return HttpServerResponse.jsonUnsafe(configView(settings, yield* input.sidecarStatus));
    }),
  );

  const putConfigRoute = HttpRouter.add(
    "PUT",
    `${LOCAL_STUDIO_ROUTE_PREFIX}/_config`,
    Effect.gen(function* () {
      yield* authenticate(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      const parsed = yield* decodeConfigUpdate(text).pipe(Effect.option);
      if (Option.isNone(parsed)) {
        return errorResponse(400, "INVALID_REQUEST", "expected {mode?, url?, key?}");
      }
      const update = parsed.value;
      if (typeof update.url === "string" && !isHttpUrl(update.url.trim())) {
        return errorResponse(400, "INVALID_REQUEST", "url must be an http(s) URL");
      }
      const settings = yield* updateConfig((current) => {
        const next = { ...current };
        if (update.mode !== undefined) next.mode = update.mode;
        if (update.url === null) delete next.url;
        else if (update.url !== undefined) next.url = normalizeControllerUrl(update.url);
        if (update.key === null) delete next.key;
        else if (update.key !== undefined) next.key = update.key.trim();
        return next;
      });
      return HttpServerResponse.jsonUnsafe(configView(settings, yield* input.sidecarStatus));
    }),
  );

  const proxyRoute = HttpRouter.add(
    "*",
    `${LOCAL_STUDIO_ROUTE_PREFIX}/*`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
      const controllerPath = url.value.pathname.slice(LOCAL_STUDIO_ROUTE_PREFIX.length) || "/";
      if (
        controllerPath.includes("..") ||
        !ALLOWED_PATHS.some((pattern) => pattern.test(controllerPath))
      ) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      const readOnly = request.method === "GET" || request.method === "HEAD";
      if (!readOnly && !controllerPath.startsWith("/api/")) {
        return HttpServerResponse.text("Method Not Allowed", { status: 405 });
      }
      yield* authenticate(readOnly ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope);
      const search = new URLSearchParams(url.value.search);
      search.delete("wsTicket");
      const query = search.size > 0 ? `?${search.toString()}` : "";
      return yield* proxy(input.httpClient, controllerPath, query);
    }),
  );

  return [editionRoute, modelsRoute, getConfigRoute, putConfigRoute, proxyRoute] as const;
};
