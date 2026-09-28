import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { PiAcpAgent, type BridgeConfig } from "./acpServer.ts";
import approvalGate from "./approvalGate.ts";

export default approvalGate;

const PI_ACP_VERSION = "0.1.0";

const PASSTHROUGH_ENV: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "XDG_RUNTIME_DIR",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "ProgramData",
  "ProgramFiles",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "ELECTRON_RUN_AS_NODE",
]);

const USAGE = `Usage: pi-acp --agent-dir <dir> [options]

Bridges pi --mode rpc to the Agent Client Protocol over stdio.

Options:
  --agent-dir <dir>   Isolated pi config dir (PI_CODING_AGENT_DIR). Required.
  --pi <command>      pi executable or cli.js (default: pi)
  --provider <name>   pi provider (default: localstudio)
  --model <id>        Initial model id
  --thinking <level>  Initial thinking level
  --approval          Ask the ACP client before mutating tool calls
  --pass-env <NAME>   Extra environment variable to pass to pi (repeatable)
  --pi-arg <arg>      Extra argument appended to the pi command line (repeatable)
`;

const buildEnv = (extra: ReadonlyArray<string>): Record<string, string> => {
  const env: Record<string, string> = {};
  const source = process.env;
  for (const name of Object.keys(source)) {
    const value = source[name];
    if (value === undefined) continue;
    if (PASSTHROUGH_ENV.has(name) || name.startsWith("LC_") || extra.includes(name)) {
      env[name] = value;
    }
  }
  return env;
};

const parseConfig = (argv: ReadonlyArray<string>, selfPath: string): BridgeConfig | null => {
  const { values } = NodeUtil.parseArgs({
    args: [...argv],
    options: {
      "agent-dir": { type: "string" },
      pi: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      thinking: { type: "string" },
      approval: { type: "boolean" },
      "pass-env": { type: "string", multiple: true },
      "pi-arg": { type: "string", multiple: true },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return null;
  }
  if (values.version) {
    process.stdout.write(`${PI_ACP_VERSION}\n`);
    return null;
  }
  const agentDirArg = values["agent-dir"] ?? process.env.PI_CODING_AGENT_DIR;
  if (!agentDirArg) throw new Error("--agent-dir is required");
  const agentDir = NodePath.isAbsolute(agentDirArg) ? agentDirArg : NodePath.resolve(agentDirArg);
  NodeFS.mkdirSync(NodePath.join(agentDir, "sessions"), { recursive: true, mode: 0o700 });
  return {
    piCommand: values.pi ?? "pi",
    agentDir,
    provider: values.provider ?? "localstudio",
    model: values.model ?? null,
    thinking: values.thinking ?? null,
    extensionPath: values.approval ? selfPath : null,
    piArgs: values["pi-arg"] ?? [],
    env: buildEnv(values["pass-env"] ?? []),
    version: PI_ACP_VERSION,
  };
};

const isEntryModule = (selfPath: string): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return NodeFS.realpathSync(entry) === NodeFS.realpathSync(selfPath);
  } catch {
    return false;
  }
};

const run = (selfPath: string): void => {
  let config: BridgeConfig | null;
  try {
    config = parseConfig(process.argv.slice(2), selfPath);
  } catch (error) {
    process.stderr.write(`pi-acp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  if (config === null) return;
  const agent = new PiAcpAgent(config, process.stdin, process.stdout, () => process.exit(0));
  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      agent.killAll();
      process.exit(1);
    }
    stopping = true;
    void agent.shutdown().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  process.stdout.on("error", stop);
};

const selfPath = NodeURL.fileURLToPath(import.meta.url);
if (isEntryModule(selfPath)) run(selfPath);
