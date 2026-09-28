# Build plan: Local Studio Edition of T3 Code (one PR)

Base: upstream `pingdotgg/t3code` main @ `d15210cd` (2026-09-27). I re-read these upstream sources to confirm the plan: `builtInDrivers.ts`, `providerDriverMeta.ts`, `mainAppLocation.ts`, `SidebarChrome.tsx` (Usage button at lines 159–197), `cliRelease.ts:8`, `DesktopStatePaths.ts:19`, `server.ts:591` (`makeRoutesLayer`), `device/DeviceHubProxy.ts`, and `apps/server/vite.config.ts:80`.

---

## Decisions

**D1. Repo, branch and PR**

- The work lives in the fork `0xSero/t3code`, which stays in upstream's fork network.
- Three branches:
  - `upstream` is a fast-forward-only mirror of `pingdotgg/t3code` main. Only the sync bot writes to it.
  - `local-studio` is cut from `d15210cd` or later and becomes the fork's default branch.
  - `legacy/droid-main` is the old `main`, renamed and kept as it is.
- The single PR is `feat/local-studio-edition` → `local-studio`.
- The Local Studio monorepo is not used, and this PR needs no change in it.
- Why the fork:
  - The toolchains differ: pnpm 11 with `vp` here, bun in Local Studio.
  - Upstream ships about 37 commits a day, which would flood Local Studio PRs.
  - The two repos have conflicting test policies.
  - The fork's GitHub Releases can serve as the update feed as they are.
- New work is done in a fresh clone or worktree, never in `/Users/sero/ai/projects/t3code`, which has uncommitted work.

**D2. Merge, don't rebase**

- `local-studio` takes upstream through merge commits, so release tags stay reachable.
- `git rerere` is on, and CI caches `.git/rr-cache`.
- Every upstream file we edit is listed in `.local-studio/hooks.txt`. A CI gate fails the build if the set of touched upstream files grows, or if the hook diff goes over its line budget.

**D3. Hook pattern: spread an array or add one import, never inline logic**

- Each hook edit is 1–3 lines. It imports a downstream module that we own and spreads its array, or renders its component.
- New downstream drivers, routes and definitions never touch a hook file again.
- Hooks sit in files with low churn wherever possible. The one exception is `server.ts`: 2 lines in a list that git usually auto-merges.

**D4. Where downstream code goes**

- **Pure code** goes in new workspace packages under `packages/local-studio-*`. The existing `packages/*` glob picks them up, so `pnpm-workspace.yaml` needs no edit. This covers the pi bridge, settings schemas, config builders, vendored contracts and view derivations.
- **Code that needs app internals** goes in new directories inside the apps:
  - `apps/server/src/localStudio/`
  - `apps/server/src/provider/localStudio/`
  - `apps/web/src/localStudio/`
- The reason for the split: `apps/server` and `apps/web` have no package exports. A package that imported `AcpSessionRuntime` or `~/components/ui` would need relative imports into app internals, or would create a cycle.

**D5. Both pi and omp run over ACP through upstream's `AcpSessionRuntime`**

- omp: `omp --mode acp` (verified: `initialize` works, `session/new` returns config options `mode`, `model` and `thinking`).
- pi has no ACP, so it gets our own bridge, `@local-studio/pi-acp`, which speaks pi's `--mode rpc` JSONL on one side and ACP on the other.
- One downstream driver module then serves both. Upstream keeps maintaining event normalization, cancel, load/resume and permissions.
- A direct RPC adapter was rejected. It would duplicate the session machinery, and omp's RPC approvals are free-text selects with no tool-call id.
- The third-party `pi-acp` npm package was rejected. It reads `$HOME/.pi` and passes the whole `process.env` through.

**D6. How the pi bridge ships**

- The bridge package builds to one ESM file.
- That file is committed as a TS module that exports it as a string: `packages/local-studio-pi-acp/src/bundle.generated.ts`. A CI check keeps it in sync with the source.
- At runtime the driver writes it atomically to `<T3 home>/local-studio/pi-acp-<sha8>.mjs` and runs it with the Node that runs pi.
- Node resolution order: pi's shebang interpreter, then `node` on PATH, then `process.execPath` with `ELECTRON_RUN_AS_NODE=1` when the server is not the single-executable CLI.
- As a result the server needs no build-config hook and no extra bundle entry.

**D7. Runtime: the T3 server owns the Local Studio controller as a sidecar**

- The sidecar is a scoped Effect layer merged into the route layer, so it is 1 hook line. It works in desktop and in headless `t3 serve`, for example on pop-os.
- Startup rules:
  - Reuse any controller that answers `GET /health` with `service === "local-studio"`.
  - Otherwise spawn `local-studio serve --host 127.0.0.1 --port <p> --tailnet`.
  - Never kill a controller we did not spawn.
- Binary lookup order: `LOCAL_STUDIO_BIN`, then `~/.local-studio/bin/local-studio`, then PATH.
- If no binary is found, the Local AI area offers "Install controller". It downloads the pinned Local Studio release tarball and checks its SHA256.
- The controller is not bundled into the Electron app. The two release trains stay independent, and the packaging stays free of hooks. Bundling is open question Q2.

**D8. The browser never talks to the controller directly**

- All controller calls go through a new authenticated same-origin proxy, `/api/local-studio/*`, on the T3 server. It copies the `DeviceHubProxy` pattern: environment session with read scope, and operate scope for mutations.
- The proxy reaches a local controller on `http://127.0.0.1:<port>`:
  - It sends no `Origin` and no `x-forwarded-*` headers, so the controller's loopback trust grants admin.
  - Browser `cookie`, `authorization` and `origin` headers are dropped.
- For a remote controller, it sends an admin or federation Bearer key that is stored server-side at 0600 and never returned to the browser.
- `/api/events` SSE is streamed through unbuffered.
- This also means Local AI works from phones and remote T3 clients with no change: each T3 environment proxies its own controller.

