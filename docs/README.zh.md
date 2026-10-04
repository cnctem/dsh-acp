# dsh-acp

> [English](../README.md) · [技术文档](technical.md)

一个为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）编写的 **Agent Client Protocol（ACP）** 服务，通过 **JSON-RPC 2.0 over stdio** 让 [Zed](https://zed.dev) 等编辑器直接驱动 dsh Agent。

新版 dsh 随附的 `acp` profile 明确定位为 automation-only。本 bundle 是该 bridge 的 drop-in replacement：完整保留标准自动化接口（session、MCP、模型选择、权限），并补上 Zed 需要的编辑器体验。

## 简介

`dsh-acp` 在 dsh stdin/stdout 上挂载一个 ACP 服务。Zed 仍可拉起 `dsh --profile acp`，无需修改配置：本 bundle 会禁用官方 `acp` bridge 与 startup 行，再用唯一 ID 挂载本实现和同一套 stdin 生命周期 provider。

## 功能

- **标准 ACP 生命周期** —— `initialize`、`session/new`、`session/list`、`session/resume`、`session/close`、`session/prompt`、`session/cancel`
- **编辑器历史扩展** —— `session/load` 回放持久历史；`session/delete` 关闭在线会话，并在持久化后端暴露删除路径时清理产物
- **token / 思考流式** —— 从 `agent/assistant-stream` 投影 `agent_message_chunk` / `agent_thought_chunk`
- **工具卡片** —— `tool_call` / `tool_call_update`，含 kind、文件位置与行号
- **结构化 diff** —— 原生 tool hunk + 文件前后快照
- **bash 终端** —— 命令输出以 terminal 内容呈现，含退出码
- **上下文占用圆环** —— `usage_update`（used / size）
- **todo 列表** —— dsh `todo_write` 快照映射为稳定的 ACP `plan` 更新
- **图片** —— ACP image prompt 经持久化附件接口准入；仅在当前路由声明支持图片时通告能力
- **斜杠指令** —— 通过 `available_commands_update` 通告 dsh 指令；已识别指令留在命令平面执行，并接收类型化图片附件
- **向用户提问** —— dsh 的 scoped `user-questions/request` waterfall 通过稳定 ACP form `elicitation/create` 应答
- **Agent preset** —— 内置 `standard`、`ptc`、`minimal`、`cordis`（创造模式），由 `DSH_ACP_PRESET` 做进程级选择
- **MCP** —— 客户端传入的 stdio 与 Streamable HTTP MCP server 会在 Agent 发布前校验并挂载
- **按轮固定模型** —— 模型/推理切换只影响后续 prompt；进行中的 turn 保持准入时的路由

## 安装

要求：Node.js `^22.19.0 || >=24.0.0`、`dsh@0.2.0-rc.2`、`pnpm`。

```bash
dsh plugin --profile acp add @cnctem/dsh-acp
```

从源码安装：

```bash
git clone https://github.com/cnctem/dsh-acp.git
cd dsh-acp
pnpm install
pnpm run build
dsh plugin --profile acp add .
```

旧安装使用同一命令升级；升级后的 `acp` profile 会运行本自定义 bridge，而不是 automation-only bridge。

### 作为 npm 包使用

`@cnctem/dsh-acp` 也可由 Node/Cordis 宿主直接 import。它是插件而非独立可执行程序；宿主必须先组合其 dependency / peer 所需的 dsh 服务。

```js
import * as acp from '@cnctem/dsh-acp'

ctx.plugin(acp, {
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
  preset: 'standard',
})
```

## 配置

- `DSH_ACP_PROVIDER` / `DSH_ACP_MODEL` 覆盖默认 provider/model；未设置时沿用 dsh `agent-default-model`。
- `DSH_ACP_PRESET` 选择进程级 Agent 组合；未设置或为空时使用 registry 默认值 `standard`。
- 内置 preset：
  - `standard`：编码工具、plan mode、todo、web、subagent。
  - `ptc`：standard 工具加 presentation / code runtime 行为。
  - `minimal`：持久 shell 与极简 persona。
  - `cordis`：创造模式，含 plugin manager、Cordis 检查工具和随包提供的创作 skill。
- 旧版 `$DSH_HOME/.agent-presets/<id>` 目录扫描已不再支持。新版 preset 是本 bundle 中的 `@deepseek-ai/dsh-agent-preset` 声明，后续 profile patch 可以覆盖。
- API Key 沿用 dsh 凭据（`$DSH_HOME/.credentials.yaml`、账户登录或 `DEEPSEEK_API_KEY`）。

## 接入 Zed

如果尚无该条目，在 Zed 的 `settings.json` 中加入：

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

若需多个模式，可为同一命令创建多个 Zed 条目，并分别设置不同的 `DSH_ACP_PRESET`。每个 dsh 进程只选择一个 preset。

## 开发

源码位于 `src/`；TypeScript 生成并提交 ESM、声明文件和 source map 到 `lib/`。

```bash
pnpm run typecheck
pnpm test              # 进程内 hermetic 协议 smoke
pnpm run test:profile  # 临时 DSH_HOME 中的真实 dsh profile 验收
pnpm run verify        # typecheck + smoke + lib 生成物同步检查
```

`pnpm run test:profile` 需要可用的 `dsh` 可执行文件；可用 `DSH_BIN` 指定其他二进制。

## 感谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 及其官方 [`@deepseek-ai/dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp) 实现
- [`pi-acp`](https://github.com/svkozak/pi-acp) —— 更丰富编辑器体验的参考
- [Agent Client Protocol](https://agentclientprotocol.com)、[Zed](https://zed.dev) 与 ACP 社区
