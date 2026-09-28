import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";

import * as ControllerSidecar from "./ControllerSidecar.ts";
import * as LocalStudioGateway from "./LocalStudioGateway.ts";
import { makeRoutes } from "./LocalStudioRoutes.ts";
import { localAiBootstrapLayer } from "../provider/localStudio/LocalAiBootstrap.ts";

const routesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const gateway = yield* LocalStudioGateway.LocalStudioGateway;
    const sidecar = yield* ControllerSidecar.make;
    return Layer.mergeAll(...makeRoutes({ httpClient, gateway, sidecarStatus: sidecar.status }));
  }),
).pipe(Layer.provide(LocalStudioGateway.layer));

export const localStudioRouteLayer = Layer.merge(routesLayer, localAiBootstrapLayer);
