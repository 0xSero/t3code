# Local Studio edition: development commands

Run everything from the repository root.

## Toolchain

- pnpm 11.10.0 (the `packageManager` pin).
- Node: the root `engines` field asks for `^24.13.1`. Node 26.9.0 works: pnpm prints `Unsupported engine` as a warning and every gate below passes with it. No `engine-strict` setting is enabled, so no Node 24 install is needed.
- If a future upstream merge turns the engine check into an error, run the same commands under Node 24 without writing any file to the repo: `mise exec node@24.13.1 -- pnpm <command>`.
- `vp` (Vite+) is not on PATH. Use it through the root scripts (`pnpm run <script>`) or as `pnpm exec vp ...`. Where the plan says `vp i` or `vp run <x>`, use `pnpm install` and `pnpm run <x>`.

## Install

```sh
pnpm install
```

`pnpm install --frozen-lockfile` must also pass once the lockfile is committed.

## Gates

```sh
pnpm run typecheck
pnpm run lint
pnpm run fmt:check
pnpm run knip:check
pnpm run build
```

- `pnpm run build` runs `vp run --filter './apps/*' build`. The web build regenerates `apps/web/src/routeTree.gen.ts` through the TanStack Router plugin, so run it after adding a `routes/local-ai*.tsx` file and before `pnpm run typecheck`.
- The web build fails if a bundled package has no license. Every `packages/local-studio-*` package declares `license` and ships a `LICENSE` file.
- Format new files with `pnpm exec vp fmt <paths>`.

## Run the built server headless

```sh
node apps/server/dist/bin.mjs serve --host 127.0.0.1 --port 3790 --base-dir <scratch>/t3home <scratch>/cwd
node apps/server/dist/bin.mjs pair --base-dir <scratch>/t3home --ttl 10m
```

- `--base-dir` keeps all state out of `~/.t3`.
- `serve` prints a one-time pairing URL; `pair` mints another one. Open it in a browser (or a headless Chromium) to get a session cookie.
- `LOCAL_STUDIO_GATEWAY_URL` overrides the gateway base URL used by `LocalStudioGateway` (default `http://127.0.0.1:8080`).
- `GET /api/local-studio/_edition` (authenticated, read scope) reports the edition stage, gateway URL, driver kinds and pi-acp bundle hash.

## Headless UI check used for WU0

1. Start the server and mint a pairing URL as above.
2. With `playwright-core` from `apps/desktop` and the cached `chrome-headless-shell`, open the pairing URL, click through onboarding (`Continue`, `Continue`, `Do not import projects`).
3. The sidebar utility row has a `Local AI` button. Clicking it opens `/local-ai`, which renders the placeholder (`data-testid="local-ai-placeholder"`) and a `Back` button. `Back` returns to `/`.

## Controller bridge (WU3)

Server code lives in `apps/server/src/localStudio/`.

- Routes under `/api/local-studio` all require an environment session: a Bearer or DPoP token, the browser cookie, or a `wsTicket` query parameter (for `EventSource`). GET and HEAD need read scope; every other method needs operate scope.
  - `/api/*` (allowlisted prefixes only), `/v1/models` and `/health` go to the controller. Browser `cookie`, `authorization`, `origin`, `referer`, `forwarded`, `x-forwarded-*` and `x-real-ip` are dropped, so a loopback controller treats the request as admin. `text/event-stream` responses stream through unbuffered.
  - `GET /_config` returns `{mode, url, configuredUrl, envUrl, hasKey, sidecar}`. `PUT /_config` takes `{mode?, url?, key?}`, where `null` clears a field. The key is never returned.
  - `GET /_models` returns the gateway's ready models as `GatewayModel[]`.
  - `GET /_edition` reports the edition stage, the gateway URL and the controller state.
- Settings are stored in `<stateDir>/local-studio.json` with mode 0600. `LOCAL_STUDIO_GATEWAY_URL` overrides the URL, except in `remote` mode, where the configured URL wins.
- The sidecar reuses any controller whose `GET /health` reports `service: "local-studio"`. Otherwise, for a loopback URL, it runs `local-studio serve --host 127.0.0.1 --port <port> --tailnet` and polls `/health` every 250 ms, 60 times. If the controller dies, it is restarted with a backoff from 1 s to 30 s. On shutdown the sidecar sends SIGTERM, then SIGKILL after 3 s, and only to a controller it spawned itself.
- Where the sidecar looks for the binary, in order:
  1. The app bundle: `<resources>/local-studio/local-studio`, where `<resources>` is `Contents/Resources` on macOS and `resources/` next to the executable on Linux. H11 must copy the release tarball's `local-studio` binary (and its `ui/` directory) into that folder.
  2. `LOCAL_STUDIO_BIN`.
  3. `~/.local-studio/bin/local-studio`.
  4. `PATH`.
- `LocalStudioGateway.layer` needs `FileSystem`, `Path`, `HttpClient` and `ServerConfig`. The server runtime already provides all four, since `CodexDriverEnv` requires them.
- `ensureHarnessKey(client)` writes `~/.local-studio/agents/t3/<client>/gateway.key` (0600, atomic rename) and records the key id in `local-studio.json`. A key is reused while `GET /api/keys` still lists its id. If the controller does not return the key list, the key is reused unless `/v1/models` answers 401 or 403. Otherwise the old key is revoked and a new one is issued.
- Try the sidecar without touching the controller on :8080: `LOCAL_STUDIO_GATEWAY_URL=http://127.0.0.1:8791 LOCAL_STUDIO_HOME=<scratch>/ls-home LOCAL_STUDIO_BIN=<path to local-studio> node apps/server/dist/bin.mjs serve ...`.
- To get a Bearer token for curl, exchange a pairing token: `curl -X POST <t3>/oauth/token --data-urlencode grant_type=urn:ietf:params:oauth:grant-type:token-exchange --data-urlencode subject_token=<token> --data-urlencode subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap --data-urlencode requested_token_type=urn:ietf:params:oauth:token-type:access_token`.
