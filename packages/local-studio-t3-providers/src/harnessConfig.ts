import type { GatewayModel } from "./gateway.ts";
import type { LocalStudioHarness } from "./env.ts";

export const LOCAL_STUDIO_HARNESS_PROVIDER = "localstudio";
export const LOCAL_STUDIO_WORKSPACE_ENV = "LOCAL_STUDIO_WORKSPACE";

export interface HarnessModelsConfigInput {
  readonly harness: LocalStudioHarness;
  readonly gatewayUrl: string;
  readonly keyFile: string;
  readonly models: ReadonlyArray<GatewayModel>;
}

export interface HarnessModelsConfigFile {
  readonly fileName: string;
  readonly content: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function harnessModelId(modelId: string): string {
  return `${LOCAL_STUDIO_HARNESS_PROVIDER}/${modelId}`;
}

export function buildHarnessModelsConfig(input: HarnessModelsConfigInput): HarnessModelsConfigFile {
  const models = input.models.map((model) => ({
    id: model.id,
    name: model.id,
    reasoning: true,
    input: model.vision === false ? ["text"] : ["text", "image"],
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(input.harness === "omp"
      ? { omitMaxOutputTokens: true }
      : model.contextWindow
        ? { maxTokens: model.contextWindow }
        : {}),
  }));
  const provider = {
    baseUrl: `${input.gatewayUrl.replace(/\/+$/, "")}/v1`,
    api: "openai-completions",
    apiKey: `!cat ${shellQuote(input.keyFile)}`,
    headers: {
      "X-Local-Studio-Client": input.harness,
      "X-Local-Studio-Workspace":
        input.harness === "pi" ? `$${LOCAL_STUDIO_WORKSPACE_ENV}` : LOCAL_STUDIO_WORKSPACE_ENV,
    },
    models,
  };
  return {
    fileName: input.harness === "pi" ? "models.json" : "models.yml",
    content: `${JSON.stringify({ providers: { [LOCAL_STUDIO_HARNESS_PROVIDER]: provider } }, null, 2)}\n`,
  };
}
