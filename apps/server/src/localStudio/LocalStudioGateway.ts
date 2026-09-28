import type { GatewayModel, LocalStudioGatewayClient } from "@local-studio/t3-providers";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { expandHomePathWith } from "../pathExpansion.ts";
import { type LocalStudioSettings, readSettings, updateConfig } from "./LocalStudioConfig.ts";

export class LocalStudioGatewayError extends Schema.TaggedError<LocalStudioGatewayError>()(
  "LocalStudioGatewayError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Local Studio gateway ${this.operation} failed: ${this.detail}`;
  }
}

export interface LocalStudioHarnessKey {
  readonly keyFile: string;
}

export class LocalStudioGateway extends Context.Service<
  LocalStudioGateway,
  {
    readonly gatewayUrl: Effect.Effect<string>;
    readonly listReadyModels: () => Effect.Effect<
      ReadonlyArray<GatewayModel>,
      LocalStudioGatewayError
    >;
    readonly ensureHarnessKey: (
      client: LocalStudioGatewayClient,
    ) => Effect.Effect<LocalStudioHarnessKey, LocalStudioGatewayError>;
  }
>()("t3/localStudio/LocalStudioGateway") {}

const REQUEST_TIMEOUT = Duration.seconds(10);

const NullableString = Schema.NullOr(Schema.String);

const ModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      owned_by: Schema.optional(NullableString),
      context_length: Schema.optional(Schema.NullOr(Schema.Number)),
      contextWindow: Schema.optional(Schema.NullOr(Schema.Number)),
      max_model_len: Schema.optional(Schema.NullOr(Schema.Number)),
      local_studio: Schema.optional(
        Schema.Struct({
          machineId: Schema.optional(NullableString),
          engine: Schema.optional(NullableString),
          state: Schema.optional(Schema.String),
          vision: Schema.optional(Schema.NullOr(Schema.Boolean)),
          via: Schema.optional(NullableString),
        }),
      ),
    }),
  ),
});

const IssuedKey = Schema.Struct({ id: Schema.String, key: Schema.String });

const decodeModels = Schema.decodeUnknownEffect(ModelsResponse);
const decodeIssuedKey = Schema.decodeUnknownEffect(IssuedKey);
const decodeKeyList = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.String })),
);

const authHeaders = (settings: LocalStudioSettings): Record<string, string> =>
  settings.mode === "remote" && settings.key ? { authorization: `Bearer ${settings.key}` } : {};

