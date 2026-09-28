# @local-studio/pi-acp

Bridges `pi --mode rpc` (strict LF JSONL) to the Agent Client Protocol over stdio, so the T3 server can run pi through `AcpSessionRuntime`.

## Build

```sh
pnpm --filter @local-studio/pi-acp run bundle
pnpm --filter @local-studio/pi-acp run bundle:check
```

`bundle` writes `dist/pi-acp.mjs` and `src/bundle.generated.ts`, which exports `PI_ACP_BUNDLE_SOURCE` and `PI_ACP_BUNDLE_SHA256` (import `@local-studio/pi-acp/bundle`). `bundle:check` exits 1 when the committed module is stale.

## Run

```sh
node pi-acp-<sha8>.mjs --agent-dir <dir> [--pi <pi or cli.js>] [--provider localstudio] [--model <id>] [--thinking <level>] [--approval] [--pass-env <NAME>]
```

- `--agent-dir` is the isolated pi config dir. It is passed to pi as `PI_CODING_AGENT_DIR`, and sessions live in `<dir>/sessions`. It must hold the `models.json` that points pi at the gateway.
- `--pi` defaults to `pi` on PATH. A `.js` file or a script with a `node` shebang runs under the same Node as the bridge.
- pi gets an allowlisted environment (PATH, HOME, locale, temp, proxy and CA variables, `ELECTRON_RUN_AS_NODE`) plus any `--pass-env` names. Nothing else from the bridge's environment reaches pi.
- `--approval` loads the bundle itself into pi as an extension (its default export). Mutating tools (everything except `read`, `grep`, `find`, `ls`) then raise `session/request_permission` with `allow_once` / `reject_once`.

## Protocol mapping

| ACP                                              | pi                                                                                                                                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`                                     | advertises `loadSession`, `promptCapabilities.image`, `embeddedContext`, `sessionCapabilities.resume` and `close`                                                                                                       |
| `session/new`, `session/load`, `session/resume`  | spawns `pi --mode rpc --provider P [--model P/M] [--thinking L] --session-dir D/sessions --session-id <id> --no-themes --no-approve --offline [--extension <bundle>]`; `load` replays `get_messages` as session updates |
| `session/set_config_option` `model` / `thinking` | `set_model` / `set_thinking_level`                                                                                                                                                                                      |
| `session/prompt`                                 | `prompt` (with `streamingBehavior: "steer"` while a run is active); answered on `agent_settled`                                                                                                                         |
| `session/cancel`                                 | `clear_queue`, then `abort`; the prompt resolves with `stopReason: "cancelled"`                                                                                                                                         |
| `session/close`, client disconnect, SIGTERM      | close pi's stdin, then SIGTERM, then SIGKILL                                                                                                                                                                            |

Events: `text_delta` → `agent_message_chunk`, `thinking_delta` → `agent_thought_chunk`, `toolcall_*` and `tool_execution_*` → `tool_call` / `tool_call_update` (kind from the tool name, diffs for `edit` and `write`), assistant `message_end` usage → `usage_update`, `session_info_changed` → `session_info_update`. Only assistant messages are mapped. A model error at `agent_settled` becomes a JSON-RPC error on the prompt.
