import type { GatewayModel, LocalStudioGatewayClient } from "@local-studio/t3-providers";
import type { ProviderInstanceEnvironmentVariable } from "@t3tools/contracts";

export interface ProfileFile {
  readonly path: string;
  readonly contents: string;
  readonly merge?: (existing: string | null) => string;
}

export interface ProfileInput {
  readonly gatewayUrl: string;
  readonly home: string;
  readonly models: ReadonlyArray<GatewayModel>;
  readonly key: string;
  readonly binaryPath: string | undefined;
}

export interface ProviderProfile {
  readonly driver: string;
  readonly label: string;
  readonly client: LocalStudioGatewayClient;
  readonly keyVariable: string;
  readonly defaultBinary: string;
  readonly warmup: ReadonlyArray<ReadonlyArray<string>>;
  readonly build: (input: ProfileInput) => {
    readonly config: Record<string, unknown>;
    readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
    readonly files: ReadonlyArray<ProfileFile>;
  };
}

const plain = (name: string, value: string): ProviderInstanceEnvironmentVariable => ({
  name,
  value,
  sensitive: false,
});

const secret = (name: string, value: string): ProviderInstanceEnvironmentVariable => ({
  name,
  value,
  sensitive: true,
});

const toml = (value: string) => JSON.stringify(value);

const customModels = (models: ReadonlyArray<GatewayModel>) =>
  models.map((model) => ({ slug: model.id, name: model.id }));

const withBinary = (config: Record<string, unknown>, binaryPath: string | undefined) =>
  binaryPath ? { ...config, binaryPath } : config;

const defaultModelId = (models: ReadonlyArray<GatewayModel>) => models[0]?.id ?? "";

const codexProfile: ProviderProfile = {
  driver: "codex",
  label: "Codex",
  client: "codex-cli",
  keyVariable: "LOCAL_STUDIO_API_KEY",
  defaultBinary: "codex",
  warmup: [],
  build: ({ gatewayUrl, home, models, key, binaryPath }) => {
    const codexHome = `${home}/codex`;
    const config = [
      `model = ${toml(defaultModelId(models))}`,
      `model_provider = "localstudio"`,
      "",
      "[model_providers.localstudio]",
      `name = "Local Studio"`,
      `base_url = ${toml(`${gatewayUrl}/v1`)}`,
      `wire_api = "responses"`,
      `env_key = "LOCAL_STUDIO_API_KEY"`,
      `http_headers = { "X-Local-Studio-Client" = "codex-cli" }`,
      "",
    ].join("\n");
    return {
      config: withBinary({ homePath: codexHome, customModels: customModels(models) }, binaryPath),
      environment: [secret("LOCAL_STUDIO_API_KEY", key)],
      files: [{ path: `${codexHome}/config.toml`, contents: config }],
    };
  },
};

const claudeProfile: ProviderProfile = {
  driver: "claudeAgent",
  label: "Claude",
  client: "claude-code",
  keyVariable: "ANTHROPIC_AUTH_TOKEN",
  defaultBinary: "claude",
  warmup: [],
  build: ({ gatewayUrl, home, models, key, binaryPath }) => {
    const configDir = `${home}/claude`;
    const model = defaultModelId(models);
    const onboarded = (existing: string | null) => {
      let state: Record<string, unknown> = {};
      try {
        state = existing ? (JSON.parse(existing) as Record<string, unknown>) : {};
      } catch {
        state = {};
      }
      return `${JSON.stringify({ ...state, hasCompletedOnboarding: true }, null, 2)}\n`;
    };
    return {
      config: withBinary({ homePath: configDir, customModels: customModels(models) }, binaryPath),
      environment: [
        plain("ANTHROPIC_BASE_URL", gatewayUrl),
        secret("ANTHROPIC_AUTH_TOKEN", key),
        plain("ANTHROPIC_API_KEY", ""),
        plain("ANTHROPIC_MODEL", model),
        plain("ANTHROPIC_DEFAULT_OPUS_MODEL", model),
        plain("ANTHROPIC_DEFAULT_SONNET_MODEL", model),
        plain("ANTHROPIC_DEFAULT_HAIKU_MODEL", model),
        plain("CLAUDE_CODE_SUBAGENT_MODEL", model),
        plain("ANTHROPIC_CUSTOM_HEADERS", "X-Local-Studio-Client: claude-code"),
        plain("CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT", "1"),
        plain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
        plain("DISABLE_AUTOUPDATER", "1"),
      ],
      files: [{ path: `${configDir}/.claude.json`, contents: onboarded(null), merge: onboarded }],
    };
  },
};

const grokProfile: ProviderProfile = {
  driver: "grok",
  label: "Grok",
  client: "grok",
  keyVariable: "XAI_API_KEY",
  defaultBinary: "grok",
  warmup: [["--version"], ["models"]],
  build: ({ gatewayUrl, home, models, key, binaryPath }) => {
    const grokHome = `${home}/grok`;
    const config = [
      "[endpoints]",
      `models_base_url = ${toml(`${gatewayUrl}/v1`)}`,
      "",
      "[models]",
      `default = ${toml(defaultModelId(models))}`,
      `web_search = ${toml(defaultModelId(models))}`,
      "",
      "[features]",
      "telemetry = false",
      "",
      "[cli]",
      "auto_update = false",
      "",
    ].join("\n");
    return {
      config: withBinary({ customModels: customModels(models) }, binaryPath),
      environment: [
        plain("GROK_HOME", grokHome),
        plain("GROK_MODELS_BASE_URL", `${gatewayUrl}/v1`),
        plain("GROK_DISABLE_AUTOUPDATER", "1"),
        secret("XAI_API_KEY", key),
      ],
      files: [{ path: `${grokHome}/config.toml`, contents: config }],
    };
  },
};

const openCodeProfile: ProviderProfile = {
  driver: "opencode",
  label: "OpenCode",
  client: "opencode",
  keyVariable: "LOCAL_STUDIO_API_KEY",
  defaultBinary: "opencode",
  warmup: [["--version"], ["models"]],
  build: ({ gatewayUrl, home, models, key, binaryPath }) => {
    const root = `${home}/opencode`;
    const content = {
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["localstudio"],
      autoupdate: false,
      share: "disabled",
      model: `localstudio/${defaultModelId(models)}`,
      provider: {
        localstudio: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local Studio",
          options: {
            baseURL: `${gatewayUrl}/v1`,
            apiKey: "{env:LOCAL_STUDIO_API_KEY}",
            headers: { "X-Local-Studio-Client": "opencode" },
          },
          models: Object.fromEntries(
            models.map((model) => [
              model.id,
              {
                name: model.id,
                attachment: model.vision === true,
                tool_call: true,
                ...(model.contextWindow
                  ? { limit: { context: model.contextWindow, output: model.contextWindow } }
                  : {}),
              },
            ]),
          ),
        },
      },
    };
    return {
      config: withBinary({}, binaryPath),
      environment: [
        plain("OPENCODE_CONFIG_CONTENT", JSON.stringify(content)),
        plain("XDG_CONFIG_HOME", `${root}/config`),
        plain("XDG_DATA_HOME", `${root}/data`),
        plain("XDG_STATE_HOME", `${root}/state`),
        plain("OPENCODE_DISABLE_AUTOUPDATE", "1"),
        secret("LOCAL_STUDIO_API_KEY", key),
      ],
      files: [],
    };
  },
};

export const PROVIDER_PROFILES: ReadonlyArray<ProviderProfile> = [
  codexProfile,
  claudeProfile,
  grokProfile,
  openCodeProfile,
];