**D9. Machines vs T3 environments vs T3 Connect**

- **T3 Connect stays off:** no Clerk, relay or Cloudflare.
- **Local AI machines are Local Studio federation machines.** Data comes from `/api/fleet`, and actions on a peer go through `/api/peers/:id/*`. They are independent of T3 environments.
- The Local AI area always shows the controller of the **active T3 environment**. Adding pop-os as a T3 environment through the existing `t3 serve --host <tailnet-ip>` / `t3 pair --tailscale` gives pop-os-local agents and pop-os's Local AI view for free.
- Automatic "machine → T3 environment" pairing needs Local Studio to supervise `t3 serve` and mint pairing links. That is deferred to a follow-up; see Q4.

**D10. Isolation and gateway wiring for pi and omp**

- Config directory: `D = ~/.local-studio/agents/t3/<pi|omp>`.
  - It holds `models.json` (pi) or `models.yml` (omp, JSON content) with a `localstudio` provider: `baseUrl=<gateway>/v1`, `api:"openai-completions"`, `apiKey:"!cat '<D>/gateway.key'"`.
  - It also sets `headers {X-Local-Studio-Client, X-Local-Studio-Workspace:"${LOCAL_STUDIO_WORKSPACE}"}`.
  - Models are those from `/v1/models` where `local_studio.state==="ready"`.
- No output-length cap:
  - pi gets `maxTokens = contextWindow`, because pi otherwise sends `max_completion_tokens=16384`; with that value pi clamps to the remaining context.
  - omp gets `omitMaxOutputTokens:true`.
- Gateway keys:
  - The T3 server issues one key per harness through the controller's `POST /api/keys {client:"pi"|"omp", label:"t3", scope:"client"}`, over loopback admin.
  - It writes the key to `D/gateway.key` (0600, atomic rename) and keeps the key id in `local-studio.json`.
  - On a 401 it revokes the old key and issues a new one.
