const ALLOWED_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "TZ",
  "SSH_AUTH_SOCK",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "BUN_INSTALL",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);

const ALLOWED_PREFIXES = ["LC_", "XDG_"];

const SCRUBBED_PREFIXES = [
  "OPENAI_",
  "ANTHROPIC_",
  "GEMINI_",
  "GOOGLE_",
  "XAI_",
  "GROQ_",
  "MISTRAL_",
  "DEEPSEEK_",
  "AWS_",
  "AZURE_",
];

const SCRUBBED_NAMES = new Set(["OPENROUTER_API_KEY"]);

export function isScrubbedEnvName(name: string): boolean {
  return SCRUBBED_NAMES.has(name) || SCRUBBED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isAllowedEnvName(name: string): boolean {
  return ALLOWED_NAMES.has(name) || ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export type LocalStudioHarness = "pi" | "omp";

export interface HarnessEnvironmentInput {
  readonly harness: LocalStudioHarness;
  readonly base: Readonly<Record<string, string | undefined>>;
  readonly overrides?: Readonly<Record<string, string | undefined>>;
  readonly agentDir: string;
  readonly homeDir: string;
  readonly relativeAgentDir: string;
  readonly workspace: string;
}

export function buildHarnessEnvironment(input: HarnessEnvironmentInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.base)) {
    if (value !== undefined && isAllowedEnvName(name) && !isScrubbedEnvName(name)) {
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(input.overrides ?? {})) {
    if (value !== undefined && !isScrubbedEnvName(name)) {
      env[name] = value;
    }
  }
  env.HOME = input.homeDir;
  env.LOCAL_STUDIO_WORKSPACE = input.workspace;
  env.PI_CODING_AGENT_DIR = input.agentDir;
  if (input.harness === "pi") {
    env.PI_OFFLINE = "1";
    env.PI_SKIP_VERSION_CHECK = "1";
    env.PI_TELEMETRY = "0";
  } else {
    env.PI_CONFIG_DIR = input.relativeAgentDir;
    env.OMP_SKIP_SETUP = "1";
  }
  return env;
}
