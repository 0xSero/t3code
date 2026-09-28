// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import {
  CONTRACTS_LOCK_FILE,
  git,
  gitRefExists,
  parseArgs,
  runMain,
  repoRoot,
  run,
  vpBin,
} from "./lib.ts";

const TARGET_DIR = "packages/local-studio-contracts/src";

const TRANSFORMS = [
  'relative imports rewritten from "./x" to "./x.ts"',
  "vp fmt with the repository formatter config",
] as const;

interface ContractsLock {
  readonly repository: string;
  readonly path: string;
  readonly commit: string;
  readonly source: string | null;
}

function readLock(): ContractsLock {
  const entries = new Map<string, string>();
  for (const line of NodeFS.readFileSync(
    NodePath.join(repoRoot, CONTRACTS_LOCK_FILE),
    "utf8",
  ).split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!entries.has(key)) entries.set(key, line.slice(eq + 1).trim());
  }
  const repository = entries.get("repository");
  const path = entries.get("path");
  const commit = entries.get("commit");
  if (!repository || !path || !commit) {
    throw new Error(`${CONTRACTS_LOCK_FILE} needs repository=, path= and commit=`);
  }
  return { repository, path, commit, source: entries.get("source") ?? null };
}

function writeLock(lock: ContractsLock): void {
  const lines = [
    `repository=${lock.repository}`,
    `path=${lock.path}`,
    `commit=${lock.commit}`,
    ...(lock.source ? [`source=${lock.source}`] : []),
    ...TRANSFORMS.map((transform) => `transform=${transform}`),
  ];
  NodeFS.writeFileSync(NodePath.join(repoRoot, CONTRACTS_LOCK_FILE), `${lines.join("\n")}\n`);
}

function hasCommit(dir: string, commit: string): boolean {
  return NodeFS.existsSync(NodePath.join(dir, ".git")) && gitRefExists(commit, dir);
}

function resolveSource(
  lock: ContractsLock,
  explicit: string | undefined,
  commit: string,
): { readonly dir: string; readonly cleanup: () => void } {
  if (explicit && explicit !== "remote") {
    if (!hasCommit(explicit, commit))
      throw new Error(`${explicit} does not contain commit ${commit}`);
    return { dir: explicit, cleanup: () => {} };
  }
  const candidates =
    explicit === "remote" ? [] : [NodeProcess.env.LOCAL_STUDIO_SOURCE, lock.source];
  for (const candidate of candidates) {
    if (candidate && hasCommit(candidate, commit)) return { dir: candidate, cleanup: () => {} };
  }
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "local-studio-contracts-"));
  git(["init", "--quiet", dir]);
  git(["-C", dir, "remote", "add", "origin", `https://github.com/${lock.repository}.git`]);
  git(["-C", dir, "fetch", "--quiet", "--depth", "1", "origin", commit]);
  return { dir, cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }) };
}

const rewriteRelativeImports = (text: string): string =>
  text.replace(
    /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+?)\2/g,
    (whole, prefix: string, quote: string, specifier: string) =>
      /\.(ts|tsx|js|mjs|cjs|json)$/.test(specifier)
        ? whole
        : `${prefix}${quote}${specifier}.ts${quote}`,
  );

const format = (relativePath: string, text: string): string =>
  run(vpBin(), ["fmt", `--stdin-filepath=${relativePath}`], { input: text }).stdout;

function generate(sourceDir: string, lock: ContractsLock, commit: string): Map<string, string> {
  const prefix = `${lock.path.replace(/\/$/, "")}/`;
  const files = git(["ls-tree", "-r", "--name-only", commit, "--", prefix], sourceDir)
    .split("\n")
    .filter((path) => path.startsWith(prefix));
  if (files.length === 0) throw new Error(`no files under ${lock.path} at ${commit}`);
  const output = new Map<string, string>();
  for (const file of files) {
    const relative = file.slice(prefix.length);
    const raw = git(["show", `${commit}:${file}`], sourceDir);
    const transformed = /\.(ts|tsx)$/.test(relative) ? rewriteRelativeImports(raw) : raw;
    output.set(relative, format(`${TARGET_DIR}/${relative}`, transformed));
  }
  return output;
}

function listTarget(): Map<string, string> {
  const root = NodePath.join(repoRoot, TARGET_DIR);
  const output = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        output.set(
          NodePath.relative(root, full).split(NodePath.sep).join("/"),
          NodeFS.readFileSync(full, "utf8"),
        );
    }
  };
  if (NodeFS.existsSync(root)) walk(root);
  return output;
}

export function checkContracts(sourceOverride?: string): ReadonlyArray<string> {
  const lock = readLock();
  const source = resolveSource(lock, sourceOverride, lock.commit);
  try {
    const expected = generate(source.dir, lock, lock.commit);
    const actual = listTarget();
    const problems: Array<string> = [];
    for (const [path, text] of expected) {
      const current = actual.get(path);
      if (current === undefined) problems.push(`missing ${TARGET_DIR}/${path}`);
      else if (current !== text) problems.push(`differs ${TARGET_DIR}/${path}`);
    }
    for (const path of actual.keys()) {
      if (!expected.has(path)) problems.push(`extra ${TARGET_DIR}/${path}`);
    }
    return problems;
  } finally {
    source.cleanup();
  }
}

function sync(sourceOverride: string | undefined, ref: string | undefined): void {
  const lock = readLock();
  const sourceHint =
    sourceOverride === "remote"
      ? null
      : (sourceOverride ?? NodeProcess.env.LOCAL_STUDIO_SOURCE ?? lock.source);
  const wanted = ref ?? lock.commit;
  const commit =
    sourceHint && NodeFS.existsSync(NodePath.join(sourceHint, ".git"))
      ? git(["rev-parse", `${wanted}^{commit}`], sourceHint).trim()
      : wanted;
  const source = resolveSource(lock, sourceOverride, commit);
  try {
    const files = generate(source.dir, lock, commit);
    const root = NodePath.join(repoRoot, TARGET_DIR);
    for (const path of listTarget().keys()) {
      if (!files.has(path)) NodeFS.rmSync(NodePath.join(root, path));
    }
    for (const [path, text] of files) {
      const full = NodePath.join(root, path);
      NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
      NodeFS.writeFileSync(full, text);
    }
    writeLock({ ...lock, commit });
    console.log(`sync-contracts: ${files.size} files from ${lock.repository}@${commit}`);
  } finally {
    source.cleanup();
  }
}

function main(): number {
  const { flags, values } = parseArgs(NodeProcess.argv.slice(2));
  const sourceOverride = values.get("source");
  if (flags.has("check")) {
    const problems = checkContracts(sourceOverride);
    for (const problem of problems) console.error(`FAIL ${problem}`);
    const lock = readLock();
    console.log(
      problems.length === 0
        ? `sync-contracts --check: ok (${lock.repository}@${lock.commit.slice(0, 9)})`
        : `sync-contracts --check: ${problems.length} problem(s); run node scripts/local-studio/sync-contracts.ts`,
    );
    return problems.length === 0 ? 0 : 1;
  }
  sync(sourceOverride, values.get("ref"));
  return 0;
}

if (import.meta.main) NodeProcess.exit(runMain(main));
