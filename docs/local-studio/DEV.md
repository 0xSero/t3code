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
