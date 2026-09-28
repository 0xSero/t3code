# Local Studio edition: identity and releases

## Where releases live

- Signed releases are built by `.github/workflows/edition-release.yml` in `sybil-solutions/local-studio`, because the Apple signing secrets exist only in that repository's `release-signing` environment.
- That workflow checks out this fork (`0xSero/t3code`, default ref `local-studio`), bundles the Local Studio controller built from a pinned ref of `sybil-solutions/local-studio`, then builds, signs, notarizes and publishes.
- Each edition release is tagged `code-v<version>` in `sybil-solutions/local-studio`, which keeps it apart from Local Studio's own `v*` tags. Edition releases are published with `--latest=false`, so Local Studio's own updater, which follows `/releases/latest`, never sees them. Nightlies are also marked prerelease.
- The desktop update feed is the rolling release `code-feed`. It holds `latest-mac.yml` (stable) and `nightly-mac.yml` (nightly). Their file URLs are absolute and point into the matching `code-v<version>` release.
- This fork's own CI builds unsigned artifacts for PR checks only.

## Identity values

`.local-studio/edition.json` holds every edition value:

| Key                    | Value                          | Used by                                                                        |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `cliReleaseRepository` | `sybil-solutions/local-studio` | `t3 update`, remote installs (`CLI_RELEASE_REPOSITORY`)                        |
| `cliReleaseTagPrefix`  | `code-v`                       | CLI release URLs and tag matching (`CLI_RELEASE_TAG`)                          |
| `desktopStateDir`      | `.local-studio/t3`             | desktop state under `~/.local-studio/t3` (`DEFAULT_STATE_DIR`)                 |
| `appId`                | `ai.localstudio.t3`            | macOS bundle id                                                                |
| `productName`          | `Local Studio Code`            | app name, DMG title, artifact names `Local-Studio-Code-<version>-<arch>.<ext>` |
| `updateFeedTag`        | `code-feed`                    | the generic update feed URL baked into `app-update.yml`                        |

The source tree keeps upstream values in `packages/shared/src/cliReleaseRepository.ts` and `apps/desktop/src/app/editionIdentity.ts`, because upstream tests (`cliRelease.test.ts`, `DesktopEnvironment.test.ts`) assert them and the sync gate runs those tests. A release build applies the edition values first:

```sh
node .local-studio/edition-identity.ts apply
```

It rewrites the literals in those two files. Never commit the result; `git checkout -- packages/shared/src/cliReleaseRepository.ts apps/desktop/src/app/editionIdentity.ts` restores them.

## Build environment (hooks H9 and H11)

`scripts/build-desktop-artifact.ts` reads these variables. Unset, the build is exactly upstream's.

| Variable                         | Effect                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `T3CODE_EDITION_APP_ID`          | replaces `com.t3tools.t3code`                                                                  |
| `T3CODE_EDITION_PRODUCT_NAME`    | product name (`<name> (Nightly)` on nightly versions) and artifact name prefix                 |
| `T3CODE_EDITION_UPDATE_FEED_URL` | publish config becomes `{provider: generic, url, channel}` instead of GitHub                   |
| `T3CODE_EDITION_CONTROLLER_DIR`  | absolute path to an extracted controller tarball; copied to `Contents/Resources/local-studio/` |
| `T3CODE_MAC_PASSKEY_SIGNING=off` | signed macOS builds skip the Clerk passkey entitlements and provisioning profile               |

`node .local-studio/edition-identity.ts env [controllerDir]` prints them as `KEY=value` lines for `$GITHUB_ENV`. The values contain spaces, so load them locally with `while IFS= read -r l; do export "$l"; done < edition.env`. Do not `source` the file.

The bundled controller sits at `<app>/Contents/Resources/local-studio/local-studio`, with its web UI in `local-studio/ui`. In the packaged app that is `process.resourcesPath + "/local-studio/local-studio"`, which the sidecar tries before `LOCAL_STUDIO_BIN`, `~/.local-studio/bin/local-studio` and PATH.

## Local unsigned macOS arm64 build

```sh
cd /Users/sero/projects/worktrees/local-ai-system
LOCAL_STUDIO_TARGETS=bun-darwin-arm64 bash scripts/release.sh
mkdir -p <scratch>/controller
tar -xzf dist/local-studio-<ver>-darwin-arm64.tar.gz -C <scratch>/controller

cd <edition worktree>
node .local-studio/edition-identity.ts apply
node .local-studio/edition-identity.ts env <scratch>/controller > <scratch>/edition.env
while IFS= read -r l; do export "$l"; done < <scratch>/edition.env
pnpm run dist:desktop:dmg:arm64 --verbose
git checkout -- packages/shared/src/cliReleaseRepository.ts apps/desktop/src/app/editionIdentity.ts
```

The output is `release/Local-Studio-Code-<version>-arm64.dmg`, plus the zip, blockmaps and `latest-mac.yml`. Check the bundled controller without touching a running one on :8080:

```sh
app="release/mac-arm64/Local Studio Code.app"
cat "$app/Contents/Resources/app-update.yml"
"$app/Contents/Resources/local-studio/local-studio" serve --host 127.0.0.1 --port 18090 --home <scratch>/ls-home
curl -s http://127.0.0.1:18090/health
```

An unsigned build cannot install updates (Squirrel.Mac needs a signed app), and macOS Gatekeeper quarantines it when it is downloaded.

## Publishing (in sybil-solutions/local-studio)

Run the `Edition Release` workflow with `channel` (`nightly` or `stable`), `version` (stable only), `edition_ref` (default `local-studio`) and `controller_ref` (default `feat/local-ai-system`). Jobs:

1. `preflight` resolves the version (nightly: `<server version>-nightly.<yyyymmdd>.<run>`) and refuses an existing tag.
2. `desktop-mac` builds the controller, applies identity, builds, signs and notarizes the DMG and zip, verifies the signature, the stapled ticket, `app-update.yml` and the bundled controller, then builds the signed darwin-arm64 CLI archive.
3. `cli-linux` builds the linux-x64 and linux-arm64 CLI archives.
4. `publish` writes `SHA256SUMS`, creates the `code-v<version>` release, rewrites the manifests to absolute URLs and uploads them to `code-feed`.

## Known limits

- SSH remote installs (`packages/ssh/src/tunnel.ts`) build archive URLs as `<base>/v<version>/...` themselves, outside the hook list. On an edition build they still use the `v` prefix and fail against `code-v` releases unless `T3CODE_RELEASE_BASE_URL` points at a mirror laid out that way.
- Notarizing the CLI archive needs the App Store Connect API key (`APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`). With only the Apple ID secrets, the archive is Developer ID signed but not notarized.
- Only macOS arm64 desktop builds are produced.
