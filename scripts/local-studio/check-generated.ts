// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { parseArgs, repoRoot, run, vpBin } from "./lib.ts";
import { ROUTE_TREE_FILE, generateRouteTree } from "./route-tree.ts";
import { checkContracts } from "./sync-contracts.ts";

const PI_ACP_DIR = "packages/local-studio-pi-acp";
const PI_ACP_BUNDLE = `${PI_ACP_DIR}/src/bundle.generated.ts`;
const STUB_SHA256 = "0".repeat(64);

interface Check {
  readonly name: string;
  readonly run: () => Promise<ReadonlyArray<string>>;
}

async function checkPiAcpBundle(): Promise<ReadonlyArray<string>> {
  const bundlePath = NodePath.join(repoRoot, PI_ACP_BUNDLE);
  const bundle = (await import(NodeURL.pathToFileURL(bundlePath).href)) as {
    readonly PI_ACP_BUNDLE_SOURCE: string;
    readonly PI_ACP_BUNDLE_SHA256: string;
  };
  const problems: Array<string> = [];
  const isStub = bundle.PI_ACP_BUNDLE_SOURCE === "" && bundle.PI_ACP_BUNDLE_SHA256 === STUB_SHA256;
  if (isStub) {
    console.log(`  ${PI_ACP_BUNDLE} is the unbuilt stub`);
  } else {
    const digest = NodeCrypto.createHash("sha256")
      .update(bundle.PI_ACP_BUNDLE_SOURCE)
      .digest("hex");
    if (digest !== bundle.PI_ACP_BUNDLE_SHA256) {
      problems.push(
        `${PI_ACP_BUNDLE}: PI_ACP_BUNDLE_SHA256 ${bundle.PI_ACP_BUNDLE_SHA256} != sha256(source) ${digest}`,
      );
    }
  }
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repoRoot, PI_ACP_DIR, "package.json"), "utf8"),
  ) as { readonly name: string; readonly scripts?: Record<string, string> };
  if (manifest.scripts?.["bundle:check"]) {
    const result = run(vpBin(), ["run", "--filter", manifest.name, "bundle:check"], {
      allowFailure: true,
    });
    if (result.status !== 0) {
      problems.push(
        `${manifest.name} bundle:check failed\n${result.stdout}${result.stderr}`.trim(),
      );
    }
  } else if (!isStub) {
    problems.push(
      `${PI_ACP_DIR}/package.json has no bundle:check script to rebuild and compare the bundle`,
    );
  }
  return problems;
}

async function checkRouteTree(): Promise<ReadonlyArray<string>> {
  const path = NodePath.join(repoRoot, ROUTE_TREE_FILE);
  const before = NodeFS.readFileSync(path, "utf8");
  try {
    await generateRouteTree();
    const after = NodeFS.readFileSync(path, "utf8");
    return after === before
      ? []
      : [`${ROUTE_TREE_FILE} is stale; run node scripts/local-studio/route-tree.ts`];
  } finally {
    NodeFS.writeFileSync(path, before);
  }
}

const sourceArg = parseArgs(NodeProcess.argv.slice(2)).values.get("contracts-source");

const CHECKS: ReadonlyArray<Check> = [
  { name: "contracts", run: async () => checkContracts(sourceArg) },
  { name: "pi-acp bundle", run: checkPiAcpBundle },
  { name: "route tree", run: checkRouteTree },
];

let failures = 0;
for (const check of CHECKS) {
  try {
    const problems = await check.run();
    for (const problem of problems) console.error(`FAIL ${check.name}: ${problem}`);
    console.log(`${problems.length === 0 ? "ok  " : "FAIL"} ${check.name}`);
    failures += problems.length;
  } catch (error) {
    console.error(`FAIL ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
    failures += 1;
  }
}
console.log(failures === 0 ? "check-generated: ok" : `check-generated: ${failures} failure(s)`);
NodeProcess.exit(failures === 0 ? 0 : 1);
