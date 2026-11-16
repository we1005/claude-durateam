# Claude-Durateam：交给 Codex 的完整工程实施方案

**架构结论：V1 使用 MCP + Claude Agent SDK，不需要 ACP。**

你要实现的不是一个新的 Coding Agent，而是一个**把官方 Claude Code 变成可由 Codex 调度的多 Worker 服务**。每个 Worker 可以通过 Z.ai 的 Anthropic 兼容接口使用 GLM-5.3 或 GLM-5.3-Flash，并保留 Claude Code 的代码工具、会话和扩展生态。

**Codex · GPT-6.1（主 Agent）**

规划、分配任务、审查、集成

**Claude-Durateam · MCP Server**

任务队列、并发管理、事件、权限、持久化

**Claude Agent SDK**

Worker A · GLM-5.3

**Claude Agent SDK**

Worker B · GLM-5.3-Flash

**独立 Git Worktree + 自动质量门禁**

检查变更范围、Typecheck、Lint、Tests、集成验收

## 1\. 为什么是 MCP，而不是 ACP？

| 协议 / 接口                     | 负责什么                                       | 本项目是否使用                  |
| ------------------------------- | ---------------------------------------------- | ------------------------------- |
| **MCP**                         | Codex 调用外部工具，启动和控制 Worker          | **必须，作为对外接口**          |
| **Claude Agent SDK**            | 在服务内部创建真正的 Claude Code Agent 会话    | **必须，作为执行引擎**          |
| **Anthropic Messages 兼容协议** | Claude Code 向 Z.ai 请求 GLM 模型推理          | **必须，由 SDK 运行时处理**     |
| **ACP**                         | 让 IDE / 编辑器以标准协议直接连接 Coding Agent | **V1 不需要**                   |
| **SQLite**                      | 保存任务、运行状态和恢复信息                   | V1 基础状态可先内存化，随后引入 |
| **Git**                         | Worktree、分支、提交、合并与回滚               | 必须                            |