- Environment:
  - A strict allowlist is used, not the full `process.env`. `OPENAI_*`, `ANTHROPIC_*`, `OPENROUTER_API_KEY`, `GEMINI_*`, `GOOGLE_*`, `XAI_*`, `GROQ_*`, `MISTRAL_*`, `DEEPSEEK_*`, `AWS_*` and `AZURE_*` are stripped.
  - `LOCAL_STUDIO_WORKSPACE=<threadId>` is set.
  - pi also gets `PI_CODING_AGENT_DIR=D`, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`.
  - omp also gets `PI_CODING_AGENT_DIR=D`, `PI_CONFIG_DIR=relpath(D,$HOME)`, `OMP_SKIP_SETUP=1`.
- Mapping T3 runtime mode to omp `--approval-mode`:

| T3 runtime mode     | omp approval mode |
| ------------------- | ----------------- |
| `approval-required` | `always-ask`      |
| `auto-accept-edits` | `write`           |
| `auto`              | `write`           |
| `full-access`       | `yolo`            |

- For pi, when the mode is not full-access, the bridge loads `-e <D>/t3-approval-gate.ts`, which is also written at runtime.

**D11. Downstream settings**

- Downstream settings do not go in upstream `settings.ts`.
- Driver configs travel in `providerInstances[*].config`, which is `unknown` there, and are validated by each driver's `configSchema`.
- Controller connection settings live in a new file, `<T3 home>/userdata/local-studio.json`, owned by `apps/server/src/localStudio/LocalStudioConfig.ts`.

**D12. Local Studio contracts are vendored**

- `packages/local-studio-contracts` is a copy of Local Studio `packages/contracts` pinned to a commit and refreshed by `scripts/local-studio/sync-contracts.ts`.
- The web imports types, plus `fmt` and `formulas`.
- zod stays inside the vendored package only.

**D13. Release channels and identity**

- **Nightly is the main train.**
  - Every green upstream merge ships as `<upstream apps/server version>-nightly.<YYYYMMDD>.<run_number>`.
  - Downstream fixes also ship on nightly.
  - The version format matches upstream's regex `^[^-+]+-nightly\.\d{8}\.\d+$`.
- **Stable** is published once per upstream `vX.Y.Z` tag.
- **Identity:**
  - App id `ai.localstudio.t3`, product name "Local Studio Code". The final brand is Q1.
  - The desktop state dir is `~/.local-studio/t3`, so the edition can sit next to an upstream T3 install.
  - The update repo is `0xSero/t3code`.
- **Platforms:** Windows is off at first, because the Local Studio controller has no Windows build.

**D14. No automated tests are written**

- Acceptance is by commands and observed behaviour.
- The sync gate still runs **upstream's** existing tests, typecheck, lint and build.

---

## Architecture

```
┌─────────────────────────── Electron (apps/desktop, upstream + identity hook) ───────────────────────────┐
│  spawns T3 server (unchanged DesktopBackendManager, ELECTRON_RUN_AS_NODE, fd3 bootstrap)                │
└───────────────┬─────────────────────────────────────────────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────── T3 server (apps/server) ────────────────────────────────────────┐
│ upstream: ws.ts RPC (/ws), HttpApi, orchestration, ProviderService, AcpSessionRuntime …                 │
│                                                                                                          │
│ builtInDrivers.ts ──spread──► provider/localStudio/ (NEW)                                                │
│      PiDriver, OmpDriver (LocalStudioAgentDriver.ts)                                                     │
│      LocalStudioAcpSupport.ts ─► AcpSessionRuntime.make({spawn:…})                                        │
│      snapshot: /v1/models ready → ServerProvider.models; text-gen: gateway /v1/chat/completions           │
│                                                                                                          │
│ server.ts makeRoutesLayer ──1 line──► localStudio/ (NEW)                                                  │
│      LocalStudioRoutes.ts   /api/local-studio/*  (env-auth, header scrub, SSE passthrough)               │
│      ControllerSidecar.ts   reuse-or-spawn `local-studio serve`, backoff, scoped kill-if-owned            │
│      LocalStudioConfig.ts   <home>/userdata/local-studio.json (url, keyRef, sidecar mode)                  │
│      LocalStudioGateway.ts  service: gatewayUrl, models(), ensureHarnessKey(pi|omp)                      │
└───────┬──────────────────────────────────────┬──────────────────────────────────────────────────────────┘
        │ spawn (ACP stdio)                     │ HTTP loopback (no Origin / x-forwarded ⇒ admin)
        ▼                                       ▼
  omp --mode acp …                       Local Studio controller :8080 (unchanged, separate release)
  node pi-acp-<sha>.mjs ──rpc──► pi       /api/* snapshot|fleet|recipes|pods|models|metrics|agents|keys
        │                                 /v1/* gateway (chat, responses, messages, models)
        └──────── OpenAI-compat /v1 (key: !cat D/gateway.key) ──┘   ↔ peers over tailnet federation

┌──────────────────────────── T3 web (apps/web) ───────────────────────────────────────────────────────────┐
│ SidebarChrome ─1 line─► <LocalAiUtilityButton/>     mainAppLocation ─1 line─► isLocalAiPath()           │
│ routes/local-ai*.tsx (NEW, auto-registered)  ► apps/web/src/localStudio/** (NEW)                         │
│    state: SSE /api/local-studio/api/events → reducers (packages/local-studio-local-ai-model)             │
│    views: Machines&GPUs · Run (recipes, fit, Needs-setup, Pod) · Running models · Endpoints · Usage · Agents│
│ providerDriverMeta ─spread─► localStudio/providers/definitions.ts (pi, omp settings forms + icons)       │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
T3 Connect: disabled.  Remote machines: ordinary T3 environments over tailnet (existing upstream flow).
```

---

## Upstream touch-point list (complete)

Churn figures are commits to that file in the last 60 days, from the research pass.

| #   | Upstream file                                            | Edit                                                                                                                                                                                                | Lines   | Churn  | Why                                                                                           |
| --- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | --------------------------------------------------------------------------------------------- |
| H1  | `apps/server/src/provider/builtInDrivers.ts`             | import `{LOCAL_STUDIO_DRIVERS, type LocalStudioDriversEnv}` from `./localStudio/index.ts`; `\| LocalStudioDriversEnv`; `...LOCAL_STUDIO_DRIVERS`                                                    | 3       | 1      | Registers the pi and omp drivers                                                              |
| H2  | `apps/server/src/server.ts`                              | import `localStudioRouteLayer`; add it to the `Layer.mergeAll` list at about line 604 (next to `deviceHubProxyRouteLayer`)                                                                          | 2       | 50     | Proxy routes plus the scoped controller sidecar                                               |
| H3  | `apps/web/src/components/settings/providerDriverMeta.ts` | import and `...LOCAL_STUDIO_PROVIDER_CLIENT_DEFINITIONS` in `PROVIDER_CLIENT_DEFINITIONS`                                                                                                           | 2       | 2      | pi and omp in the Add-instance dialog and settings forms                                      |
| H4  | `apps/web/src/components/chat/providerIconUtils.ts`      | spread `LOCAL_STUDIO_PROVIDER_ICONS` into `PROVIDER_ICON_BY_PROVIDER`                                                                                                                               | 2       | low    | Icons in the picker and chat                                                                  |
| H5  | `apps/web/src/components/sidebar/SidebarChrome.tsx`      | import and `<LocalAiUtilityButton />` after the Usage item (about line 197)                                                                                                                         | 2       | 29–34  | Nav entry                                                                                     |
| H6  | `apps/web/src/components/sidebar/mainAppLocation.ts`     | import and `\|\| isLocalAiPath(pathname)`                                                                                                                                                           | 2       | 1      | Back-button behaviour on utility pages                                                        |
| H7  | `packages/shared/src/cliRelease.ts`                      | the `CLI_RELEASE_REPOSITORY` const becomes a re-export from new file `packages/shared/src/cliReleaseRepository.ts` (`"0xSero/t3code"`)                                                              | 2       | 5      | `t3 update` and remote installs pull edition builds, not upstream builds                      |
| H8  | `apps/desktop/src/app/DesktopStatePaths.ts`              | `".t3"` comes from new file `apps/desktop/src/app/editionIdentity.ts` (`DEFAULT_STATE_DIR = ".local-studio/t3"`)                                                                                    | 2       | 1      | Separate DB and settings from an upstream install                                             |
| H9  | `scripts/build-desktop-artifact.ts`                      | `DESKTOP_APP_ID`, `productName`, `artifactName` read `T3CODE_EDITION_*` env with the current values as defaults; passkey signing skipped when `T3CODE_MAC_PASSKEY_SIGNING=off`                      | ≤15     | 30     | Rebranding, and signed macOS builds without Clerk passkeys                                    |
| H10 | `apps/server/package.json`, `apps/web/package.json`      | one `workspace:*` dependency line each (server: `@local-studio/t3-providers`, `@local-studio/pi-acp`; web: `@local-studio/t3-providers`, `@local-studio/local-ai-model`, `@local-studio/contracts`) | ≤3 each | 29     | Workspace wiring                                                                              |
| G1  | `pnpm-lock.yaml`                                         | regenerated only                                                                                                                                                                                    | n/a     | 115    | On conflict, take upstream's version, then `vp install --lockfile-only`                       |
| G2  | `apps/web/src/routeTree.gen.ts`                          | regenerated only                                                                                                                                                                                    | n/a     | 15/90d | On conflict, take upstream's version, then regenerate through the router plugin at build time |

- **Not edited:** `contracts/settings.ts`, `contracts/rpc.ts`, `providerRuntime.ts`, `ws.ts`, `ChatView*`, `pnpm-workspace.yaml`, `knip.jsonc`, the desktop backend files, and upstream workflows.
- **Upstream workflows:** they are turned off in the fork's settings (`gh workflow disable`), which is not part of the diff.
- **Candidates to offer upstream as generic PRs, each removing one hook:**
  - H1 and H3/H4, as "extra driver lists".
  - H5/H6, as a sidebar nav slot.
  - H7–H9, as edition identity from env plus optional passkey signing.

---

## Sync & update pipeline

**Workflows:** all new, in `.github/workflows/`, prefixed `ls-`.

1. **`ls-upstream-sync.yml`**, on cron `17 */4 * * *` plus `workflow_dispatch`:
   1. Check out `local-studio` with full history and restore the `rr-cache`. Run `git remote add upstream https://github.com/pingdotgg/t3code`, fetch, and fast-forward the fork's `upstream` branch.
   2. Run `git merge --no-ff upstream/main` on a temporary branch `sync/<date>-<run>`.
   3. Auto-resolve G1/G2: `git checkout --theirs pnpm-lock.yaml apps/web/src/routeTree.gen.ts`, then `vp install --lockfile-only`. The route tree is regenerated in step 4's build.
   4. Gates:
      - `vp i --frozen-lockfile`
      - `vp run typecheck`
      - `vp run lint`
      - `vp run fmt:check`
      - `vp run knip:check`
      - `vp run test` (upstream's suite)
      - `vp run build:desktop`
      - `node scripts/local-studio/conflict-surface.ts`
      - `node scripts/local-studio/check-generated.ts` (checks that the pi-acp bundle and the vendored contracts are up to date)
   5. If everything is green, fast-forward `local-studio`, push, and `gh workflow run ls-release.yml -f channel=nightly`.
   6. If a conflict or gate fails, force-push `sync/*` and open or update a PR labelled `upstream-sync` with the conflict list, the failing gate, and each hook's churn. Save `rr-cache` either way.
2. **`ls-release.yml`**, on `workflow_dispatch {channel: nightly|stable, ref}`, plus a push of `v*` tags that the sync job mirrors when upstream tags:
   1. **preflight:** compute the version (nightly `X.Y.Z-nightly.YYYYMMDD.<run_number>`, stable = the upstream tag), then run `scripts/update-release-package-versions.ts`.
   2. **desktop:** call the reusable `./.github/workflows/release-desktop.yml` with a matrix of mac arm64, linux x64 and linux arm64, on GitHub-hosted runners with `relay_client_tracing:false`. Environment:
      - `T3CODE_DESKTOP_UPDATE_REPOSITORY=0xSero/t3code`
      - `T3CODE_EDITION_APP_ID=ai.localstudio.t3`
      - `T3CODE_EDITION_PRODUCT_NAME=…`
      - `T3CODE_MAC_PASSKEY_SIGNING=off`
      - signing secrets `CSC_LINK` and `APPLE_*`, when present
   3. **cli:** run `scripts/build-cli-archive.ts` for darwin-arm64, linux-x64 and linux-arm64, then `smoke-cli-archive.ts`.
   4. **publish:** run `scripts/merge-update-manifests.ts`, then `gh release create` in `0xSero/t3code` with the DMG/zip/AppImage, `latest*.yml`/`nightly*.yml`, blockmaps, CLI tarballs and `SHA256SUMS`. Nightly releases are marked prerelease.
3. **`ls-ci.yml`**, on PRs to `local-studio`: the same gates as sync step 4, without publishing.

**One-time setup, as settings rather than diff:**

- Make `local-studio` the default branch.
- Enable the `ls-*` workflows and disable upstream's (`release.yml`, `ci.yml`, `deploy-relay.yml`, `mobile-*`, `publish-aur.yml`, `web-preview.yml`, …).
- Add the repo secrets.

**How the app updates:**

- electron-updater reads the fork's releases through the baked `app-update.yml`.
- `t3 update` and remote installs use the H7 repository.
- The Local Studio controller updates on its own train, from the pinned tarball URL in `packages/local-studio-t3-providers/src/controllerRelease.ts`, which is bumped by PR.

**The conflict-surface gate** (`scripts/local-studio/conflict-surface.ts`):

- Diffs `git merge-base upstream/main HEAD..HEAD --name-status`.
- Allowed new paths:
  - `packages/local-studio-*/**`
  - `apps/server/src/localStudio/**`
  - `apps/server/src/provider/localStudio/**`
  - `apps/web/src/localStudio/**`
  - `apps/web/src/routes/local-ai*.tsx`
  - `packages/shared/src/cliReleaseRepository.ts`
  - `apps/desktop/src/app/editionIdentity.ts`
  - `scripts/local-studio/**`
  - `.github/workflows/ls-*`
  - `.local-studio/**`
  - `docs/local-studio/**`
- Every modified upstream file must be in `.local-studio/hooks.txt`, which records a line budget per file (H1–H10 budgets as in the table above; G1/G2 are unbudgeted).
- It prints each hook's 60-day churn.
- It fails on an unknown modified file or a budget overrun.

---

## Milestones

- **M0 (serial): bootstrap and hooks.** Branches, package skeletons, and every hook edit against stub exports. After M0 no parallel unit edits an upstream file, apart from WU10's H9 body.
- **M1: plumbing.** Controller proxy and sidecar, vendored contracts, sync/CI pipeline. Result: the Local AI shell loads live snapshot data.
- **M2: agents.** omp over ACP end to end, then pi through the bridge, both against the gateway.
- **M3: Local AI area complete.** Machines and GPUs, Run (fit, Needs setup, Stop & run, Pod), running models, endpoints, usage, agents.
- **M4: release.** Edition identity, signed nightly published from the fork, in-app update verified, and a sync dry-run against a newer upstream commit.
- **Deferred, outside this PR:**
  - Local Studio supervising `t3 serve` and minting pairing links so machines become T3 environments automatically.
  - Mobile.
  - Windows.

---

## WORK UNITS

Each unit runs in its own worktree off `feat/local-studio-edition`, after WU0 has landed. Owned paths do not overlap. "Stub" means WU0 created the file with the final exported signature and a placeholder body.

**WU0: Bootstrap, skeletons and all hook edits** (serial, blocks everything)

- **Owns:**
  - branch setup and `.local-studio/hooks.txt`
  - `docs/local-studio/README.md`
  - `package.json` and `tsconfig.json` for each package: `packages/local-studio-{contracts,t3-providers,pi-acp,local-ai-model}/`
  - H1–H8 and H10 edits
  - stubs:
    - `apps/server/src/provider/localStudio/index.ts` (`LOCAL_STUDIO_DRIVERS = []`, `type LocalStudioDriversEnv = never`)
    - `apps/server/src/localStudio/index.ts` (`localStudioRouteLayer`, an empty router layer)
    - `apps/server/src/localStudio/LocalStudioGateway.ts` (service tag with `gatewayUrl`, `listReadyModels(): Effect<ReadonlyArray<GatewayModel>>`, `ensureHarnessKey(h: "pi"|"omp"): Effect<{keyFile: string}>`)
    - `apps/web/src/localStudio/providers/definitions.ts` (empty arrays and maps)
    - `apps/web/src/localStudio/nav.tsx` (`LocalAiUtilityButton`, `isLocalAiPath`)
    - `apps/web/src/routes/local-ai.tsx` (layout with `<Outlet/>`) and `local-ai.index.tsx` (placeholder)
    - `apps/web/src/localStudio/state/controllerClient.ts` (signature only: `controllerFetch<T>(envId, path, init?)`, `controllerEvents(envId, types)`)
  - regenerated `pnpm-lock.yaml`
- **Depends on:** nothing.
- **Accept:**
  - `vp i && vp run typecheck && vp run lint && vp run knip:check && vp run build` passes.
  - `git diff --stat upstream/main...HEAD -- $(cat .local-studio/hooks.txt | cut -f1)` stays within budgets.
  - In the built app, "Local AI" shows in the sidebar utility menu and `/local-ai` renders the placeholder with a working Back button.

**WU1: Sync, CI and conflict-surface gate**

- **Owns:**
  - `.github/workflows/ls-upstream-sync.yml`, `ls-ci.yml`
  - `scripts/local-studio/{conflict-surface.ts,check-generated.ts,resolve-generated.sh}`
  - `.local-studio/hooks.txt` (after WU0)
  - `docs/local-studio/sync.md`
- **Depends on:** WU0.
- **Accept:**
  - `node scripts/local-studio/conflict-surface.ts` exits 0 on the branch, and exits non-zero after a scratch edit to `apps/web/src/components/ChatView.tsx`.
  - Running the sync workflow with `workflow_dispatch` on the fork either merges `upstream/main` HEAD, or opens an `upstream-sync` PR with a report.
  - Run locally, `git merge upstream/main` into a scratch branch followed by `resolve-generated.sh` leaves no conflict in G1/G2.

**WU2: Vendored contracts and sync script**

- **Owns:**
  - `packages/local-studio-contracts/**`
  - `scripts/local-studio/sync-contracts.ts`
  - `.local-studio/contracts.lock` (the Local Studio commit)
- **Depends on:** WU0.
- **Accept:**
  - `node scripts/local-studio/sync-contracts.ts --check` passes against `/Users/sero/projects/worktrees/local-ai-system@ca06718f6`.
  - `vp run --filter @local-studio/contracts typecheck` passes.
  - `import type { Snapshot, FleetSnapshot, RecipeRow, LaunchProgress } from "@local-studio/contracts/client"` compiles in web.

**WU3: Server controller bridge (proxy, sidecar, config, gateway service)**

- **Owns:** `apps/server/src/localStudio/**`, namely:
  - `LocalStudioRoutes.ts`
  - `ControllerSidecar.ts`
  - `ControllerLocator.ts`
  - `ControllerInstaller.ts`
  - `LocalStudioConfig.ts`
  - `LocalStudioGateway.ts` (the body)
  - `index.ts`
- **What it does:**
  - `/api/local-studio/{api/*,v1/models,health}` is proxied with env auth. Read scope covers GET; operate scope covers mutations.
  - Allowed prefixes: `/api/(snapshot|fleet|events|health|tailnet|machines|peers|metrics|usage|recipes|launches|pods|models|lab|agents|host)`.
  - Headers are scrubbed as in `DeviceHubProxy.DROPPED_REQUEST_HEADERS`, plus `origin`, `forwarded`, `x-forwarded-*` and `x-real-ip`.
  - SSE is passed through unbuffered.
  - `/api/local-studio/_config` offers GET/PUT of `{mode:"sidecar"|"remote"|"off", url?, hasKey}`; the key is write-only.
  - `/_install` is a POST that installs the controller.
  - The sidecar works as described in D7: health polls every 250 ms, 60 times; backoff from 1 s to 30 s; SIGTERM then SIGKILL after 3 s, only if we spawned it.
- **Depends on:** WU0, WU2 (types only).
- **Accept:** with a built server running and a controller on :8080:
  - `curl -H "Authorization: Bearer <t3 session>" http://127.0.0.1:<t3>/api/local-studio/api/snapshot` returns a `Snapshot`.
  - `curl -N …/api/local-studio/api/events?types=snapshot` streams, with the first `event: snapshot` in under 2 s.
  - A POST without a session returns 401.
  - With no controller running, the server spawns one: `lsof -iTCP:8080` shows the `local-studio` child, and quitting T3 removes it.
  - With a controller that was already running, quitting T3 leaves it alive.

**WU4: pi RPC→ACP bridge package**

- **Owns:** `packages/local-studio-pi-acp/**`:
  - `src/{main.ts,jsonl.ts,piRpc.ts,acpServer.ts,mapEvents.ts,approvalGate.ts}`
  - `scripts/bundle.ts` → `src/bundle.generated.ts`
- **What it does:**
  - Framing is strict LF JSONL with no `readline`.
  - ACP `initialize` advertises `loadSession:true` and `promptCapabilities{image}`.
  - `session/new|load` spawns `pi --mode rpc --provider localstudio --model <id> --thinking <lvl> --session-dir D/sessions --session-id <sessionId> --no-themes --no-approve [-e approvalGate]`.
  - `configOptions` are `model` and `thinking`. `set_config_option` maps to `set_model` / `set_thinking_level`.
  - `session/prompt` maps to `prompt`, with `streamingBehavior` while streaming. The response is sent only on `agent_settled`, with a `stopReason`.
  - `session/cancel` maps to `clear_queue` then `abort`.
  - Events follow the report's §5 table: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`/`tool_call_update` with kind from tool name, and `usage_update` from `message_end`. Only `role==="assistant"` messages are used.
  - The approval extension's `extension_ui_request` confirm becomes `session/request_permission` carrying `toolCallId` and options `allow_once` / `reject_once`.
  - Exit: close stdin, then SIGTERM, then SIGKILL.
- **Depends on:** WU0.
- **Accept:**
  - `node packages/local-studio-pi-acp/dist/pi-acp.mjs` driven by a scripted ACP client (`initialize` → `session/new` → `session/prompt "say hi"`) against a live gateway model returns streamed `agent_message_chunk` and `stopReason:"end_turn"`.
  - Re-running `session/load` with the same id shows the earlier messages.
  - `ps` shows no leftover pi process after the client disconnects.
  - `check-generated.ts` reports the bundle as fresh.

**WU5: pi and omp drivers, settings schemas and web provider definitions**

- **Owns:**
  - `packages/local-studio-t3-providers/**`:
    - `PiSettings` and `OmpSettings` Effect Schemas built with `makeProviderSettingsSchema`: `binaryPath?`, `defaultModel?`, `thinkingLevel`, `extraArgs?`
    - `harnessConfig.ts` (builds `models.json`/`models.yml`)
    - `env.ts` (scrub list and allowlist)
    - `approvalMode.ts`
    - `controllerRelease.ts`
  - `apps/server/src/provider/localStudio/**`:
    - `LocalStudioAgentDriver.ts`: `PiDriver`, `OmpDriver`, `driverKind` `pi` / `omp`
    - `LocalStudioAcpSupport.ts`: spawn spec, bridge materialization, permission option chosen by `kind` as in `GrokAdapter.selectGrokPermissionOptionId`
    - `LocalStudioAgentAdapter.ts`
    - `LocalStudioProvider.ts`: `makeManagedServerProvider`; models from `LocalStudioGateway.listReadyModels`; `refreshModels`
    - `LocalStudioTextGeneration.ts`: gateway chat completions with no length cap
    - `index.ts`
  - `apps/web/src/localStudio/providers/**`: `definitions.ts` bodies, pi and omp icons
- **Depends on:** WU0. It needs WU3's gateway service and WU4's bundle; before those land, test omp against the WU0 stub with an env override `LOCAL_STUDIO_GATEWAY_URL`.
- **Accept:**
  - Settings → Providers → Add instance lists "pi" and "omp", and the form renders.
  - The model picker shows exactly the gateway's ready models.
  - An omp thread streams text, runs a bash tool (shown as a command execution item), and in `approval-required` mode shows an approval request that resolves.
  - A pi thread does the same through the bridge.
  - The controller's `GET /api/metrics/requests?limit=5` shows the requests with `client` `pi`/`omp` and `workspace=<threadId>`.
  - `ps eww <omp pid> | tr ' ' '\n' | grep -c OPENROUTER_API_KEY` prints 0.
  - Captured gateway request bodies carry no `max_tokens` (omp), or `max_completion_tokens` equal to the remaining context (pi).
  - The thread resumes after a T3 server restart.

**WU6: Local AI data layer, shell, and Machines & GPUs**

- **Owns:**
  - `packages/local-studio-local-ai-model/**`: pure ports of `apps/ui/src/model/view.ts` derivations, the `store.ts` reducers (`applySnapshot`, `applyFleet`, `onEvent`, history buffers of 90 and 60 points), and the polling rules
  - `apps/web/src/localStudio/state/**`: `controllerClient.ts` over `environmentHttpAuth` like `pullRequestDiffHttp.ts`; atoms per active environment; SSE with 1–15 s backoff; `via(peerId)`
  - `apps/web/src/localStudio/shell/**`: tabs Machines / Run / Models / Endpoints / Usage / Agents, controller-status banner, `_config` and Install panel
  - `apps/web/src/localStudio/views/machines/**`: fleet list, GPU grid with group state, tailnet discover and connect (`POST /api/machines`), remove
  - `apps/web/src/routes/local-ai.tsx`, `local-ai.index.tsx`, `local-ai.machines.tsx`
- **Depends on:** WU0, WU2. Live checks need WU3.
- **Accept:**
  - `/local-ai/machines` shows every machine from `/api/fleet` with online state and per-GPU memory/util, updating live within about 2 s of a change.
  - Discover lists tailnet candidates; Connect adds a peer.
  - Killing the controller shows the banner; restarting it recovers without a reload.
  - All components come from `components/ui/*` with Tailwind tokens: no `theme.css`, no hand-made SVG charts.

**WU7: Run configs, pods and running models**

- **Owns:**
  - `apps/web/src/localStudio/views/{run,models}/**`
  - `apps/web/src/routes/local-ai.run.tsx`, `local-ai.models.tsx`
- **What it does:**
  - Recipe rows with fit, and GPU selection across machines through `POST /api/recipes/fit`.
  - Row actions:
    - Run
    - "Stop & run" when `fit==="busy"`
    - Pod, when `machines>1` and all machines are chosen, via `POST /api/pods/launch`
    - **Needs setup** rows (`blocked`, weights missing), showing the reason and the plan preview from `GET /api/recipes/:id/plan`
  - Launch progress from SSE `launch`, polling `/api/launches` through `via` for peers; cancel.
  - Running models with a typed-confirm stop (force when a watchdog is present), pod stop, export and PR, verify and poll.
- **Depends on:** WU6 (state API).
- **Accept:**
  - Selecting 2 free GPUs on pop-os and pressing Run on a fitting recipe moves the progress through phases to `ready`, and the model appears under Models and in `/v1/models`.
  - Stopping requires typing the model id.
  - A recipe without weights shows "Needs setup" and cannot be launched.
  - A 2-machine pod launch returns ranks, or shows `NO_FABRIC` as a readable error.

**WU8: Endpoints, usage and agents**

- **Owns:**
  - `apps/web/src/localStudio/views/{endpoints,usage,agents}/**`
  - `apps/web/src/routes/local-ai.endpoints.tsx`, `local-ai.usage.tsx`, `local-ai.agents.tsx`
- **What it does:**
  - **Endpoints:** `Snapshot.endpoints` plus the gateway base URL with a copy button, with the loopback host rewritten to the peer's host.
  - **Usage:** `metrics/summary` by window, `usage/daily` grouped by model and client, `usage/hourly`, `metrics/ttft`, and the requests table. Charts reuse whatever chart primitives upstream's `components/usage/*` uses.
  - **Agents:** `/api/agents` harness install and test, and an "Enable in T3" action that writes `providerInstances.{pi,omp}` through the existing `server.updateSettings` RPC.
- **Depends on:** WU6. The "Enable in T3" action needs WU5's driver kinds, which are string constants only.
- **Accept:**
  - Usage totals for 24h match `curl …/api/local-studio/api/metrics/summary?window=24h`.
  - Endpoint URLs work with `curl <url>/v1/models` from another tailnet machine.
  - "Enable in T3" makes pi and omp appear in the provider list without a restart.

**WU9: Edition identity and release pipeline**

- **Owns:**
  - the H9 body in `scripts/build-desktop-artifact.ts`
  - `apps/desktop/src/app/editionIdentity.ts` (value)
  - `packages/shared/src/cliReleaseRepository.ts` (value)
  - `.github/workflows/ls-release.yml`
  - `docs/local-studio/release.md`
- **Depends on:** WU0.
- **Accept:**
  - `T3CODE_EDITION_APP_ID=ai.localstudio.t3 T3CODE_MAC_PASSKEY_SIGNING=off vp run dist:desktop:dmg` produces `Local-Studio-Code-*.dmg`, and its `app-update.yml` has `owner: 0xSero, repo: t3code`.
  - Once installed next to upstream T3 Code, both launch, and the edition writes only under `~/.local-studio/t3`.
  - A dispatched nightly run publishes a prerelease with the desktop artifacts, `nightly*.yml`, CLI tarballs and `SHA256SUMS`.
  - An older installed nightly offers the update, installs it, and relaunches.

**WU10: Integration and acceptance** (serial, last)

- **Owns:** no source. It fixes only within the other units' owned paths.
- **Depends on:** all units.
- **Accept:**
  - Full gate set green (sync step 4).
  - `conflict-surface.ts` green with 10 hooks at or under budget.
  - A scratch merge of an upstream commit newer than `d15210cd` resolves with no manual edits.
  - End to end on the installed nightly:
    1. launch a model from Local AI
    2. start an omp and a pi thread on it
    3. see their requests under Usage
    4. stop the model
  - The PR is opened `feat/local-studio-edition` → `local-studio` with the hook table in the body.

**Parallelism**

- After WU0, these can run together: WU1, WU2, WU3, WU4, WU5, WU9.
- After WU6's state API lands, WU7 and WU8 run together.
- At most 6 units run at once.

---

## Risks

1. **Upstream drivers API churn.** The risk is changes to `ProviderDriver`, `AcpSessionRuntime.make` options or `makeManagedServerProvider`. Our code breaks at compile time, not in a merge, and the sync job opens a PR. Mitigation: keep all ACP usage in `LocalStudioAcpSupport.ts`, the same surface Grok uses.
2. **Hot-file hooks.** H2 (`server.ts`, 50 commits in 60 days) and H5 (`SidebarChrome.tsx`, about 30) will sometimes conflict. The mitigations are 1-line inserts, rerere, and offering nav and route slots upstream early.
3. **pi RPC drift** (pi 0.87.x, no protocol version). Mitigations:
   - The bridge checks `pi --version` and warns outside a tested range.
   - The event mapper ignores unknown events.
   - The bridge is typed against pi's exported `RpcCommand` / `JsonAgentSessionEvent`.
4. **Controller loopback trust through the proxy.** A bug that forwarded browser headers would demote requests to "untrusted"; one that forwarded a foreign `Origin` would get 403s. The more serious failure is the opposite: an unauthenticated T3 route would expose admin. Mitigations: an explicit prefix allowlist, env-auth required on every path, and the header scrub list.
5. **knip and upstream lint rules** can reject the new packages: unused exports, the oxlint plugin. Mitigation: keep exports minimal. Do not edit `knip.jsonc`; if it has to change, it becomes hook H11 with a budget.
6. **Signed macOS updates** need an Apple Developer ID, and passkey signing assumptions may spread beyond H9 upstream. Unsigned mac builds cannot auto-update.
7. **omp approvals over ACP.** Option ids use underscores, and a non-interactive run fails closed. Pick the option by `kind`, and map `full-access` to `--approval-mode yolo`.
8. **Headless CLI runs.** The single-executable `t3` cannot run `.mjs`, so the pi bridge needs a real `node` there. It resolves one from pi's shebang or PATH, and marks pi "unavailable" with a clear message if none is found.
9. **Vendored contracts drift from the controller.** The pinned commit plus the `--check` gate catch it. A version skew between controller and edition shows as a banner using `Health.api`.

---

## Open questions for the owner (max 5)

1. **Brand and ids:** is "Local Studio Code" / `ai.localstudio.t3` / state dir `~/.local-studio/t3` right? Should releases publish from `0xSero/t3code` or a new repo under `sybil-solutions`?
2. **Controller packaging:** should the controller be fetched on first run from the pinned Local Studio release (the plan), or bundled inside the DMG/AppImage as `extraResources`? Bundling adds hook H11 and ties the two release trains together.
3. **macOS signing:** can we use your Apple Developer ID (`CSC_LINK`, `APPLE_*`) in the fork's secrets? Without it, mac nightlies are unsigned and cannot auto-update.
4. **Machines as T3 environments:** is it enough for v1 that users add remote machines as T3 environments by hand, with the existing `t3 pair --tailscale`? Or must this PR also include a Local Studio controller change (supervise `t3 serve`, mint pairing links)? That would break the "one PR" constraint.
5. **Upstreaming the hooks:** may we open small generic PRs to `pingdotgg/t3code` for the extra driver list, the sidebar nav slot, and edition identity with optional passkey signing? Each one that merges removes a hook permanently.

---

## Owner decisions (2026-09-28) — these override anything above

1. Repo: fork `0xSero/t3code` (recreated from upstream 2026-09-28). Branches: `upstream` (mirror of pingdotgg/t3code main), `local-studio` (default branch, the edition), `feat/local-studio-edition` (this PR, targets `local-studio`). The old deleted fork and `/Users/sero/ai/projects/t3code` are legacy; never touch that working tree.
2. Controller: BUNDLED inside the desktop app (not fetched on first run). Add hook H11: desktop packaging copies the Local Studio controller binary for the target platform into the app's resources (`extraResources`), built from the Local Studio repo at a pinned commit (`/Users/sero/projects/worktrees/local-ai-system`, `LOCAL_STUDIO_TARGETS=<bun target> bash scripts/release.sh` produces `dist/local-studio-<ver>-<os>-<arch>.tar.gz`). The sidecar prefers the bundled binary, then `LOCAL_STUDIO_BIN`, then `~/.local-studio/bin/local-studio`, then PATH. Keep the H9/H11 edits inside `scripts/build-desktop-artifact.ts` behind env/config with upstream defaults.
3. Signing/notarization: secrets exist only in GitHub repo `sybil-solutions/local-studio` (environment `release-signing`: MACOS_CERTIFICATE_P12, MACOS_CERTIFICATE_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID; release.yml there shows how they are used). Secret values cannot be copied. Therefore the signed release job lives in `sybil-solutions/local-studio` as a separate workflow file (e.g. `.github/workflows/edition-release.yml`) that checks out `0xSero/t3code@local-studio`, builds, signs, notarizes and publishes the edition's releases + update feed to `sybil-solutions/local-studio` GitHub Releases under tag prefix `code-v` (distinct from Local Studio's own tags). The edition's updater and `t3 update` point at that repo/prefix. The fork's own CI builds unsigned artifacts for PR checks only. Local signed builds use the keychain identity "Developer ID Application: sherif cherfa (TZ447KHNZL)". Adding that workflow to sybil-solutions/local-studio is a companion PR there (never push to its dev/main directly).
4. Machines: AUTO-PAIR Local Studio machines as T3 environments in v1. This requires a companion PR in the Local Studio repo (branch from `feat/local-ai-system`): the controller can supervise a `t3 serve` process on each machine (bundled or installed t3 CLI from the edition release) and mint T3 pairing links; the edition's Local AI area lists fleet machines and offers "Add as environment", using T3's existing environment/pairing APIs (docs/internals/remote.md, environment-auth.md). Upstream T3 files stay untouched for this beyond the hook list.
5. Hooks may later be offered upstream as generic PRs; not in this PR.

