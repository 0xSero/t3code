import { LOCAL_AI_DRIVER_KIND } from "@local-studio/t3-providers";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../../serverSettings.ts";

const LOCAL_AI_INSTANCE_ID = ProviderInstanceId.make(LOCAL_AI_DRIVER_KIND);

export const localAiBootstrapLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    yield* serverSettings.ready.pipe(
      Effect.andThen(serverSettings.getSettings),
      Effect.flatMap((current) =>
        LOCAL_AI_INSTANCE_ID in current.providerInstances
          ? Effect.void
          : serverSettings
              .updateSettings({
                providerInstances: {
                  ...current.providerInstances,
                  [LOCAL_AI_INSTANCE_ID]: {
                    driver: ProviderDriverKind.make(LOCAL_AI_DRIVER_KIND),
                    enabled: true,
                  },
                },
              })
              .pipe(Effect.asVoid),
      ),
      Effect.ignoreCause({ log: true }),
      Effect.forkScoped,
    );
  }),
);
