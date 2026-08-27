# AGENTS.md

dsh-acp: an ACP (Agent Client Protocol) JSON-RPC stdio server for DeepSeek Harness (`dsh`), shipped as a **dsh profile bundle** (Cordis plugin) that rides over `dsh-base`. Plain ESM JavaScript — no TypeScript, no build step, no lint/test scripts.

## Commands

- Install deps: `pnpm install`
- Verify: `node smoke-test.mjs` — the only automated test. In-process, mock agent services; does NOT touch the model stack or `$DSH_HOME`. Monolithic: it runs as a whole, prints `SMOKE TEST PASSED`/`FAILED (n)` and exits n.
- Real smoke: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' | dsh --profile acp` (needs `dsh` ≥ 0.1.1-rc.2 installed locally).
- Composition check: `dsh --profile acp --dump-config | grep -A4 '"acp"'` after `dsh plugin --profile acp add ./dsh-acp`.

## Hard rules

- **Never write to stdout** (`console.log`, `process.stdout.write`) in `lib/index.js` — stdout carries ACP frames only. Diagnostics go through `ctx.logger` (stderr).
- Do not move `@deepseek-ai/cordis`, `dsh-agent-default-model`, `dsh-user-approval` from `peerDependencies` to `dependencies`: the host dsh install provides them.
- `@agentclientprotocol/sdk` is pinned to exact `0.25.1`; some used features are UNSTABLE there (e.g. `unstable_createElicitation` for `elicitation/create`).

## Architecture (non-obvious)

- Whole server is one file: `lib/index.js` (~1700 lines) exporting Cordis plugin `name='acp'`, `inject`, `apply(ctx, config)`. It creates one Agent per `session/new` via `ctx.agents` and translates dsh `session/event` firehose into ACP `session/update` notifications.
- `cordis.patch.yml` is the deployment composition, not config fluff: it disables 23 model-facing host rows (tools, prompt sections, delegation) and mounts `agent-presets` + `acp`. Agent tools/persona come from the preset mounted in the factory's `setup(agentCtx)` via `agentPresets.mount(agentCtx, presetId)` — to add/change a tool, edit this patch or the preset, not an in-plugin tool list.
- Agent preset is a process-level deploy value (`DSH_ACP_PRESET` env → `config.preset`), never a session selector. `code`/`cordis` presets need extra host-plane plugins installed globally (see docs/technical.md).
- Config env keys read by the patch: `DSH_ACP_PROVIDER`, `DSH_ACP_MODEL`, `DSH_ACP_PRESET`.

## Client quirks (verified the hard way)

- Zed ignores `models`/`modes` whenever `configOptions` is present — every user-visible selector must go into `configOptions`.
- Use stable `sessionUpdate: 'plan'` (flat `entries`), not UNSTABLE `plan_update` — Zed silently drops the latter.
- Defer `available_commands_update` with `setTimeout(0)` so it lands after the `session/new`/`load` response — Zed ignores notifications for unknown sessionIds.
- Smoke test must skip notification frames when awaiting a response (read frames until `id` matches): `usage_update`/`available_commands_update` can precede it.
- Client-forwarded `mcpServers` are accepted and ignored (logged via `logger.debug`), not rejected.

## Docs

Behavior/mapping ground truth lives in `docs/technical.md` (event→ACP mapping tables, elicitation form schema, usage ring, plan fold/replay). Docs are maintained in EN (README) + ZH (`docs/README.zh.md`, `docs/technical.md`) — keep both in sync when changing user-visible behavior, and update the smoke test alongside protocol changes.