Rules for all work: no automated tests written (no new *.test.ts), no code comments in touched code, never set max_tokens/output caps, hard timeouts on network/daemon commands, never print secrets. Node: repo wants ^24.13.1 (machine has 26.9.0 at /opt/homebrew/bin/node and pnpm 11.10.0); if engine checks block, install Node 24 via mise into the repo only and document it in docs/local-studio/DEV.md. 6. ALL T3 CODE PROVIDERS must work with Local Studio models, not just pi and omp. Every upstream provider driver present at the current upstream commit (Codex, Claude, Cursor, OpenCode, Grok, Antigravity, and any added later) must be usable against Local Studio's gateway models, wherever the provider's CLI allows a custom endpoint. The Local Studio gateway already speaks OpenAI chat, OpenAI Responses and Anthropic Messages (see the Local Studio repo: apps/controller/src/gateway/dialects and apps/controller/src/agents/launch-table.ts, which already configures codex, claude, pi, omp, droid and hermes against it with isolated homes and client keys). Prefer upstream's own per-instance configuration — provider instances, ProviderInstanceEnvironment, custom env, config dirs and model lists — so this adds no or few hooks. For example, the edition auto-creates a "Local Studio" instance for each installed driver, with an isolated home and config pointing at the gateway, a per-client key, the ready models from /v1/models, and no output cap. Providers whose CLI cannot target a custom endpoint are listed in docs/local-studio/PROVIDERS.md with the exact reason and still work normally with their own accounts. pi and omp stay as the added drivers. 7. A "LOCAL AI" PROVIDER is the headline user experience. T3's provider/model picker shows a provider named "Local AI". Under it are exactly the Local Studio models currently ready (GET /v1/models, local_studio.state === "ready"), shown the same way other providers list their models, and it updates as models are launched or stopped. When the user selects Local AI plus a model and sends a message, they get a streamed reply from that model, with tool use working. The Local AI provider is backed by the omp ACP driver from WU5 (pi is the fallback when omp is not installed), branded and iconed as "Local AI", with an isolated home, a gateway key and no output cap. When no controller is running or no model is ready, Local AI still appears, with a clear "No local models running — open Local AI" state that links to the Local AI area. This must be verified in the real UI: headless browser, open the picker, see Local AI with glm-5.3-flash under it, select it, send a message, see the reply.
