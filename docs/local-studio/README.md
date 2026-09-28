# Local Studio edition of T3 Code

This branch line (`local-studio`, fed by `feat/local-studio-edition`) is T3 Code plus a Local AI provider and a Local AI area backed by the Local Studio controller.

- Plan and owner decisions: [PLAN.md](PLAN.md). The "Owner decisions" section overrides the rest.
- Commands: [DEV.md](DEV.md).
- Upstream sync, CI, the conflict-surface gate and the contracts sync: [sync.md](sync.md).

## Layout

| Path                                    | Contents                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/local-studio-contracts`       | Vendored Local Studio `packages/contracts/src` (pinned in `.local-studio/contracts.lock`) |
| `packages/local-studio-t3-providers`    | Driver kinds (`localAi`, `pi`, `omp`), labels, gateway client names and `GatewayModel`    |
| `packages/local-studio-pi-acp`          | pi RPC to ACP bridge; `./bundle` exports the built bridge as a string                     |
| `packages/local-studio-local-ai-model`  | Pure Local AI state and reducers                                                          |
| `apps/server/src/provider/localStudio/` | Downstream provider drivers (`LOCAL_STUDIO_DRIVERS`)                                      |
| `apps/server/src/localStudio/`          | Controller proxy, sidecar, config and `LocalStudioGateway`                                |
| `apps/web/src/localStudio/`             | Local AI area, nav entry, provider definitions and icons                                  |
| `apps/web/src/routes/local-ai*.tsx`     | Local AI routes                                                                           |
| `.local-studio/hooks.txt`               | Every upstream file this edition edits, with its line budget                              |

## Hooks

Upstream files are touched only as listed in `.local-studio/hooks.txt` (tab separated: path, added-line budget, hook id, purpose). A budget of `-` marks a generated file that is regenerated, never hand edited. Everything else is a new file in the paths above.

## Local AI provider

The headline experience is a provider named "Local AI" in the model picker, listing exactly the Local Studio models whose `/v1/models` entry has `local_studio.state === "ready"`. Its driver kind is `localAi` (`LOCAL_AI_DRIVER_KIND` in `@local-studio/t3-providers`). It is backed by the omp ACP driver, with pi as fallback. It appears in the server through `LOCAL_STUDIO_DRIVERS` (hook H1) and in the web through `LOCAL_STUDIO_PROVIDER_CLIENT_DEFINITIONS` and `LOCAL_STUDIO_PROVIDER_ICONS` (hooks H3 and H4).
