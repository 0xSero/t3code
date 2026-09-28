import * as NodeOS from "node:os";

import {
  DEFAULT_LOCAL_STUDIO_CONTROLLER_URL,
  LOCAL_STUDIO_GATEWAY_URL_ENV,
  type GatewayModel,
  type LocalStudioGatewayClient,
} from "@local-studio/t3-providers";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  LocalStudioGateway,
  LocalStudioGatewayError,
} from "../../localStudio/LocalStudioGateway.ts";

let tempCounter = 0;
const isGatewayError = Schema.is(LocalStudioGatewayError);

const AGENT_ROOT_ENV = "LOCAL_STUDIO_T3_AGENT_ROOT";
const REQUEST_TIMEOUT = "5 seconds";

const GatewayModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      owned_by: Schema.optional(Schema.NullOr(Schema.String)),
      context_length: Schema.optional(Schema.NullOr(Schema.Number)),
      contextWindow: Schema.optional(Schema.NullOr(Schema.Number)),
      local_studio: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            machineId: Schema.optional(Schema.NullOr(Schema.String)),
            engine: Schema.optional(Schema.NullOr(Schema.String)),
            state: Schema.optional(Schema.NullOr(Schema.String)),
            vision: Schema.optional(Schema.NullOr(Schema.Boolean)),
            via: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    }),
  ),
});

const IssuedKey = Schema.Struct({ id: Schema.String, key: Schema.String });
const StoredKeyMeta = Schema.Struct({ id: Schema.String });

const decodeModels = Schema.decodeUnknownEffect(GatewayModelsResponse);
const decodeIssuedKey = Schema.decodeUnknownEffect(IssuedKey);
const decodeKeyMeta = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredKeyMeta));
const encodeKeyMeta = Schema.encodeSync(Schema.fromJsonString(StoredKeyMeta));

export const resolveLocalStudioAgentRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  const configured = yield* Config.String(AGENT_ROOT_ENV).pipe(
    Config.withDefault(""),
    Effect.orElseSucceed(() => ""),
  );
  return configured.trim()
    ? path.resolve(configured.trim())
    : path.join(NodeOS.homedir(), ".local-studio", "agents", "t3");
});

const gatewayUrl = Config.String(LOCAL_STUDIO_GATEWAY_URL_ENV).pipe(
  Config.withDefault(DEFAULT_LOCAL_STUDIO_CONTROLLER_URL),
  Config.map((url) => url.replace(/\/+$/, "")),
  Effect.orElseSucceed(() => DEFAULT_LOCAL_STUDIO_CONTROLLER_URL),
);

const fail = (operation: string, detail: string, cause?: unknown) =>
  new LocalStudioGatewayError({
    operation,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

export const LocalStudioGatewayLive = Layer.effect(
  LocalStudioGateway,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const agentRoot = yield* resolveLocalStudioAgentRoot.pipe(
      Effect.provideService(Path.Path, path),
    );
    const keysDir = path.join(agentRoot, "keys");

    const listReadyModels = () =>
      Effect.gen(function* () {
        const baseUrl = yield* gatewayUrl;
        const response = yield* client.execute(
          HttpClientRequest.get(`${baseUrl}/v1/models`).pipe(
            HttpClientRequest.setHeader("accept", "application/json"),
          ),
        );
        if (response.status !== 200) {
          return yield* fail("listReadyModels", `GET /v1/models returned ${response.status}`);
        }
        const body = yield* decodeModels(yield* response.json);
        return body.data
          .filter((model) => model.local_studio?.state === "ready")
          .map((model): GatewayModel => ({
            id: model.id,
            ownedBy: model.owned_by ?? "",
            contextWindow: model.contextWindow ?? model.context_length ?? null,
            machineId: model.local_studio?.machineId ?? null,
            engine: model.local_studio?.engine ?? null,
            state: model.local_studio?.state ?? "ready",
            vision: model.local_studio?.vision ?? null,
            via: model.local_studio?.via ?? null,
          }));
      }).pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError((cause) =>
          isGatewayError(cause)
            ? cause
            : fail("listReadyModels", "the Local Studio gateway did not answer", cause),
        ),
      );

    const keyAccepted = (baseUrl: string, key: string) =>
      client
        .execute(
          HttpClientRequest.get(`${baseUrl}/v1/models`).pipe(HttpClientRequest.bearerToken(key)),
        )
        .pipe(
          Effect.map((response) => response.status !== 401 && response.status !== 403),
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.orElseSucceed(() => true),
        );

    const writeAtomic = (target: string, content: string) =>
      Effect.gen(function* () {
        tempCounter += 1;
        const temporary = `${target}.${process.pid}.${tempCounter}.tmp`;
        yield* fileSystem.writeFileString(temporary, content, { mode: 0o600 });
        yield* fileSystem.chmod(temporary, 0o600);
        yield* fileSystem.rename(temporary, target);
      });

    const ensureHarnessKey = (harnessClient: LocalStudioGatewayClient) =>
      Effect.gen(function* () {
        const baseUrl = yield* gatewayUrl;
        const keyFile = path.join(keysDir, `${harnessClient}.key`);
        const metaFile = path.join(keysDir, `${harnessClient}.json`);
        yield* fileSystem.makeDirectory(keysDir, { recursive: true, mode: 0o700 });
        const existing = (yield* fileSystem
          .readFileString(keyFile)
          .pipe(Effect.orElseSucceed(() => ""))).trim();
        if (existing && (yield* keyAccepted(baseUrl, existing))) {
          return { keyFile };
        }
        if (existing) {
          const meta = yield* fileSystem
            .readFileString(metaFile)
            .pipe(Effect.flatMap(decodeKeyMeta), Effect.option);
          if (meta._tag === "Some") {
            yield* client
              .execute(HttpClientRequest.delete(`${baseUrl}/api/keys/${meta.value.id}`))
              .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.ignore);
          }
        }
        const response = yield* client.execute(
          HttpClientRequest.post(`${baseUrl}/api/keys`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              client: harnessClient,
              label: "t3",
              scope: "client",
            }),
          ),
        );
        if (response.status !== 201 && response.status !== 200) {
          return yield* fail(
            "ensureHarnessKey",
            `POST /api/keys for ${harnessClient} returned ${response.status}`,
          );
        }
        const issued = yield* decodeIssuedKey(yield* response.json);
        yield* writeAtomic(keyFile, `${issued.key}\n`);
        yield* writeAtomic(metaFile, `${encodeKeyMeta({ id: issued.id })}\n`);
        return { keyFile };
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError((cause) =>
          isGatewayError(cause)
            ? cause
            : fail("ensureHarnessKey", `could not issue a gateway key for ${harnessClient}`, cause),
        ),
      );

    return LocalStudioGateway.of({
      gatewayUrl,
      listReadyModels,
      ensureHarnessKey,
    });
  }),
);
