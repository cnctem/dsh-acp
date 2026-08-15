# dsh-acp

> [简体中文](docs/README.zh.md) · [技术文档 / Technical notes](docs/technical.md)

An **Agent Client Protocol (ACP)** server for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) that lets [Zed](https://zed.dev) and other IDEs drive dsh agents over **JSON-RPC 2.0 stdio**.

Built on the official [`@deepseek-ai/dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp) skeleton as a dsh **profile bundle** over `dsh-base`, and extended with the editor experience of [`pi-acp`](https://github.com/svkozak/pi-acp).

## Introduction

`dsh-acp` mounts an ACP server on dsh's stdin/stdout. Zed launches `dsh --profile acp` and speaks ACP JSON-RPC over stdio; the plugin translates `session/*` requests into dsh agent lifecycles. No dsh modification required.

## Features

- **Token & thinking streaming** — `agent_message_chunk` / `agent_thought_chunk`
- **Tool cards** — `tool_call` / `tool_call_update` with kind, file location and line
- **Structured diffs** — edit/write hunks plus before/after snapshots
- **Session history** — `session/list` · `session/load` · `session/delete`
- **Session selectors** — write permission (3) · model · thinking strength
- **Agent presets** — 4 modes injected as a deployment field (`DSH_ACP_PRESET`)
- **Bash terminal** — command output rendered as terminal content with exit code
- **Context-usage ring** — `usage_update` (used / size) feeds the IDE's context indicator
- **Slash commands** — dsh's `/` commands advertised via `available_commands_update`

## Installation

Prerequisites: Node.js ≥ 20, `dsh` (developed against `dsh@0.1.0-rc.6`), `pnpm`.

```bash
dsh plugin --profile acp add github:cnctem/dsh-acp
```

From source:

```bash
git clone https://github.com/cnctem/dsh-acp.git
dsh plugin --profile acp add ./dsh-acp
```

## Configuration

- Model/provider defaults to dsh's default model; override via `DSH_ACP_PROVIDER` / `DSH_ACP_MODEL` (or edit the `acp` row in `$DSH_HOME/profiles/acp/cordis.patch.yml`).
- Agent preset via `DSH_ACP_PRESET`; empty → `standard`. Values: `standard` / `code` (PTC) / `minimal` / `cordis`.
- API key reuses dsh credentials (`$DSH_HOME/.credentials.yaml` or `DEEPSEEK_API_KEY`).

## Integration

Add to Zed's `settings.json`:

```json
{
  "agent_servers": {
    "dsh": {
      "type": "custom",
      "command": "dsh",
      "args": ["--profile", "acp"],
      "env": {}
    }
  }
}
```

Restart Zed and pick `dsh`. Fix a model or preset via `env`:

```json
{
  "agent_servers": {
    "dsh-code": {
      "type": "custom",
      "command": "dsh",
      "args": ["--profile", "acp"],
      "env": { "DSH_ACP_PRESET": "code" }
    }
  }
}
```

Zed also supports multiple entries for the same acp, so different presets can coexist as separate entries in the "+" menu.

## Acknowledgements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and its [`@deepseek-ai/dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp) example
- [`pi-acp`](https://github.com/svkozak/pi-acp) — the reference for the richer editor experience
- [Agent Client Protocol](https://agentclientprotocol.com) and [Zed](https://zed.dev)
