import { PI_ACP_BUNDLE_SHA256 } from "@local-studio/pi-acp/bundle";
import { LOCAL_STUDIO_DRIVER_KINDS } from "@local-studio/t3-providers";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as LocalStudioGateway from "./LocalStudioGateway.ts";

const LOCAL_STUDIO_ROUTE_PREFIX = "/api/local-studio";

const authenticateRead = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationReadScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
  }
});

const healthRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const gateway = yield* LocalStudioGateway.LocalStudioGateway;
    return HttpRouter.add(
      "GET",
      `${LOCAL_STUDIO_ROUTE_PREFIX}/_edition`,
      Effect.gen(function* () {
        yield* authenticateRead;
        const gatewayUrl = yield* gateway.gatewayUrl;
        return HttpServerResponse.jsonUnsafe({
          service: "local-studio-edition",
          stage: "bootstrap",
          gatewayUrl,
          drivers: LOCAL_STUDIO_DRIVER_KINDS,
          piAcpBundle: PI_ACP_BUNDLE_SHA256.slice(0, 8),
        });
      }),
    );
  }),
);

export const localStudioRouteLayer = healthRouteLayer.pipe(Layer.provide(LocalStudioGateway.layer));
