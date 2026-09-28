# Upstream sync, CI and the conflict-surface gate

The edition follows `pingdotgg/t3code` main by merging, never rebasing. Every upstream file the edition edits is a hook listed in `.local-studio/hooks.txt`; everything else lives in new files. The scripts below keep that true and make the merge mostly automatic.

## Branches

| Branch                    | Written by                       | Contents                                       |
| ------------------------- | -------------------------------- | ---------------------------------------------- |
| `upstream`                | the sync workflow only           | Fast-forward mirror of `pingdotgg/t3code` main |
| `local-studio`            | the sync workflow and merged PRs | The edition (default branch)                   |
| `sync/<date>-<run>-<try>` | the sync workflow                | One merge attempt, deleted once it lands       |
| `feat/*`, `wu/*`          | people and agents                | Work in progress, merged into `local-studio`   |

## Scripts (`scripts/local-studio/`)

All TypeScript scripts run directly with `node` (type stripping, Node 24 or newer) and need no build.

| Command                                                   | What it does                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/local-studio/conflict-surface.ts`           | The conflict-surface gate. Diffs the working tree (or `--committed` for `HEAD` only) against the merge base with upstream. Exits 1 on an unlisted upstream edit, a new file outside the downstream paths, a deleted hook file or a hook over budget. |
| `node scripts/local-studio/check-generated.ts`            | Checks that the vendored contracts, the pi-acp bundle and `routeTree.gen.ts` match what their generators produce. Leaves the tree unchanged.                                                                                                         |
| `node scripts/local-studio/sync-contracts.ts --check`     | Regenerates `packages/local-studio-contracts/src` from the pinned Local Studio commit into memory and compares byte for byte.                                                                                                                        |
| `node scripts/local-studio/sync-contracts.ts [--ref <r>]` | Refreshes the vendored contracts from `<r>` (default: the pinned commit) and rewrites `.local-studio/contracts.lock`.                                                                                                                                |
| `node scripts/local-studio/route-tree.ts`                 | Regenerates `apps/web/src/routeTree.gen.ts` with the TanStack Router generator, the same one the web build uses.                                                                                                                                     |
| `bash scripts/local-studio/resolve-generated.sh [--all]`  | During a merge: takes upstream's side of each conflicted generated file (budget `-` in hooks.txt) and regenerates it. Refuses, listing them, when other files conflict. `--all` regenerates both.                                                    |
| `bash scripts/local-studio/upstream-merge.sh ...`         | What the sync workflow runs: merges an upstream ref into a target on a new branch, resolves generated files, and writes `status` (`up-to-date`, `merged`, `conflict`) and SHAs to a report dir.                                                      |

### Conflict surface

- Upstream ref: `--base <ref>`, else `$LS_UPSTREAM_REF`, else `upstream/main`, else `origin/upstream`. Run `git fetch upstream main` first.
- Downstream paths, where new files are always allowed: `packages/local-studio-*/**`, `apps/server/src/localStudio/**`, `apps/server/src/provider/localStudio/**`, `apps/web/src/localStudio/**`, `apps/web/src/routes/local-ai*.tsx`, `packages/shared/src/cliReleaseRepository.ts`, `apps/desktop/src/app/editionIdentity.ts`, `scripts/local-studio/**`, `.github/workflows/ls-*`, `.local-studio/**`, `docs/local-studio/**`.
- A hook's budget counts added lines against the merge base. Rewriting one line counts as one added line.
- The output lists every hook with its added and removed lines, budget, commits to that file upstream in the last 60 days, and `ok`, `OVER` or `unused`. `--markdown` prints the same as a table.
- Adding a hook means adding a line to `.local-studio/hooks.txt` (tab separated: path, added-line budget or `-`, hook id, purpose) in the same PR, where reviewers see it.

### Vendored contracts

- `.local-studio/contracts.lock` pins `repository`, `path` and `commit`. `source` is an optional local checkout used when it has the commit.
- Source lookup: `--source <dir>`, else `$LOCAL_STUDIO_SOURCE`, else the lock's `source`, else a shallow fetch of the pinned commit from `https://github.com/<repository>.git` (public, so CI needs no token). `--source remote` forces the fetch.
- Transforms, recorded in the lock, applied in this order: relative imports `"./x"` become `"./x.ts"`, then `vp fmt` with this repo's formatter config (through `--stdin-filepath`, so the output is identical to formatting the file in place).
- To move the pin: `node scripts/local-studio/sync-contracts.ts --ref <commit-or-branch>` with a Local Studio checkout available, then run the gates and commit the lock and the package together.

### pi-acp bundle

`check-generated.ts` verifies that `PI_ACP_BUNDLE_SHA256` is the SHA-256 of `PI_ACP_BUNDLE_SOURCE`. The all-zero hash with an empty source is the unbuilt stub and passes. Once the bundle is real, `packages/local-studio-pi-acp/package.json` must define a `bundle:check` script that rebuilds the bundle and compares it; `check-generated.ts` runs it and fails if it is missing.

## Workflows

### `ls-ci.yml`

Runs on pull requests into `local-studio`, on `workflow_dispatch` (`ref`, `artifacts`), and as a reusable workflow from the sync job.

- **Gates:** `vp install --frozen-lockfile`, conflict surface (`--committed` against upstream main), generated files, `knip:check`, `vp check` (lint and format), typecheck, `build:desktop`, preload bundle check. The conflict-surface table goes into the job summary.
- **Upstream tests:** upstream's own suites, unchanged: the non-server packages, and the server in 4 shards.
- **Unsigned desktop:** Linux x64 AppImage and macOS arm64 DMG, built with `dist:desktop:artifact` and no signing, uploaded as workflow artifacts for 7 days. Only for pull requests or a dispatch with `artifacts: true`. Signed releases are built in `sybil-solutions/local-studio` (owner decision 3), not here.

### `ls-upstream-sync.yml`

Runs every 4 hours (`17 */4 * * *`) and on `workflow_dispatch` with `target` (default `local-studio`) and `dry_run`.

1. **Merge:** checks out the target, restores `.git/rr-cache`, fetches upstream main, fast-forwards the fork's `upstream` branch (only when the target is `local-studio` and it is not a dry run), then runs `upstream-merge.sh`. Generated files are regenerated after every merge, clean or not. If upstream is already contained, the run stops here.
2. **Gates:** a clean merge is pushed to its `sync/*` branch and checked with `ls-ci.yml`.
3. **Publish or report:**
   - Gates green: the target is fast-forwarded to the merge (a plain push, so it fails rather than overwrite if the target moved), the sync branch is deleted, and if the repo variables `LS_RELEASE_REPO` and `LS_RELEASE_WORKFLOW` are set, that workflow is dispatched with `channel=nightly` and `ref=<merge sha>` using the `LS_RELEASE_TOKEN` secret.
   - Conflict or red gates: a report (conflicted files with resolution commands, or the failing jobs and steps, plus the hook table) goes to the job summary and to a PR labelled `upstream-sync` into the target. If such a PR is already open, the report is added as a comment instead, so a human's resolution on that branch is never overwritten.
   - A dry run never pushes the target or the mirror, never opens or comments on a PR and never dispatches a release. It still pushes the `sync/*` branch the gates need.

### One-time repository setup (settings, not diff)

- Enable Actions for the fork. GitHub disables workflows on a fork that was created with workflow files until someone enables them on the Actions tab; until then `gh workflow list` is empty and nothing runs.
- Disable upstream's workflows on the fork (`ci.yml`, `release.yml`, `deploy-relay.yml`, `mobile-*`, `publish-aur.yml`, `web-preview.yml`, `pr-vouch.yml`, `pr-size.yml`, `issue-labels.yml`, `thread-transfer-report.yml`, `cursor-hygiene-webhook.yml`, `windows-tests.yml`, `desktop-macos-preview*.yml`) with `gh workflow disable`.
- Secret `LS_SYNC_TOKEN`: a token with `contents`, `pull-requests` and `workflows` write on the fork. `GITHUB_TOKEN` cannot push commits that change `.github/workflows/*`, which upstream merges often do, and PRs it opens do not trigger `ls-ci.yml`. Without the secret the workflow falls back to `GITHUB_TOKEN` and fails on those merges.
- For release dispatch: variables `LS_RELEASE_REPO` (for example `sybil-solutions/local-studio`) and `LS_RELEASE_WORKFLOW` (for example `edition-release.yml`), and secret `LS_RELEASE_TOKEN` with `actions: write` there. The release workflow must accept `channel` and `ref` inputs.
- `workflow_dispatch` and `schedule` only see workflow files on the default branch, so both workflows start working once this PR lands on `local-studio`.

## Resolving a sync PR by hand

```sh
git fetch origin upstream
git checkout -B sync/<name> origin/sync/<name>
git merge origin/local-studio
bash scripts/local-studio/resolve-generated.sh
git add <resolved files> && git commit
node scripts/local-studio/conflict-surface.ts
git push origin sync/<name>
```

Keep each hook a one-to-three-line import and spread. If upstream moved the code a hook edits, move the hook with it and keep it within budget; raising a budget is a reviewed change to `.local-studio/hooks.txt`.

With `git config rerere.enabled true` locally, a resolution you record is reused the next time the same conflict appears. The sync job keeps its own `rr-cache` between runs.
