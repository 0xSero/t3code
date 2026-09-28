// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const HOOKS_FILE = ".local-studio/hooks.txt";
export const CONTRACTS_LOCK_FILE = ".local-studio/contracts.lock";

export interface Hook {
  readonly path: string;
  readonly budget: number | null;
  readonly id: string;
  readonly purpose: string;
}

export function run(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly input?: string; readonly allowFailure?: boolean } = {},
): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    cwd: options.cwd ?? repoRoot,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0 && options.allowFailure !== true) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${status}\n${result.stderr.trim()}`.trim(),
    );
  }
  return { status, stdout: result.stdout, stderr: result.stderr };
}

export function git(args: ReadonlyArray<string>, cwd?: string): string {
  return run("git", args, cwd === undefined ? {} : { cwd }).stdout;
}

export function gitRefExists(ref: string, cwd?: string): boolean {
  return (
    run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      ...(cwd === undefined ? {} : { cwd }),
      allowFailure: true,
    }).status === 0
  );
}

export function readHooks(): ReadonlyArray<Hook> {
  const text = NodeFS.readFileSync(NodePath.join(repoRoot, HOOKS_FILE), "utf8");
  const hooks: Array<Hook> = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const fields = line.split("\t");
    const [path, budgetField, id, purpose] = fields;
    if (fields.length !== 4 || !path || !budgetField || !id || purpose === undefined) {
      throw new Error(`${HOOKS_FILE}:${index + 1}: expected 4 tab-separated fields`);
    }
    if (budgetField !== "-" && !/^\d+$/.test(budgetField)) {
      throw new Error(`${HOOKS_FILE}:${index + 1}: budget must be a number or "-"`);
    }
    hooks.push({
      path,
      budget: budgetField === "-" ? null : Number(budgetField),
      id,
      purpose,
    });
  });
  return hooks;
}

export function vpBin(): string {
  const local = NodePath.join(repoRoot, "node_modules", ".bin", "vp");
  return NodeFS.existsSync(local) ? local : "vp";
}

export function parseArgs(argv: ReadonlyArray<string>): {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
} {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(arg.slice(2), next);
      index += 1;
      continue;
    }
    flags.add(arg.slice(2));
  }
  return { flags, values };
}

export function runMain(main: () => number): number {
  try {
    return main();
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
