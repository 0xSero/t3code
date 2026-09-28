import type { GatewayModel, LocalStudioGatewayClient } from "@local-studio/t3-providers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const REQUEST_TIMEOUT = "8 seconds";

const Health = Schema.Struct({ service: Schema.String });

const ModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      owned_by: Schema.optional(Schema.String),
      contextWindow: Schema.optional(Schema.NullOr(Schema.Number)),
      context_length: Schema.optional(Schema.NullOr(Schema.Number)),
      local_studio: Schema.optional(
        Schema.Struct({
          machineId: Schema.optional(Schema.NullOr(Schema.String)),
          engine: Schema.optional(Schema.NullOr(Schema.String)),
          state: Schema.optional(Schema.String),
          vision: Schema.optional(Schema.NullOr(Schema.Boolean)),
          via: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    }),
  ),
});

const IssuedKey = Schema.Struct({ id: Schema.String, key: Schema.String });

export const controllerIsUp = (gatewayUrl: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(HttpClientRequest.get(`${gatewayUrl}/health`));
    const body = yield* HttpClientResponse.schemaBodyJson(Health)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return body.service === "local-studio";
  }).pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.orElseSucceed(() => false),
  );

export const listReadyGatewayModels = (gatewayUrl: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(HttpClientRequest.get(`${gatewayUrl}/v1/models`));
    const body = yield* HttpClientResponse.schemaBodyJson(ModelsResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return body.data
      .map((entry): GatewayModel => ({
        id: entry.id,
        ownedBy: entry.owned_by ?? "",
        contextWindow: entry.contextWindow ?? entry.context_length ?? null,
        machineId: entry.local_studio?.machineId ?? null,
        engine: entry.local_studio?.engine ?? null,
        state: entry.local_studio?.state ?? "ready",
        vision: entry.local_studio?.vision ?? null,
        via: entry.local_studio?.via ?? null,
      }))
      .filter((model) => model.state === "ready");
  }).pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.option);

export const gatewayKeyIsValid = (gatewayUrl: string, key: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${gatewayUrl}/v1/models`).pipe(HttpClientRequest.bearerToken(key)),
    );
    return Option.some(response.status >= 200 && response.status < 300);
  }).pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.orElseSucceed(() => Option.none<boolean>()),
  );

export const issueGatewayKey = (gatewayUrl: string, client: LocalStudioGatewayClient) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.post(`${gatewayUrl}/api/keys`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ client, label: "t3", scope: "client" }),
      ),
    );
    return yield* HttpClientResponse.schemaBodyJson(IssuedKey)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
  }).pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.option);
