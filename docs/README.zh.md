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
- **Agent preset** —— 4 个模式作为部署字段注入（`DSH_ACP_PRESET`）
- **bash 终端** —— 命令输出以 terminal 内容呈现，含退出码
- **上下文占用圆环** —— `usage_update`（used / size）驱动 IDE 的上下文指示器
- **todo 列表** —— dsh 的 `todo_write` 快照以 `plan` 更新呈现在 IDE 的任务清单中，新回合开始时清空
- **斜杠指令** —— 通过 `available_commands_update` 通告 dsh 的 `/` 指令
- **向用户提问** —— dsh 的 `ask_user_question` 工具通过 ACP 表单 elicitation 应答（选项 / 多选 / 自由文本）；客户端不具备 elicitation 能力时给出自解释回退

## 安装

要求：Node.js ≥ 20，已安装 `dsh`（基于 `dsh@0.1.0-rc.6` 开发），已安装 `pnpm`。

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
- Agent preset 用 `DSH_ACP_PRESET` 注入；空则回退 `standard`。取值：`standard` / `code`（PTC）/ `minimal` / `cordis`。
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

用 `env` 固定模型或 preset，4 个可选值：为空默认 `standard`（标准）/ `code`（PTC）/ `minimal`（极简）/ `cordis`（创造）。

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

Zed 也支持为同一个 acp 配置多个入口，不同 preset 可作为不同名称共存，在 “+” 中展示为不同入口。

## 感谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 及其官方 [`@deepseek-ai/dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp) 示例
- [`pi-acp`](https://github.com/svkozak/pi-acp) —— 更丰富编辑器体验的参考
- [Agent Client Protocol](https://agentclientprotocol.com) 与 [Zed](https://zed.dev)
