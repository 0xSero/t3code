// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeProcess from "node:process";

import {
  HOOKS_FILE,
  git,
  gitRefExists,
  parseArgs,
  runMain,
  readHooks,
  run,
  type Hook,
} from "./lib.ts";

const DOWNSTREAM_PATHS = [
  "packages/local-studio-*/**",
  "apps/server/src/localStudio/**",
  "apps/server/src/provider/localStudio/**",
  "apps/web/src/localStudio/**",
  "apps/web/src/routes/local-ai*.tsx",
  "packages/shared/src/cliReleaseRepository.ts",
  "apps/desktop/src/app/editionIdentity.ts",
  "scripts/local-studio/**",
  ".github/workflows/ls-*",
  ".local-studio/**",
  "docs/local-studio/**",
] as const;

const CHURN_DAYS = 60;

interface Change {
  readonly status: string;
  readonly path: string;
  readonly added: number | null;
  readonly removed: number | null;
}

interface HookReport {
  readonly hook: Hook;
  readonly added: number;
  readonly removed: number;
  readonly touched: boolean;
  readonly churn: number;
  readonly over: boolean;
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

const downstreamMatchers = DOWNSTREAM_PATHS.map(globToRegExp);

const isDownstreamPath = (path: string): boolean =>
  downstreamMatchers.some((matcher) => matcher.test(path));

function resolveBase(explicit: string | undefined): string {
  const candidates = [
    explicit,
    NodeProcess.env.LS_UPSTREAM_REF,
    "upstream/main",
    "origin/upstream",
  ];
  for (const candidate of candidates) {
    if (candidate && gitRefExists(candidate)) return candidate;
  }
  throw new Error(
    `no upstream ref found (tried ${candidates.filter(Boolean).join(", ")}); run: git fetch upstream main`,
  );
}

function collectChanges(mergeBase: string, committed: boolean): ReadonlyArray<Change> {
  const range = committed ? [mergeBase, "HEAD"] : [mergeBase];
  const statusFields = git(["diff", "--name-status", "--no-renames", "-z", ...range]).split("\0");
  const numstatFields = git(["diff", "--numstat", "--no-renames", "-z", ...range]).split("\0");
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  for (const record of numstatFields) {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(record);
    if (!match) continue;
    counts.set(match[3]!, {
      added: match[1] === "-" ? null : Number(match[1]),
      removed: match[2] === "-" ? null : Number(match[2]),
    });
  }
  const changes: Array<Change> = [];
  for (let index = 0; index + 1 < statusFields.length; index += 2) {
    const status = statusFields[index]!;
    const path = statusFields[index + 1]!;
    if (status === "") continue;
    const count = counts.get(path) ?? { added: null, removed: null };
    changes.push({ status: status.charAt(0), path, ...count });
  }
  if (!committed) {
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter((path) => path !== "");
    for (const path of untracked) {
      changes.push({ status: "A", path, added: null, removed: null });
    }
  }
  return changes;
}

function churnFor(base: string, path: string): number {
  const output = run(
    "git",
    ["log", `--since=${CHURN_DAYS}.days`, "--format=%h", base, "--", path],
    { allowFailure: true },
  ).stdout;
  return output.split("\n").filter((line) => line !== "").length;
}

function main(): number {
  const { flags, values } = parseArgs(NodeProcess.argv.slice(2));
  const base = resolveBase(values.get("base"));
  const committed = flags.has("committed");
  const markdown = flags.has("markdown");
  const hooks = readHooks();
  const hooksByPath = new Map(hooks.map((hook) => [hook.path, hook]));
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  const changes = collectChanges(mergeBase, committed);

  const failures: Array<string> = [];
  const touched = new Map<string, Change>();
  for (const change of changes) {
    const hook = hooksByPath.get(change.path);
    if (hook) {
      touched.set(change.path, change);
      if (change.status === "D") failures.push(`hook file deleted: ${change.path} (${hook.id})`);
      continue;
    }
    if (change.status === "A" && isDownstreamPath(change.path)) continue;
    if (change.status === "A") {
      failures.push(`new file outside downstream paths: ${change.path}`);
    } else {
      failures.push(
        `upstream file changed but not in ${HOOKS_FILE}: ${change.path} (${change.status})`,
      );
    }
  }

  const reports: Array<HookReport> = hooks.map((hook) => {
    const change = touched.get(hook.path);
    const added = change?.added ?? 0;
    const removed = change?.removed ?? 0;
    const over = hook.budget !== null && added > hook.budget;
    if (over) {
      failures.push(`${hook.id} ${hook.path}: ${added} added lines, budget ${hook.budget}`);
    }
    return {
      hook,
      added,
      removed,
      touched: change !== undefined,
      churn: churnFor(base, hook.path),
      over,
    };
  });

  const downstreamCount = changes.filter(
    (change) => change.status === "A" && isDownstreamPath(change.path),
  ).length;
  const baseSha = git(["rev-parse", "--short", base]).trim();
  const mergeBaseSha = git(["rev-parse", "--short", mergeBase]).trim();

  if (markdown) {
    console.log(`Upstream ref \`${base}\` (${baseSha}), merge base \`${mergeBaseSha}\`.`);
    console.log("");
    console.log(`| Hook | File | Added | Removed | Budget | ${CHURN_DAYS}d churn | Status |`);
    console.log("| --- | --- | --- | --- | --- | --- | --- |");
    for (const report of reports) {
      const status = report.over ? "OVER" : report.touched ? "ok" : "unused";
      console.log(
        `| ${report.hook.id} | \`${report.hook.path}\` | ${report.added} | ${report.removed} | ${report.hook.budget ?? "-"} | ${report.churn} | ${status} |`,
      );
    }
    console.log("");
    console.log(`${downstreamCount} new downstream files.`);
    if (failures.length > 0) {
      console.log("");
      console.log("Failures:");
      for (const failure of failures) console.log(`- ${failure}`);
    }
  } else {
    console.log(`conflict-surface: upstream ${base} (${baseSha}), merge base ${mergeBaseSha}`);
    for (const report of reports) {
      const status = report.over ? "OVER" : report.touched ? "ok" : "unused";
      console.log(
        [
          report.hook.id.padEnd(7),
          `+${report.added}/-${report.removed}`.padEnd(10),
          `budget ${report.hook.budget ?? "-"}`.padEnd(10),
          `churn ${report.churn}`.padEnd(9),
          status.padEnd(6),
          report.hook.path,
        ].join(" "),
      );
    }
    console.log(`${downstreamCount} new downstream files`);
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.log(
      failures.length === 0
        ? "conflict-surface: ok"
        : `conflict-surface: ${failures.length} failure(s)`,
    );
  }
  return failures.length === 0 ? 0 : 1;
}

NodeProcess.exit(runMain(main));
