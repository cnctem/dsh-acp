# dsh-acp

一个为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）编写的 **Agent Client Protocol（ACP）** 服务，通过 **JSON-RPC 2.0 over stdio** 让 [Zed](https://zed.dev) 等 IDE 直接接入 dsh 智能体。

它是对官方 `@deepseek-ai/dsh-acp`（`packages/acp/acp`，即仓库中的 *acp example*）的独立移植：作为 dsh 的一个 **profile bundle**，直接叠加在 `dsh-base` 上运行，无需改动 dsh 本体。

## 工作原理

- dsh 启动 `acp` profile 后，`dsh-acp` 插件在 **stdin/stdout** 上打开一个 ACP `AgentSideConnection`，通过 `ctx.agents` 创建/驱动持久的 Agent 会话。
- `session/new` → 为每个会话新建一个 dsh Agent（`cwd` 由客户端传入）。
- `session/prompt` → 把文本块拼成一个用户消息，驱动 Agent 直到空闲（`whenIdle`），把**已提交的助手文本**作为 `agent_message_chunk` 流式返回。
- `session/cancel` → 取消该会话的 Agent。
- `session/request_permission` → 把 dsh 的 `approval/request`（沙箱越权等）以一次性 allow/reject 选项交给客户端裁决。
- 复用 `dsh-base` 的完整能力：DeepSeek 模型路由、沙箱 bash/文件系统、工具（fs/fs-search/bash/subagent/workflow/todo/…）、会话持久化（JSONL）、压缩、子代理等。

stdout 只承载 ACP 帧，诊断信息走 `ctx.logger` → stderr。

## 能力边界（与官方一致）

- 仅**新会话**（不支持 load / list / resume / delete / fork）。
- 仅**基线 prompt**（文本 + `resource_link`；图片/音频/embedded resource 会拒绝）。
- 仅**已提交文本**：不流式输出 token 增量、reasoning、工具调用、plan、标题等（这些属于 UI/演示层）。
- 单个 `cwd`，不支持 `mcpServers` 和 `additionalDirectories`。

## 安装

要求：Node.js ≥ 20，已安装 `dsh`（本仓库基于 `dsh@0.1.0-rc.6` 开发），已安装 `pnpm`。

把本目录作为 bundle 装进一个名为 `acp` 的 profile（`dsh plugin` 会初始化 profile、用 pnpm 安装本包，并把 `dsh-acp` 追加到 `dsh.profile.bundles`）：

```bash
dsh plugin --profile acp add /Users/a11111/code/dsh-acp
```

> 若 pnpm 提示需要允许 build，按提示在 `$DSH_HOME/profiles/acp/pnpm-workspace.yaml` 加入对应 allowBuilds 后重跑。

## 配置

- 模型/供应商：默认沿用 dsh 的默认模型（`$DSH_HOME/settings.yaml` 中的 `agent-default-model`，或 `dsh-base` 内置默认 `deepseek-official/deepseek-v4-flash`）。
- 覆盖方式（二选一）：
  - 环境变量：`DSH_ACP_PROVIDER`、`DSH_ACP_MODEL`。
  - 直接编辑 `$DSH_HOME/profiles/acp/cordis.patch.yml`，在 `acp` 行的 `config` 里写死 `provider` / `model`。

API Key 沿用 dsh 的凭据体系（`$DSH_HOME/.credentials.yaml` 或 `DEEPSEEK_API_KEY` 环境变量），无需为 ACP 单独配置。

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

然后重启 Zed，在 Agent 面板选择 `dsh` 即可。若需要固定模型，可用 `env` 传入：

```json
{
  "agent_servers": {
    "dsh": {
      "type": "custom",
      "command": "dsh",
      "args": ["--profile", "acp"],
      "env": {
        "DSH_ACP_MODEL": "deepseek-v4-pro",
        "DSH_ACP_PROVIDER": "deepseek-official"
      }
    }
  }
}
```

## 验证

```bash
# 查看组合结果，确认 acp 插件已挂载
dsh --profile acp --dump-config | grep -A4 '"acp"'

# 用 stdio 手工发一帧 initialize（Ctrl-D 结束输入）
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' | dsh --profile acp
```

## 目录结构

```
dsh-acp/
  package.json        # dsh.bundle.patch 声明 + 依赖
  cordis.patch.yml    # bundle patch：persona、关闭 HMR、挂载 acp 插件
  lib/index.js        # ACP 服务端插件（apply/inject）
  README.md
```

## 参考

- [Agent Client Protocol](https://agentclientprotocol.com)
- 官方实现：[`@deepseek-ai/dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp) 与 [examples/acp-agent](https://github.com/deepseek-ai/deepseek-harness/tree/master/examples/acp-agent)
- [`pi-acp`](https://github.com/svkozak/pi-acp)（另一个 ACP 适配器，作为更丰富的编辑器集成的参考）