根据 [ACP 官方介绍](https://agentclientprotocol.com/get-started/introduction)，ACP 主要标准化编辑器与 Coding Agent 之间的会话交互；根据 [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/)，MCP 则让 Codex 等宿主调用外部工具。

你的直接需求是 `Codex → 启动 Claude Worker → 等待结果`。Codex 已有 MCP Client，因此再加 ACP 只会引入另一层协议转换，没有必要。

以后如果你想让 Zed、JetBrains 或其他 ACP 客户端直接使用 Claude-Durateam，可以在同一个内部 Worker 管理器之上另外提供 ACP Adapter，**不需要重写执行引擎**。

## 2\. 官方 Claude Agent SDK 该怎样使用？

安装的是：

```bash
npm install @anthropic-ai/claude-agent-sdk
```

而不是单纯的 `@anthropic-ai/sdk`。

官方明确说明，Agent SDK 包含 Claude Code 使用的 Agent Loop、内置工具、权限系统和会话管理，而且运行在你自己控制的进程中。

TypeScript 核心入口是：

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const agent = query({
  prompt: "检查当前模块的类型错误，不要修改文件",
  options: {
    cwd: "/absolute/path/to/worktree",
    model: "glm-5.3",
    permissionMode: "dontAsk",
    allowedTools: ["Read", "Glob", "Grep"],
    maxTurns: 20,
  },
});

for await (const message of agent) {
  if (message.type === "result") {
    console.log(message.subtype, message.is_error);
  }
}
```

这是 SDK 的使用方式示例。要实际调用 GLM，启动这个 Worker 的进程还需要正确设置 Z.ai 的环境变量和认证；SDK 是否能在你当前版本上正常使用 GLM 的所有工具，必须通过真实 API 验证。

官方参考：[Claude Agent SDK TypeScript API](https://code.claude.com/docs/en/agent-sdk/typescript)。

这里有一个关键设计选择：**V1 先采用 `query()` \+ 会话 `resume` 实现可继续的任务；中途 Steering 作为第二阶段实现。**

这样 Codex 可以先稳定启动、等待、取消和继续 Claude Worker，而不用在第一版就处理复杂的运行中输入队列。

## 3\. 我核对到的当前技术版本与重要变化

截至 **2026 年 11 月 16 日**，官方 GitHub Release 显示：

| 组件                           | 版本                       | 选择                                           |
| ------------------------------ | -------------------------- | ---------------------------------------------- |
| Claude Agent SDK（TypeScript） | `0.3.325`                  | 作为当前实现基线                               |
| MCP TypeScript SDK             | `2.4.0`                    | 使用新版独立 `@modelcontextprotocol/server` 包 |
| Node.js                        | 22 或 24                   | 首先使用 Node.js 22                            |
| Z.ai GLM                       | `glm-5.3`、`glm-5.3-flash` | 作为可配置的 Worker 模型                       |

Claude Agent SDK `0.3.325` 于 11 月 13 日发布，其中还调整了沙箱内 Bash 的自动授权行为。MCP SDK 2.4.0 则提供新版服务端 API，并兼容旧版 MCP 客户端协议。

有两项重要变化，Codex 在写代码时必须注意：

**第一，不要使用旧教程中的 `unstable_v2_createSession()`。** 这套实验性 TypeScript V2 Session API 已在 SDK 0.3.142 删除。现在应使用 `query()`、流式输入、`resume` 和官方会话管理接口。

**第二，当前 SDK 已支持更接近 Pi `steer` 的中途消息。** `SDKUserMessage.priority` 支持 `next`、`later` 和 `now`；其中 `next` 可以在当前工具调用结束后让模型在同一回合读取新指令。所以 `claude-durateam` 不必把所有 Steering 都实现为“强制杀进程再启动”。但它仍然需要消息队列及确认逻辑。

另外，SDK 的配置加载行为也需要明确控制：当前 `query()` 默认读取用户、项目和本地配置；设置 `settingSources: []` 才会关闭这些文件系统配置来源。不要直接复用早期 SDK 教程对此行为的说明。

## 4\. Z.ai GLM-5.3 的实际接入方式

Z.ai 官方文档给出的 Claude Code 接口是：

```text
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=<你的 Z.ai Key>
```

这是 **Anthropic Messages 兼容接口**。它由 Claude Agent SDK 所启动的 Claude Code 运行时使用，不是由 `claude-durateam` 自己实现 HTTP 请求。

官方来源：[Z.ai：Claude Code 接入指南](https://docs.z.ai/scenario-example/develop-tools/claude)、[ZCode：模型和 Coding Plan 端点说明](https://zcode.z.ai/en/docs/configuration)。

建议每个 Worker 独立传入环境变量，而不是修改现有的全局 Claude 配置：

```typescript
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: workerConfigDir,
  ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
  ANTHROPIC_AUTH_TOKEN: zaiToken,
  ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3-flash",
};
```

其中 `workerConfigDir` 和 `zaiToken` 由本机配置模块提供，不能硬编码。还需要清理可能冲突的旧认证变量。

**重要限制：Z.ai 官方确认的是 Claude Code 的接入方式，不代表我已经验证最新 Claude Agent SDK 对 GLM-5.3 的完整兼容性。** 因此方案第一阶段就安排真实 Tool Calling 测试。如果 SDK 运行模式有兼容问题，必须先解决，不能直接假设可以正常派发大型开发任务。

## 5\. Codex 应按什么顺序开发？

我已经将任务拆成可验收的四个阶段。

| 阶段                | 开发内容                                                       | 完成标准                                          |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| **P0 · 兼容性验证** | 官方 Agent SDK、GLM 认证、工具调用、MCP 最小握手               | GLM 真正通过 SDK 完成 Read → Tool Result → Answer |
| **P1 · 基础调度**   | `spawn`、`spawn_batch`、`wait`、`status`、`follow_up`、`abort` | Codex 能并行启动两个独立 Claude Code Worker       |
| **P2 · 高级控制**   | 流式 Steering、权限审批、按任务 Skills/MCP、会话 Fork          | 可中途纠偏，权限和资源加载可验证                  |
| **P3 · 工程化**     | SQLite 状态恢复、Worktree、自动测试、合并门禁、指标统计        | 崩溃恢复不盲重试，未验收不能合并                  |

整套文档还定义了 **20 项验收测试**，包括跨 Worker 串话、权限逃逸、未知副作用、模型路由错误和重复执行风险。

## 6\. 下载可以直接交给 Codex 的完整文件

## Claude-Durateam 工程开发方案

ZIP · 约 19 KB · 2 个 Markdown 文件

(已生成并检查文件完整性)

---

**[CLAUDE_DURATEAM_IMPLEMENTATION_PLAN.md](sandbox:/mnt/data/claude_durateam_blueprint/CLAUDE_DURATEAM_IMPLEMENTATION_PLAN.md)**

约 38 KB。包含架构、协议选择、SDK 示例、24 条参考资料 URL、模块设计、权限、模型配置和验收要求。

**[CODEX_START_PROMPT.md](sandbox:/mnt/data/claude_durateam_blueprint/CODEX_START_PROMPT.md)**

约 2.4 KB。用于直接让 Codex 按完整方案开始实施。

### 交给 Codex 的方式

解压 ZIP，把两个 Markdown 文件放到准备开发 `claude-durateam` 的新仓库根目录，然后运行：

```bash
cd ~/dev/claude-durateam
codex -m gpt-6.1-sol
```

在 Codex 中输入：

```
请阅读当前目录的 CODEX_START_PROMPT.md 和 CLAUDE_DURATEAM_IMPLEMENTATION_PLAN.md，将它们作为完整的工程任务契约。直接从 Phase 0 开始实施，先核对官方 SDK API 并验证 GLM-5.3 的真实 Tool Calling，确认可用后继续 Phase 1、2、3。每个阶段完成一大块再统一测试、修复，最终做端到端验收。不得覆盖我原有的 Codex、Claude Code、Pi-Durateam 配置，不得在日志或仓库中存储密钥。完成后报告每阶段的实际测试结果、提交记录与未解决问题。
```



## 7\. 最后还需要注意的两件事

**第一，Claude Agent SDK 的权限比 Pi 丰富，但并不自动等于安全沙箱。** `allowedTools` 仅表示哪些工具可以免审批执行。对于无人值守的 GLM Worker，必须结合工具限制、Hook、Worktree 和实际系统隔离。

**第二，Claude SDK 自带会话持久化，不代表具有 pi-durateam 那样的完整 Durable 任务恢复。** 会话历史、任务状态、Git 文件改动和外部工具副作用是不同层面的事情。因此 P3 需要专门处理崩溃、重复执行和任务接管。

这次提供的是**可以交付 Codex 执行的完整研发规范**，不是已经实现并实测的 `claude-durateam` 软件。文档和 ZIP 均已生成并完成完整性检查；真实 Claude Agent SDK + GLM 联调应由 Codex 在你的 Mac 开发环境中完成。

**最终方案是：MCP 负责让 Codex 指挥，官方 Claude Agent SDK 负责运行 Claude Code，Z.ai 负责 GLM 推理，Git Worktree 和质量门禁负责隔离与验收。ACP 不参与第一版。**

**来源:**

- [Introduction - Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction)
- [Overview - Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview)
- [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/)
- [Releases · anthropics/claude-agent-sdk-typescript · GitHub](https://github.com/anthropics/claude-agent-sdk-typescript/releases)
- [Releases · modelcontextprotocol/typescript-sdk · GitHub](https://github.com/modelcontextprotocol/typescript-sdk/releases)
- [Configure permissions - Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Agent SDK reference - TypeScript - Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/typescript)
