# dsh-acp

> [English](../README.md) · [技术文档](technical.md)

一个为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）编写的 **Agent Client Protocol（ACP）** 服务，通过 **JSON-RPC 2.0 over stdio** 让 [Zed](https://zed.dev) 等 IDE 直接接入 dsh 智能体。

以官方 [`@deepseek-ai/dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp) 为骨架，作为 dsh 的一个 **profile bundle** 叠加在 `dsh-base` 上，并补齐对标 [`pi-acp`](https://github.com/svkozak/pi-acp) 的编辑器体验。

## 简介

`dsh-acp` 在 dsh 的 stdin/stdout 上挂载一个 ACP 服务端。Zed 拉起 `dsh --profile acp`，通过 ACP JSON-RPC over stdio 通信；插件把 `session/*` 请求翻译成 dsh 的 Agent 生命周期。无需改动 dsh 本体。

## 功能

- **token / 思考流式** —— `agent_message_chunk` / `agent_thought_chunk`
- **工具卡片** —— `tool_call` / `tool_call_update`，含 kind、文件位置与行号
- **结构化 diff** —— edit/write 的 hunk diff + 前后快照
- **会话历史** —— `session/list` · `session/load` · `session/delete`
- **会话选择器** —— 写权限（3 项）· 模型 · 思考强度
- **Agent preset** —— 部署字段注入的进程级预设选择（`DSH_ACP_PRESET`）：内置 `standard` / `minimal` （其他模式需在 profile 中全局挂载，见配置节），也支持 `$DSH_HOME/.agent-presets/` 下自建的预设
- **bash 终端** —— 命令输出以 terminal 内容呈现，含退出码
- **上下文占用圆环** —— `usage_update`（used / size）驱动 IDE 的上下文指示器
- **todo 列表** —— dsh 的 `todo_write` 快照以 `plan` 更新呈现在 IDE 的任务清单中，新回合开始时清空
- **斜杠指令** —— 通过 `available_commands_update` 通告 dsh 的 `/` 指令
- **向用户提问** —— dsh 的 `ask_user_question` 工具通过 ACP 表单 elicitation 应答（选项 / 多选 / 自由文本）；客户端不具备 elicitation 能力时给出自解释回退

## 安装

要求：Node.js ≥ 20，已安装 `dsh`（基于 `dsh@0.1.1-rc.2` 开发），已安装 `pnpm`。

```bash
dsh plugin --profile acp add github:cnctem/dsh-acp
```

从源码安装：

```bash
git clone https://github.com/cnctem/dsh-acp.git
dsh plugin --profile acp add ./dsh-acp
```

## 配置

- 模型/供应商默认沿用 dsh 的默认模型；用 `DSH_ACP_PROVIDER` / `DSH_ACP_MODEL` 覆盖（或编辑 `$DSH_HOME/profiles/acp/cordis.patch.yml` 的 `acp` 行）。
- Agent preset 用可选的 `DSH_ACP_PRESET` 注入，值**直接映射到本次装载的预设**（它就是预设 id 本身，不存在"必须取 roster 名单"的约束）：不设或为空 → 默认 `standard`；指定的预设不存在 → 会话创建时报错。开箱可用内置 `standard` / `minimal`，或 `$DSH_HOME/.agent-presets/<id>/` 下自建的预设（用户根默认也是预设根）。
- `code`（PTC）与 `cordis`（创造模式）它们不在 `dsh-base` 里。分别需要全局安装 `code-runtime` 和 `cordis-host-runner` 插件，之后即可像其他预设一样用 `DSH_ACP_PRESET` 选 `code`/`cordis`。
- API Key 沿用 dsh 凭据（`$DSH_HOME/.credentials.yaml` 或 `DEEPSEEK_API_KEY`）。

## 接入 Zed

在 Zed 的 `settings.json` 中加入：

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

重启 Zed，在 Agent 面板选择 `dsh`。

用 `env` 固定模型或 preset：`DSH_ACP_PRESET` 的值直接指定本次装载的预设——为空默认 `standard`（标准），指定的预设不存在则报错；开箱可用 `minimal`（极简），也支持全局安装的其他预设。

```json
{
  "agent_servers": {
    "dsh-minimal": {
      "type": "custom",
      "command": "dsh",
      "args": ["--profile", "acp"],
      "env": { "DSH_ACP_PRESET": "minimal" }
    }
  }
}
```

Zed 也支持为同一个 acp 配置多个入口，不同 preset 可作为不同名称共存，在 “+” 中展示为不同入口。

## 感谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 及其官方 [`@deepseek-ai/dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp) 示例
- [`pi-acp`](https://github.com/svkozak/pi-acp) —— 更丰富编辑器体验的参考
- [Agent Client Protocol](https://agentclientprotocol.com) 与 [Zed](https://zed.dev)
