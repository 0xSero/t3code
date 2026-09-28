// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { repoRoot } from "./lib.ts";

export const WEB_ROOT = NodePath.join(repoRoot, "apps", "web");
export const ROUTE_TREE_FILE = "apps/web/src/routeTree.gen.ts";

interface RouterGeneratorModule {
  readonly Generator: new (options: { config: unknown; root: string }) => {
    run: () => Promise<void>;
  };
  readonly getConfig: (inline: object, root: string) => unknown;
}

export async function generateRouteTree(): Promise<void> {
  const webRequire = NodeModule.createRequire(NodePath.join(WEB_ROOT, "package.json"));
  const pluginRequire = NodeModule.createRequire(
    webRequire.resolve("@tanstack/router-plugin/package.json"),
  );
  const generator = pluginRequire("@tanstack/router-generator") as RouterGeneratorModule;
  const config = generator.getConfig({}, WEB_ROOT);
  await new generator.Generator({ config, root: WEB_ROOT }).run();
}

if (import.meta.main) {
  await generateRouteTree();
  console.log(`route-tree: regenerated ${ROUTE_TREE_FILE}`);
}
