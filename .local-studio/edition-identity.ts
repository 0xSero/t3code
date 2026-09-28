import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

interface EditionIdentity {
  readonly cliReleaseRepository: string;
  readonly cliReleaseTagPrefix: string;
  readonly desktopStateDir: string;
  readonly appId: string;
  readonly productName: string;
  readonly updateFeedTag: string;
}

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const identity: EditionIdentity = JSON.parse(
  NodeFS.readFileSync(NodePath.join(repoRoot, ".local-studio/edition.json"), "utf8"),
);

const releaseBaseUrl = (tag: string) =>
  `https://github.com/${identity.cliReleaseRepository}/releases/download/${tag}`;

const replaceLiteral = (file: string, name: string, value: string) => {
  const path = NodePath.join(repoRoot, file);
  const source = NodeFS.readFileSync(path, "utf8");
  const pattern = new RegExp(`(const ${name} = )"[^"]*"`);
  if (!pattern.test(source)) throw new Error(`${name} not found in ${file}`);
  NodeFS.writeFileSync(path, source.replace(pattern, `$1${JSON.stringify(value)}`));
};

const apply = () => {
  const cliFile = "packages/shared/src/cliReleaseRepository.ts";
  replaceLiteral(cliFile, "CLI_RELEASE_REPOSITORY", identity.cliReleaseRepository);
  replaceLiteral(cliFile, "CLI_RELEASE_TAG_PREFIX", identity.cliReleaseTagPrefix);
  replaceLiteral(
    "apps/desktop/src/app/editionIdentity.ts",
    "DEFAULT_STATE_DIR",
    identity.desktopStateDir,
  );
  console.log(`edition identity applied: ${identity.productName}`);
};

const env = (controllerDir: string | undefined) => {
  const lines = [
    `T3CODE_EDITION_APP_ID=${identity.appId}`,
    `T3CODE_EDITION_PRODUCT_NAME=${identity.productName}`,
    `T3CODE_EDITION_UPDATE_FEED_URL=${releaseBaseUrl(identity.updateFeedTag)}`,
    "T3CODE_MAC_PASSKEY_SIGNING=off",
    ...(controllerDir ? [`T3CODE_EDITION_CONTROLLER_DIR=${NodePath.resolve(controllerDir)}`] : []),
  ];
  console.log(lines.join("\n"));
};

const feed = (assetsDir: string, version: string) => {
  const base = releaseBaseUrl(`${identity.cliReleaseTagPrefix}${version}`);
  const manifests = NodeFS.readdirSync(assetsDir).filter((name) =>
    /^(latest|nightly).*\.ya?ml$/.test(name),
  );
  if (manifests.length === 0) throw new Error(`no update manifests in ${assetsDir}`);
  for (const name of manifests) {
    const path = NodePath.join(assetsDir, name);
    const source = NodeFS.readFileSync(path, "utf8");
    const rewritten = source.replace(
      /^(\s*(?:- )?(?:url|path): )(?!https?:\/\/)(\S+)$/gm,
      (_match, prefix: string, file: string) => `${prefix}${base}/${encodeURIComponent(file)}`,
    );
    NodeFS.writeFileSync(path, rewritten);
    console.log(`${name} -> ${base}`);
  }
};

const [command, ...args] = process.argv.slice(2);
if (command === "apply") apply();
else if (command === "env") env(args[0]);
else if (command === "feed" && args[0] && args[1]) feed(args[0], args[1]);
else if (command === "tag") console.log(identity.cliReleaseTagPrefix);
else if (command === "feed-tag") console.log(identity.updateFeedTag);
else {
  console.error(
    "usage: edition-identity.ts apply | env [controllerDir] | feed <assetsDir> <version> | tag | feed-tag",
  );
  process.exit(1);
}