const harnessKeyFile = (client: LocalStudioGatewayClient, path: Path.Path) =>
  expandHomePathWith(`~/.local-studio/agents/t3/${client}/gateway.key`, path);

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const keyLock = yield* Semaphore.make(1);
  const configContext = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
  >();

  const settings = readSettings.pipe(Effect.provideContext(configContext));

  const fail = (operation: string, detail: string, cause?: unknown) =>
    new LocalStudioGatewayError({
      operation,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const request = (operation: string, req: HttpClientRequest.HttpClientRequest) =>
    httpClient.execute(req).pipe(
      Effect.flatMap((response) =>
        response.json.pipe(
          Effect.orElseSucceed(() => null),
          Effect.map((body) => ({ status: response.status, body })),
        ),
      ),
      Effect.scoped,
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((cause) => fail(operation, "controller is not reachable", cause)),
    );

  const gatewayUrl = settings.pipe(Effect.map((current) => current.url));

  const listReadyModels = () =>
    Effect.gen(function* () {
      const current = yield* settings;
      if (current.mode === "off") return [];
      const response = yield* request(
        "listReadyModels",
        HttpClientRequest.get(`${current.url}/v1/models`).pipe(
          HttpClientRequest.setHeaders(authHeaders(current)),
        ),
      );
      if (response.status !== 200) {
        return yield* fail("listReadyModels", `GET /v1/models returned ${response.status}`);
      }
      const models = yield* decodeModels(response.body).pipe(
        Effect.mapError((cause) => fail("listReadyModels", "unexpected /v1/models body", cause)),
      );
      return models.data
        .filter((model) => model.local_studio?.state === "ready")
        .map((model): GatewayModel => ({
          id: model.id,
          ownedBy: model.owned_by ?? "",
          contextWindow: model.contextWindow ?? model.context_length ?? model.max_model_len ?? null,
          machineId: model.local_studio?.machineId ?? null,
          engine: model.local_studio?.engine ?? null,
          state: model.local_studio?.state ?? "ready",
          vision: model.local_studio?.vision ?? null,
          via: model.local_studio?.via ?? null,
        }));
    });

  const keyListed = (current: LocalStudioSettings, id: string) =>
    request(
      "ensureHarnessKey",
      HttpClientRequest.get(`${current.url}/api/keys`).pipe(
        HttpClientRequest.setHeaders(authHeaders(current)),
      ),
    ).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? decodeKeyList(response.body).pipe(
              Effect.map((keys) => keys.some((key) => key.id === id)),
              Effect.orElseSucceed(() => null),
            )
          : Effect.succeed(null),
      ),
    );

  const keyAccepted = (current: LocalStudioSettings, key: string) =>
    request(
      "ensureHarnessKey",
      HttpClientRequest.get(`${current.url}/v1/models`).pipe(
        HttpClientRequest.setHeaders({ authorization: `Bearer ${key}` }),
      ),
    ).pipe(Effect.map((response) => response.status !== 401 && response.status !== 403));

  const keyWorks = (current: LocalStudioSettings, id: string, key: string) =>
    keyListed(current, id).pipe(
      Effect.flatMap((listed) =>
        listed === null ? keyAccepted(current, key) : Effect.succeed(listed),
      ),
    );

  const writeKeyFile = (file: string, key: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.tmp`;
      yield* fs.writeFileString(temp, key, { mode: 0o600 });
      yield* fs.chmod(temp, 0o600);
      yield* fs.rename(temp, file);
    }).pipe(Effect.mapError((cause) => fail("ensureHarnessKey", `cannot write ${file}`, cause)));

  const issueKey = (current: LocalStudioSettings, client: LocalStudioGatewayClient) =>
    Effect.gen(function* () {
      const response = yield* request(
        "ensureHarnessKey",
        HttpClientRequest.post(`${current.url}/api/keys`).pipe(
          HttpClientRequest.setHeaders(authHeaders(current)),
          HttpClientRequest.bodyJsonUnsafe({ client, label: "t3", scope: "client" }),
        ),
      );
      if (response.status !== 201 && response.status !== 200) {
        return yield* fail("ensureHarnessKey", `POST /api/keys returned ${response.status}`);
      }
      return yield* decodeIssuedKey(response.body).pipe(
        Effect.mapError((cause) => fail("ensureHarnessKey", "unexpected /api/keys body", cause)),
      );
    });

  const revokeKey = (current: LocalStudioSettings, id: string) =>
    request(
      "ensureHarnessKey",
      HttpClientRequest.delete(`${current.url}/api/keys/${encodeURIComponent(id)}`).pipe(
        HttpClientRequest.setHeaders(authHeaders(current)),
      ),
    ).pipe(Effect.ignore);

  const ensureHarnessKey = (client: LocalStudioGatewayClient) =>
    keyLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* settings;
        const keyFile = harnessKeyFile(client, path);
        const existing = yield* fs.readFileString(keyFile).pipe(
          Effect.map((text) => text.trim()),
          Effect.orElseSucceed(() => ""),
        );
        const knownId = current.harnessKeys[client];
        if (existing.length > 0 && knownId) {
          const works = yield* keyWorks(current, knownId, existing).pipe(
            Effect.orElseSucceed(() => true),
          );
          if (works) return { keyFile };
          yield* revokeKey(current, knownId);
        }
        const issued = yield* issueKey(current, client);
        yield* writeKeyFile(keyFile, issued.key);
        yield* updateConfig((file) => ({
          ...file,
          harnessKeys: { ...file.harnessKeys, [client]: issued.id },
        })).pipe(
          Effect.provideContext(configContext),
          Effect.mapError((cause) => fail("ensureHarnessKey", "cannot record key id", cause)),
        );
        return { keyFile };
      }),
    );

  return LocalStudioGateway.of({ gatewayUrl, listReadyModels, ensureHarnessKey });
});

export const layer = Layer.effect(LocalStudioGateway, make);
