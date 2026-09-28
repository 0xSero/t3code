import {
  DEFAULT_LOCAL_STUDIO_CONTROLLER_URL,
  LOCAL_STUDIO_GATEWAY_URL_ENV,
  type GatewayModel,
  type LocalStudioGatewayClient,
} from "@local-studio/t3-providers";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

class LocalStudioGatewayError extends Schema.TaggedError<LocalStudioGatewayError>()(
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

export type { LocalStudioGatewayError };

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

const gatewayUrlConfig = Config.String(LOCAL_STUDIO_GATEWAY_URL_ENV).pipe(
  Config.withDefault(DEFAULT_LOCAL_STUDIO_CONTROLLER_URL),
  Config.map((url) => url.replace(/\/+$/, "")),
);

const gatewayUrl = Effect.gen(function* () {
  return yield* gatewayUrlConfig;
}).pipe(Effect.orElseSucceed(() => DEFAULT_LOCAL_STUDIO_CONTROLLER_URL));

export const layer = Layer.succeed(LocalStudioGateway, {
  gatewayUrl,
  listReadyModels: () => Effect.succeed([]),
  ensureHarnessKey: (client) =>
    Effect.fail(
      new LocalStudioGatewayError({
        operation: "ensureHarnessKey",
        detail: `gateway keys for ${client} are not available yet`,
      }),
    ),
});
