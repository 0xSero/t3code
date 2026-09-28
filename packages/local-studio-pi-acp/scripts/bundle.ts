import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "esbuild";

const packageRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const entryPoint = NodePath.join(packageRoot, "src", "main.ts");
const distFile = NodePath.join(packageRoot, "dist", "pi-acp.mjs");
const generatedFile = NodePath.join(packageRoot, "src", "bundle.generated.ts");

const bundleSource = async (): Promise<string> => {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    write: false,
    legalComments: "none",
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("esbuild produced no output");
  return output.text;
};

const count = (text: string, char: string): number => text.split(char).length - 1;

const stringLiteral = (value: string): string => {
  const json = JSON.stringify(value);
  if (count(value, '"') <= count(value, "'")) return json;
  const body = json
    .slice(1, -1)
    .replace(/\\(.)|'/g, (match, escaped: string | undefined) =>
      escaped === undefined ? "\\'" : escaped === '"' ? '"' : match,
    );
  return `'${body}'`;
};

const generatedModule = (source: string, sha256: string): string =>
  [
    "export const PI_ACP_BUNDLE_SOURCE: string =",
    `  ${stringLiteral(source)};`,
    "export const PI_ACP_BUNDLE_SHA256: string =",
    `  ${JSON.stringify(sha256)};`,
    "",
  ].join("\n");

const readText = (path: string): string | null => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const source = await bundleSource();
const sha256 = NodeCrypto.createHash("sha256").update(source).digest("hex");
const expected = generatedModule(source, sha256);

if (process.argv.includes("--check")) {
  if (readText(generatedFile) !== expected) {
    process.stderr.write(
      "pi-acp: src/bundle.generated.ts is stale. Run: pnpm --filter @local-studio/pi-acp run bundle\n",
    );
    process.exit(1);
  }
  process.stdout.write(`pi-acp: bundle is fresh (sha256 ${sha256})\n`);
} else {
  NodeFS.mkdirSync(NodePath.dirname(distFile), { recursive: true });
  NodeFS.writeFileSync(distFile, source);
  NodeFS.writeFileSync(generatedFile, expected);
  process.stdout.write(
    `pi-acp: wrote dist/pi-acp.mjs and src/bundle.generated.ts (sha256 ${sha256})\n`,
  );
}
