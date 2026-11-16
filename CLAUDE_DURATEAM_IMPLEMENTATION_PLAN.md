# Claude-Durateam：Codex 可执行工程实施方案

> **目标**：在 macOS（Apple Silicon）构建一套由 Codex 通过 MCP 驱动的 Claude Code 多 Worker 调度器。Worker 使用官方 Claude Agent SDK（不是直接调用 Messages API），可以连接 Z.ai 的 GLM-5.3 / GLM-5.3-Flash Anthropic 兼容端点，保留 Claude Code 的 Agent Loop、Skills、MCP 与权限能力。与现有 Pi-Durateam 并行使用，绝不改写现有 Codex 官方订阅配置。  
> **基线日期**：2026-11-16；**参考 SDK**：`@anthropic-ai/claude-agent-sdk@0.3.325`；**MCP**：`@modelcontextprotocol/server@2.4.0`。安装前以 `npm view` 验证实际 Registry 的版本，精确锁定依赖和 lockfile。  
> **实施主体**：Codex。阅读本方案、按阶段动手，不需要先询问用户已经提供过的限制。不得在未成功验证的情况下宣称完成。  
> **重要边界**：以下是工程设计与验收规范，不是已完成或已实测的实现。首次 GLM 调用会消耗用户的 Z.ai 额度。

## 0. 工程结论与禁止事项

1. **对外使用 MCP，不用 ACP**。Codex 作为 MCP Client，`claude-durateam` 作为本地 MCP Server（`stdio`）；MCP 服务内使用 `Claude Agent SDK` 启动真正 Claude Code Agent。ACP 是编辑器↔Agent 协议，留给未来需要 Zed/JetBrains 直接接入时再做 Adapter。
2. **内部 SDK**：`@anthropic-ai/claude-agent-sdk` 的 `query()`、`resume`、SDK 流式输入、`Query.interrupt()`、会话列表、Hooks/permissions。不要用仅提供原始模型接口的 `@anthropic-ai/sdk` 替代。
3. **不使用已经删除的实验性 TypeScript SDK V2**：`unstable_v2_createSession`/`unstable_v2_resumeSession` 等已在 0.3.142 删除；以当前 `query()` API 为准。
4. **不使用 `bypassPermissions`、不自动修改 `~/.codex/config.toml`、不修改全局 `~/.claude/settings.json`、不写入 API 密钥到 Git、日志、MCP 参数或进程命令行**。优先使用 `permissionMode: "dontAsk"` + 明确工具集/沙箱。MCP 服务读取的密钥仅在用户自行配置的私有本地环境注入。
5. **任务隔离**：一个写入 Worker 对应一个独立 Git Worktree 和 Branch。绝不让多个写入 Worker 共享同一工作区；不自动合并 `main`。
6. **功能范围**：V1 稳定实现 `init/models/spawn/spawn_batch/wait/status/sessions/follow_up/abort`；V2 实现更可靠的 `steer/fork/answer`；V3 再实现 durable 恢复和复杂 Coordinator。不能只凭接口名称宣称与 `pi-durateam` 完全等价。
7. **默认一次最多 2 个活跃 Worker，可配置最高 3（初始）**。不要默认递归创建 Claude 原生子代理，也不要让所有 Worker 启动全套 MCP/Plugin。后续根据负载与准确性调整。
8. **保护现有配置**：保留 Codex 官方登录及 Pi-Durateam；新桥接服务独立注册名 `[mcp_servers.claude_durateam]`，不覆盖 `[mcp_servers.pi]` 等条目。MCP 启动可用绝对路径（Mac GUI 的 PATH 可能不完整）。
9. **文档数量**：各大阶段至多新增 3 个 Markdown 文档；主要工作放代码、测试和本文件，避免无意义文档散落。按模块成批实现再统一测试，最终做端到端验收。

## 1. 协议与进程架构

```
                 Codex CLI / Desktop: GPT 主控
                       MCP Client
                          │
              stdio, MCP Tools / JSON-RPC
                          │
         claude-durateam MCP Server (Node.js/TS)
          ├── admission: 校验输入/路径/模型/权限
          ├── scheduler: 队列、并发、租约、deadline
          ├── registry: jobId/runId/sessionId/status
          ├── event bus: 流式事件和长轮询
          ├── state store: SQLite（V3 持久化）
          └── ClaudeAgentRunner
                 ├── Agent SDK query() → Claude Code 二进制 Worker A
                 │      cwd = task-A worktree; model=glm-5.3
                 └── Agent SDK query() → Claude Code 二进制 Worker B
                        cwd = task-B worktree; model=glm-5.3-flash
                                │
                     Anthropic-compatible HTTPS
                                │
                    https://api.z.ai/api/anthropic
```

三个层面必须严格区分：**Codex→桥接器使用 MCP**；**桥接器→Claude Code 使用官方 Agent SDK 的进程/流式控制**；**Claude Code→Z.ai 使用 Anthropic Messages 兼容接口**。本项目不自行生成 Anthropic Messages 请求/工具调用 JSON，更不需要 ACP 参与这条链路。

MCP 传输选择 `stdio`：本地可审计、无需占端口；全部协议输出写 stdout，日志仅写 stderr；未来多台宿主或远程调度才另开 Streamable HTTP + 身份验证。MCP TypeScript SDK v2 的 `serveStdio` 默认兼容旧客户端协议，实际仍需 Codex MCP 握手测试。

## 2. 官方来源 / 版本核对表（必须保留 URL）

| 编号 | 权威资料 | URL | 用途 |
|---|---|---|---|
| R01 | Claude Agent SDK 总览 | https://code.claude.com/docs/en/agent-sdk/overview | 为什么必须用完整 Agent SDK |
| R02 | Claude Agent SDK TypeScript API | https://code.claude.com/docs/en/agent-sdk/typescript | `query`、`Options`、事件、`Query`、`forkSession`、`resume` |
| R03 | 官方 TypeScript SDK Releases | https://github.com/anthropics/claude-agent-sdk-typescript/releases | 精确 SDK 版本，破坏性变化 |
| R04 | SDK 会话管理 | https://code.claude.com/docs/en/agent-sdk/sessions | session_id、resume、fork、持久 transcript |
| R05 | SDK 流式输入 | https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode | 长驻 Worker、queued message、Steering |
| R06 | SDK 权限 | https://code.claude.com/docs/en/agent-sdk/permissions | `dontAsk`、`allowedTools` ≠ 白名单、`disallowedTools` |
| R07 | SDK Hook | https://code.claude.com/docs/en/agent-sdk/hooks | `PreToolUse`、安全策略与可观测性 |
| R08 | SDK Skills | https://code.claude.com/docs/en/agent-sdk/skills | `settingSources`、技能自动发现与按名称选择 |
| R09 | SDK Plugins | https://code.claude.com/docs/en/agent-sdk/plugins | 插件文件夹加载 |
| R10 | SDK 外部 MCP | https://code.claude.com/docs/en/agent-sdk/mcp | 作为客户端连接其他工具、`mcpServers` |
| R11 | SDK 结构化输出 | https://code.claude.com/docs/en/agent-sdk/structured-outputs | JSON Schema/输出验证；外部模型需兼容测试 |
| R12 | SDK 沙箱安全 | https://code.claude.com/docs/en/agent-sdk/typescript#sandboxsettings | `sandbox.enabled` 等参数 |
| R13 | Claude Code 配置与隔离 | https://code.claude.com/docs/en/settings | `CLAUDE_CONFIG_DIR`、配置优先级 |
| R14 | Claude Code 合规与授权 | https://code.claude.com/docs/en/legal-and-compliance | 第三方密钥、SDK 使用限制和品牌使用约束 |
| R15 | MCP 官方 TypeScript SDK 2 | https://ts.sdk.modelcontextprotocol.io/v2/ | v2 包名/能力 |
| R16 | MCP 创建工具服务 | https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server | `McpServer` / `registerTool` |
| R17 | MCP stdio 传输 | https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio | `serveStdio`、stdout 禁止日志 |
| R18 | MCP 官方 Releases | https://github.com/modelcontextprotocol/typescript-sdk/releases | 2.4.0 版本和兼容性 |
| R19 | ACP 官方介绍 | https://agentclientprotocol.com/get-started/introduction | ACP 是 IDE/编辑器连接 Coding Agent 的协议 |
| R20 | ACP v1 协议 | https://agentclientprotocol.com/protocol/v1/overview | 可选未来适配 |
| R21 | Z.ai 官方 Claude Code 接入 | https://docs.z.ai/scenario-example/develop-tools/claude | Z.ai Anthropic endpoint、密钥配置、模型映射 |
| R22 | ZCode 官方端点表 | https://zcode.z.ai/en/docs/configuration | Coding Plan：Anthropic `https://api.z.ai/api/anthropic` |
| R23 | Z.ai 官方 Coding Plugin | https://github.com/zai-org/zai-coding-plugins | 可选使用量查询，非本项目强依赖 |
| R24 | 参考：pi-durateam | https://github.com/Nyarlathoteppppp/pi-durateam | 外部工具名称与任务模型参考；严禁直接照搬 Pi SDK 逻辑 |

如果官方 API/版本变化，以锁定版本及其声明文件为准，不要复制过时博客代码。`@anthropic-ai/claude-agent-sdk@0.3.325` 是 2026-11-13 的 GitHub Release；`@modelcontextprotocol/server@2.4.0` 是公开的 MCP TypeScript SDK v2 发布版本。npm 是否同步必须在执行机器上验证。

## 3. 环境准备与 Z.ai / GLM 兼容性门槛（P0，必须第一阶段完成）

### 3.1 非破坏性检查

```bash
node --version
npm --version
claude --version || true
codex --version || true
npm view @anthropic-ai/claude-agent-sdk version
npm view @modelcontextprotocol/server version
```

建议 Node.js 22/24；采用独立工作目录（例如 `~/dev/claude-durateam`），不得对现有 Pi、Codex 或 Claude 用户设置做原地修改。项目创建时：

```bash
mkdir -p ~/dev/claude-durateam
cd ~/dev/claude-durateam
npm init -y
npm install --save-exact @anthropic-ai/claude-agent-sdk@0.3.325 @modelcontextprotocol/server@2.4.0 zod@4
npm install -D typescript tsx @types/node vitest
# 按 npm 的真实版本解析结果确认，生成 package-lock.json 并提交
```

如 `0.3.325` 还无法从 npm 获取，保持可用最新正式版本，记录实际版本和 API 差异，不要静默安装 `latest` 再假设代码仍匹配。

### 3.2 不改写已有 Claude 登录，单独配置 GLM Worker

为独立的 GLM Worker 准备一个仅当前用户可读的配置目录（具体路径由用户机器选择）：

```
~/.config/claude-durateam/
  worker-home/                 # 用于 CLAUDE_CONFIG_DIR，不含其它账号的登录
  credentials.env             # chmod 600，存放密钥；绝不进 Git
  state/                       # SQLite 和结果、日志
```

配置源：Z.ai 官方 Claude Code 文档和 ZCode 端点表：`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`，`ANTHROPIC_AUTH_TOKEN=<用户本机安全提供>`；按任务指定 `model: "glm-5.3"` / `"glm-5.3-flash"`，同时可配置 `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`，避免 Claude Code 内部模型选择回退到其它渠道。兼容层的有效模型名称必须用真实 API Smoke Test 核实。

**重要**：Z.ai 的 Anthropic endpoint 是 `/api/anthropic`，不是给 OpenAI-compatible 工具使用的 `/api/coding/paas/v4`。Coding Plan 适用性和模型列表以用户的实际账号/方案为准；Z.ai 官方部分教程的模型映射说明可能仍包含较旧的 GLM-4.7，所以不要据此猜测默认路由。

**建议的子进程环境构建逻辑（伪代码，Codex 按实际类型实现）：**

```ts
const env = {
  ...process.env,                       // SDK env 是替换而非增量！保留 PATH/HOME
  CLAUDE_CONFIG_DIR: workerHome,
  ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
  ANTHROPIC_AUTH_TOKEN: getSecretSecurely(),
  ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3-flash",
  API_TIMEOUT_MS: "120000",
};
// 净化冲突的 ANTHROPIC_API_KEY、无关代理/认证环境、配置泄露日志。
// 不在日志输出整个 env，不把 key 放在 CLI argv。
```

不要依赖 `CLAUDE_CONFIG_DIR` 就认为密钥自动隔离完毕；自带 MCP 配置、project settings、其他用户环境变量都要进行最小化/审核。参照 Claude 官方 settings 文档核实实际覆盖顺序。

### 3.3 P0 双重 Smoke Test：不通过就暂停 SDK 主线

1. **CLI 模式**：以临时 GLM 环境、临时项目、完全只读任务运行 `claude -p`；验证 Z.ai endpoint、显示模型、响应文本和工具调用成功。不得依赖其它 `~/.claude` 登录成功的假象。
2. **SDK 模式**：使用 `query({ prompt, options: { cwd, model: 'glm-5.3', env, settingSources: [], permissionMode: 'dontAsk', tools: ['Read','Glob','Grep'], allowedTools: ['Read','Glob','Grep'], maxTurns: 5 }})` 读取临时仓库中已知文件并报告内容；正确消费 `system/init` 和 `result`；异常必须记录具体 SDK/CLI/HTTP 错误（脱敏）。
3. **双模型探测**：`glm-5.3` 和 `glm-5.3-flash` 分别跑一次只读工具链；检查返回实际模型是否匹配请求、无意外费用源、无拒绝工具、响应结构完整。
4. **安全测试**：清除 GLM token 后必须失败；不允许悄悄回退到 Anthropic 登录/默认模型。用假的 token 发起的测试必须不泄露凭据。
5. **兼容测试**：GLM 模型执行 `Read`/`Grep`、一次受控 `Edit`，并在隔离 Worktree 运行简单测试（仅经许可的沙箱命令），记录 token 使用、工具表现和缓存信息。不要将 Claude Code SDK 本地 `total_cost_usd` 当作 GLM Coding Plan 真实账单。

**P0 退出条件**：至少一个 GLM 模型经 Agent SDK 真实完成完整 Tool Call → Tool Result → Final Answer，且不读取/修改已有用户订阅配置。若 SDK 不兼容而 `claude -p` 兼容，则记录差异，考虑做独立 CLI Adapter 原型；不能未经确认继续构建声称兼容的 SDK Backend。

## 4. P1 系统模块与源码布局

建议目录（允许合理调整，但保持职责清晰）：

```
claude-durateam/
├── package.json
├── package-lock.json
├── tsconfig.json
├── README.md
├── src/
│   ├── main.ts                  # serveStdio MCP 入口
│   ├── mcp/
│   │   ├── tools.ts             # 工具 schema 和 handlers
│   │   └── contracts.ts         # MCP 输入、输出 TypeScript/Zod 契约
│   ├── scheduler/
│   │   ├── admission.ts         # worktree、模型、路径、工具权限前置验证
│   │   ├── scheduler.ts         # 并发队列、租约、取消
│   │   ├── registry.ts          # jobId/runId/sessionId 的映射和状态
│   │   └── events.ts            # 事件订阅 / wait 事件等待
│   ├── engines/
│   │   ├── runner.ts            # AgentRunner interface，可注入 FakeRunner
│   │   ├── claude-sdk.ts        # SDK query() 与事件适配
│   │   ├── environment.ts       # GLM 环境、密钥、模型白名单、配置隔离
│   │   ├── profiles.ts          # 只读、写入、安全沙箱 Profile
│   │   └── messages.ts          # SDK message → 通用事件
│   ├── workspace/
│   │   ├── paths.ts             # realpath / symlink / allow-root
│   │   ├── worktree.ts          # Git worktree 生命周期
│   │   └── gate.ts              # 改动范围与验收门禁
│   ├── state/
│   │   ├── memory.ts            # P1 内存状态
│   │   └── sqlite.ts            # P3 durable 后端
│   └── observability/
│       ├── redact.ts            # 路径和 secret 脱敏
│       └── metrics.ts           # 时间、turns、tokens、错误分类
├── test/
│   ├── fixtures/
│   ├── mcp.test.ts
│   ├── scheduler.test.ts
│   ├── permissions.test.ts
│   ├── workspace.test.ts
│   ├── sdk-fixture.test.ts
│   └── recovery.test.ts
├── examples/
│   ├── codex-config.example.toml
│   └── batch.example.json
└── scripts/
    ├── doctor.ts
    └── verify-local.sh
```

### 4.1 必须实现的内部接口（接口示意，Codex 按编译器真实类型编码）

```ts
export interface AgentRunner {
  start(request: WorkerRequest, onEvent: (e: WorkerEvent) => void): Promise<AgentRun>;
  resume(sessionId: string, prompt: string, onEvent: (e: WorkerEvent) => void): Promise<AgentRun>;
  cancel(runId: string): Promise<void>;
}

export interface WorkerRequest {
  jobId: string;
  cwd: string;                     // 绝对、已验证的 Worktree
  model: "glm-5.3" | "glm-5.3-flash";
  prompt: string;
  profile: "read" | "edit" | "sandboxed-bash";
  maxTurns: number;
  deadlineMs: number;
  allowedSkillNames: string[];
  enabledMcpServers: string[];
}

export type JobState =
  | "queued" | "starting" | "running" | "needs_attention"
  | "succeeded" | "failed" | "cancelled" | "timed_out"
  | "interrupted" | "unknown_outcome";
```

外部 `jobId` 由 MCP 桥接器生成，用于 stable task identity；SDK 返回的 `session_id` 为真实 Claude conversation ID；单次执行的 `runId` 和 `attempt` 单独保留。三者不能混用。初始注册任务时就写出 `jobId`，不要等 SDK 完成后才生成。

### 4.2 MCP 工具契约

| 名称 | 核心输入 | 关键输出 | 必须满足的语义 |
|---|---|---|---|
| `init` | 可选 `cwd` | 版本、profile、模型和限制 | 只读诊断，不运行模型；不输出 secrets |
| `models` | filter | 可用模型和默认值 | 严格限制 GLM 可用模型，模型失败拒绝降级 |
| `spawn` | prompt,cwd,model,profile,maxTurns,deadline | jobId,state | **非阻塞**，队列可等待，不得在 MCP call 内等长任务 |
| `spawn_batch` | tasks[] | jobIds[] | 在启动任何任务前**全部验证**；任务各自独立 Worktree；最多并发阈值 |
| `wait` | jobId / jobIds, afterRevision, timeoutMs | state, revision, nextAction, continueIds, compact result | 有界事件等待，超时只代表本次没有新状态，不代表任务失败 |
| `status` | jobId, verbose? | bounded snapshot | 返回最近事件/工具摘要，避免主 Agent 收到完整日志 |
| `sessions` | cwd, state | 已知任务及 Claude session 映射 | 过滤、分页、不输出敏感路径内容 |
| `follow_up` | jobId,prompt | new runId, state | 只允许 idle 的同一会话；必须用准确 `resume` UUID，不用 `continue:true` |
| `abort` | jobId | current state, cancel outcome | 中止执行，标注可能的部分写入，不擅自回滚 |
| `steer` | jobId,message | disposition (`queued`/`delivered`/`unsupported`) | V2 流式输入控制；不得假冒已送达 |
| `fork` | jobId, optional messageId | new session ID | V2 使用官方会话 fork，区别于 Git Branch/Worktree |
| `answer` | jobId, requestId, decision | ack | V2 专用审批队列；无头默认拒绝而非自动批准 |

**统一状态 JSON 示例：**

```json
{
  "jobId": "CDT-00001",
  "sessionId": "<Claude SDK UUID or null>",
  "state": "running",
  "revision": 7,
  "nextAction": "wait",
  "modelRequested": "glm-5.3",
  "modelReported": null,
  "durationMs": 19000,
  "toolCallCount": 8,
  "latestTextPreview": "",
  "lastError": null,
  "usage": {
    "inputTokens": null,
    "outputTokens": null,
    "cacheReadTokens": null,
    "sdkCostEstimateUsd": null,
    "providerBilledCostUsd": null
  }
}
```

实际数据为空时返回 `null`，不伪造 0。主 Agent 默认只看 compact 输出；`verbose:true` 才查看长文本、完整工具 Trace（仍有内容和 secret 上限）。

## 5. P1：MCP 服务落地（使用当前官方 v2，而不是旧包名）

MCP v2 推荐独立包 `@modelcontextprotocol/server`：

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

// 这是接口样例：业务实现由 Codex 在 supervisor 中完成
serveStdio(() => {
  const server = new McpServer({ name: "claude-durateam", version: "0.1.0" });
  server.registerTool("spawn", {
    description: "Start a Claude Agent SDK worker asynchronously",
    inputSchema: z.object({
      cwd: z.string(),
      prompt: z.string(),
      model: z.enum(["glm-5.3", "glm-5.3-flash"]),
      profile: z.enum(["read", "edit", "sandboxed-bash"]).default("read")
    })
  }, async (args) => {
    const result = await supervisor.spawn(args); // 立刻返回 jobId
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  return server;
});
```

注意 `serveStdio()` 启动后 stdout 完全属于 JSON-RPC 通道；所有 log 应写 stderr。需通过 MCP Inspector 和真实 Codex Client 测试握手/`tools/list`/`tools/call`/长轮询取消。

**Codex 侧配置示例（不直接覆盖已有配置）**：

```toml
[mcp_servers.claude_durateam]
command = "/opt/homebrew/bin/node" # 用本机 command -v node 替换
args = ["/ABSOLUTE/PATH/claude-durateam/dist/main.js"]
startup_timeout_sec = 30
tool_timeout_sec = 120

[mcp_servers.claude_durateam.env]
CLAUDE_DURATEAM_HOME = "/Users/YOU/.config/claude-durateam"
```

不要把 `ANTHROPIC_AUTH_TOKEN` 写在可分享的 TOML 里；MCP 服务启动后仅从用户批准的本地秘密存储读取。若 Codex GUI PATH 缺少 Node、Git、Claude CLI，改为绝对路径并做启动诊断。

## 6. P1：SDK Worker 实现细节

### 6.1 最小 `query()` 调用

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const controller = new AbortController();
const q = query({
  prompt: task.prompt,
  options: {
    cwd: task.cwd,
    model: task.model,
    env: makeSanitizedWorkerEnv(),
    abortController: controller,
    settingSources: ["project"],  // 项目 CLAUDE.md / Skills；不自动加载用户全部设置
    skills: task.allowedSkillNames,
    permissionMode: "dontAsk",
    tools: ["Read", "Glob", "Grep"],
    allowedTools: ["Read", "Glob", "Grep"],
    maxTurns: task.maxTurns,
    persistSession: true,
  },
});

try {
  for await (const message of q) {
    // 处理 system/init: 捕获 session_id、实际配置、MCP 初始状态
    // 处理 assistant/tool 事件: 更新 revision、工具进度、token 数据
    // 处理 result: subtype === 'success' 且 is_error === false 才算模型完成
    // 注意 error result 也有 session_id；保存它以便诊断
  }
} catch (err) {
  // 单次 query 可能先 yield error result，再 throw；避免重复计入失败
} finally {
  q.close();
}
```

上面的代码用于 Codex 编译验证和改造。`settingSources` 的当前默认值实际上会加载 CLI 的 user/project/local 配置；本项目**显式传 `['project']`** 减少全局扩展带入，若要复用用户 Skill/MCP 只对批准的 profile 开启额外来源。`skills` 名称需要结合实际 SDK 枚举、插件位置和项目目录验证；不要把绝对路径当作 Skill 名称。

### 6.2 工具与权限 Profile

- `read`：`tools=['Read','Glob','Grep']`，`permissionMode='dontAsk'`，其他操作不得获得可执行能力；没有网络 MCP；通常没有 Shell。
- `edit`：增加 `Edit`,`Write`，仍不开放 `Bash`；阶段完成后由桥接器/集成门禁执行 Typecheck、Lint 和测试。适合大量低成本 Worker。
- `sandboxed-bash`：仅在需要自建/测试命令时开放 `Bash`，必须启用 `sandbox: { enabled:true, failIfUnavailable:true, allowUnsandboxedCommands:false, autoAllowBashIfSandboxed:false, ... }`，并明确允许工作区写入、限制敏感路径与必要网络。`autoAllowBashIfSandboxed:false` 是 SDK 0.3.325 的新默认，应配合明确审批；不得以 `allowedTools` 为唯一边界。macOS 上若 sandbox 不可用，直接失败，不能自动降级到宿主机执行。
- 非授权外部 MCP、插件、浏览器和网络请求默认不开放；任何带写入/网络能力的第三方 MCP 都需要额外独立授权，因为 Bash 沙箱无法控制另一个 MCP 服务的副作用。

**关键安全规则**：`allowedTools` 是免审批规则，**不是严格工具白名单**；需要 `tools` 显示工具、`disallowedTools`、`permissionMode`、`PreToolUse` Hook、真实文件系统隔离共同约束。即使在独立 Worktree，只要非沙箱 Bash 或某个 MCP 有权限，仍可访问宿主文件系统。

### 6.3 Skills、CLAUDE.md、MCP 的资源继承

- SDK 当前 `query()` 省略 `settingSources` 时，默认加载 CLI 的 user/project/local 文件系统设置。为了让 Worker 精简，默认使用 `settingSources:['project']`；它仍应按官方规则加载项目 CLAUDE.md/`.claude/skills/`，并通过 `skills` 仅允许任务所需技能。
- `settingSources:['user','project']` 只对可信 Worker 使用；`CLAUDE_CONFIG_DIR` 单独设置全局用户配置目录，不应导入其它账户/插件的所有配置。
- `plugins` 只接受当前 SDK 支持的本地插件路径；如要加载已安装插件，不应假设它们自动继承，先建立白名单，检测 `initializationResult()`/实际工具列表。
- `mcpServers` 由 bridge 按名称从预先批准的 server catalog 注入；开启 `strictMcpConfig:true`（确认该字段在锁定 SDK 版本可用）避免未经授权的项目/用户级 MCP 混入；官方 MCP 客户端连接时机可异步，先检查连接状态再要求模型使用工具。
- 任务需求涉及不同 Git Worktree/配置根时注意 `cwd` 与 `projectConfigRoot` 的区别；不要无意读取主 checkout 的未经授权配置/文件。

### 6.4 模型与成本

- 使用白名单 `glm-5.3`, `glm-5.3-flash`。默认高难度任务 GLM-5.3，简单搜索/小范围修复 GLM-5.3-Flash（仅为建议，需真实任务验证）。
- SDK `supportedModels()` 只说明 Claude 运行时报告什么；Z.ai 兼容端点真正能否调用模型、支持哪些思考级别、缓存和 Tool Calling，需要实际请求验证。模型名不认识时显式报错，不自动落回 Anthropic 官方模型。
- 收集 `SDKResultMessage.usage`/`modelUsage`/`total_cost_usd`，但将 `sdkCostEstimateUsd` 与 `providerBilledCostUsd` 分离：SDK 本地价格估算不等同 GLM Coding Plan 额度或账单；不可用时用 null。
- 记录 task wall-clock、主 Agent 工具调用摘要、worker turns、失败率、一次通过率、fallback、重试数。不要声称一定节省 GPT token；由回归实验对照。

## 7. P2：真正的多 Agent 调度及 Streaming Steering

### 7.1 调度规则

- `spawn_batch` **先验证整批**：模型 ID、任务 ID、每个 `cwd`、受限目录、无重叠写入 Worktree、权限 profile、maxTurns/deadline、任务上限、资源占用；若任一失败，零任务启动。
- 内部统一 `maxConcurrent=2`（默认），设置为 3 才最多 3 个 Worker 并行。超过并发的任务排入 FIFO / 优先级队列，`spawn` 不阻塞 MCP；队列任务允许取消。
- 同一 Worker 单独持有 `runId`、`sessionId`、`AbortController`、持续读取事件的 async consumer；审查任务允许多个只读 Worker 共用同一 checkout，但写入任务**只能**分配独立 worktree。
- `wait` 做事件驱动长轮询，使用 `revision`/`afterRevision`，一次等待上限 30 秒（可配置但不超宿主 MCP timeout）。超时返回 `state:'running'` 和 `continueIds`；“一次 wait 超时”不是“任务超时”。
- `follow_up` 必须等任务明确 idle/terminal 且 sessionId 有效，使用准确的 `options.resume: sessionId`，而**不能**使用 `continue:true`，因为多个 Worktree/会话时 `continue:true` 按目录找最近会话，可能串话。
- SDK 每次完成的结果都是**模型完成**，最终代码验收由外部 Git/测试门禁作最终判断（不同 `modelSucceeded` 与 `gatePassed`）。

### 7.2 Streaming Steering 语义

Claude Agent SDK 当前 TypeScript 支持 `prompt: AsyncIterable<SDKUserMessage>`，长驻 Query，用户输入可带 `priority`：

- `priority:'next'`（默认）：在当前在执行的工具调用结束后尽快让模型在同一回合读取；若回合已经结束则作为下一回合。
- `priority:'later'`：等本回合结束后执行一个新回合。
- `priority:'now'`：更强的当前回合干预；可配合 `origin:{kind:'human'}`，具体背景任务与中断行为受 CLI 版本约束。

实现 `AsyncUserMessageQueue` 供流式 `query()` 消费；将外部 `steer` 映射为带 `priority:'next'` 的 `SDKUserMessage`，并返回 `accepted_to_queue` 状态。只有确实从 SDK 确认交付/观察到新消息后，才将状态升级为 `delivered`；不要在 `queue.push()` 后直接谎称模型已执行。

`abort` 首先使用 `query.interrupt()`（仅 streaming 模式可用）或 `AbortController.abort()`，然后确认终态并清理。对于 SIGKILL、正在执行的文件写入或外部副作用，不承诺回滚。短任务可以继续用单次 `query()`+resume，长任务才用 stream mode；这两类实现由同一状态模型统一。

### 7.3 用户审批 / AskUserQuestion

- SDK 的 `canUseTool` 并非对所有已放行工具都会调用。实现高风险动作审批时，必须结合 `PreToolUse` Hook 或系统安全隔离。
- `answer` 仅针对实际挂起、记录了 `requestId` 的 `canUseTool`/`AskUserQuestion`，带超时与明确拒绝策略，不能由主 Agent 在未获授权的情况下默认同意破坏性动作。
- 未收到审批时 `needs_attention` 可观测；不要把审批卡住误认为模型无响应。默认对无人值守任务使用无需审批但受限的 profile，高风险任务交给用户审批。

## 8. P3：持久化、恢复、Worktree、质量门禁

### 8.1 数据模型（SQLite）

至少有以下表/集合：`jobs`、`runs`、`events`、`leases`、`approvals`、`sessions`、`artifacts`、`gates`。将 `jobId` 与真实 `Claude session UUID` 映射持久化；记录 `ownerPid` / host marker、lastEventRevision、start/finish timestamps、worktreePath、model/profile、真实工具进度和执行结果。

恢复策略：
- 服务重启后，`sessions` 可列出已知任务和恢复状态；只对确定安全且状态可重建的空闲会话做 `resume`。
- 恢复中若不确定 Bash、Git、MCP 远程写入是否已经完成，标 `unknown_outcome` 并让 Codex/人检查 Git diff、外部状态，再显式确认重试。绝不自动重复部署、提交或删除。
- Claude SDK Transcript 持久化≠任务可安全恢复≠Worktree 文件状态恢复。Worktree 由 Git 管理，SDK transcript 和任务数据库只负责对话/调度状态。
- 用 SQLite 事务、进程级 ownership/租约阻止两台宿主同时恢复相同任务；对进程崩溃、工具超时、主 Agent 退出和重新连接分别测试。

### 8.2 Git Worktree

- 新写入任务：从指定且干净的 base commit 创建 `agent/<feature>/<jobId>` 分支及 sibling worktree；提前验证磁盘空间、路径、无现存同名 worktree/branch。
- Worker 只在该 worktree 内执行；禁止直接修改主 checkout 的受保护文件（默认 `package.json`/lockfile、CI/workflows、部署、secret 路径；若任务确实需改，必须由主 Agent 显式单独授权）。
- `git diff --name-status`、`--numstat`、`--check` 等作门禁；防止 symlink、二进制和重命名漏检；检测未提交文件、被忽略的新文件及越界操作。新增白名单来自任务契约，不应由 Worker 自己修改。
- 每个 Worker 完成后，先外部 gate 才提交/合并到 `integrate/<feature>`，再由 Codex 统一检查集成结果。**禁止自动向 `main` push 或 merge**。
- Git Worktree 不是沙箱；外部系统权限要另外隔离。macOS 优先评估 Claude SDK 自带 Sandbox/Seatbelt 的适用范围与限制；不为追求自动化而默认 `bypassPermissions`。

### 8.3 批量测试策略

- 不每改几行都运行一轮全量测试。Worker 实现完整模块后运行**定向** Typecheck/单元测试（如果授予 Bash），否则统一由 `gate` 运行。
- 同一批工作实现完毕后，`integrate` Worktree 按次序执行适用项目的 `lint → typecheck → unit tests → build → E2E`，失败时优先定向修复，再执行完整验收。
- 在没有配置实际检查命令的任务上，默认报告 `not_verified`，不得输出 `tests_passed:true`。

## 9. 必做测试矩阵（验证工程，而不是只编译成功）

| ID | 测试 | 通过条件 |
|---|---|---|
| T01 | MCP stdio 握手与 `tools/list` | Codex 或 MCP Inspector 能看到 `spawn` 等工具；stdout 无日志污染 |
| T02 | 模型路由 GLM 5.3 | 真正发送到 Z.ai，返回真实有效模型和已知文件内容；未用 Anthropic 帐号 |
| T03 | GLM-5.3-Flash 路由 | 同上，并报告两模型差异 |
| T04 | 错误密钥 | 报认证失败，不回退到官方 Claude 模型，不泄露密钥 |
| T05 | 只读 Worker | 读、grep 成功；Write/Edit/Bash 被拒绝 |
| T06 | 编辑 Worker | 只改允许的目标文件，结构化结果和 diff 可见 |
| T07 | 并行两个写入 Worker | 独立 worktree，不覆盖彼此代码，队列/状态正确 |
| T08 | `spawn_batch` 原子失败 | 某一项 cwd/model 非法，所有项均不启动 |
| T09 | `wait` 事件驱动 | 正常进度、partial、settled、超时语义区分清楚 |
| T10 | `follow_up` | 仅向指定 session ID 续接，另一个 Worker 不串话 |
| T11 | `steer` (P2) | 当前工具完成后注入纠偏；收到明确信号才确认送达 |
| T12 | `abort` | 中断后终态可观测，不声称自动撤销已写文件 |
| T13 | 权限逃逸 | `../`、symlink、绝对路径越界、脚本变相写入、外部 MCP 未授权被阻止或标风险 |
| T14 | Sandbox 不可用 | `sandboxed-bash` 启动失败，不降级到宿主执行 |
| T15 | Session 恢复 (P3) | 进程重启后可识别已完成/未完成/未知副作用，不盲重试 |
| T16 | Worktree Gate | 非法改 `package.json`、CI 或越权文件拒绝集成 |
| T17 | 主 Codex 官方配置 | 现有登录、Pi-Durateam MCP 无变化；新 MCP 用独立注册名 |
| T18 | 工具/Skill 资源 | 只读/编辑 Profile 加载名单可验证，不暗自加载全部 MCP |
| T19 | 资源负载 | 同时 2/3 个 Worker 对 Mac 内存、CPU、启动耗时、空闲回收进行记录 |
| T20 | 成本 A/B | 同任务比较 GPT 独立执行与 Codex+GLM，记录总用量、返工和验收结果；不编造 savings |

自动化测试必须使用 FakeAgentRunner 或独立临时仓库，不需要任何真实模型密钥；只有显式的 `test:live` 才调用 Z.ai，且不进入常规 CI。

## 10. 实施阶段与验收门槛

**Phase 0 — 探测与协议基线**：搭目录、锁依赖、SDK+Z.ai 最小只读和工具调用 Smoke Test、MCP 最小握手。没有 P0 的真实兼容成功报告，不进入后面全部开发。交付：版本记录、脱敏测试报告、可复现脚本。

**Phase 1 — 可用的 Claude-Durateam MVP**：MCP v2 标准工具、模型白名单、任务状态和并发队列、读/编辑 Profile、SDK query/resume、wait、abort、状态结构与最小测试。交付：Codex 可以一次派给两个独立 Worker，收结果，保持官方 Codex/ Pi 配置不变。

**Phase 2 — 中途控制与精细权限**：流式输入、steer priority next/later/now、审批与准确确认、session fork、按任务 Skill/MCP 白名单、沙箱 Bash。交付：运行中修改任务不需要重新读完整项目；权限拦截真实有效。

**Phase 3 — Durable、质量门禁和指标**：SQLite 检查点/恢复、Git Worktree 自动管理、集成门禁、成本/资源/任务完成率报表。交付：服务重启不会丢已知任务或重复外部副作用，未通过门禁不能合并，资源开销有数据。

每个 Phase 一次完成主要代码后统一运行本阶段测试与修复；只在 P0/集成测试失败处回到局部问题修复；最终统一运行跨阶段端到端验收。

## 11. 非目标与风险

- **不**重写 Claude Code Agent Loop、不直接写 Anthropic Messages Tool Call Loop、不开发 ACP Server（V1）、不做云端多租户服务、不替代 Codex/Pi-Durateam。
- **不**以 SDK 成本估算代表 Z.ai 订阅额度；不承诺 GLM 模型工具调用质量等同 Anthropic Claude 模型；不要以“自称 Claude SDK”绕过服务条款。
- **不**在不具备操作系统隔离时声称 Git Worktree 是安全沙箱；MCP 外部服务不一定受到 Claude Bash 沙箱保护。
- **不**将 `allowedTools` 误当严格安全名单；不使用 `bypassPermissions` 默认授权；不把 prompt 中的“请勿”当强制权限。
- **不**把 `query()` 的 `continue: true` 用于多会话唯一定位；必须用 `resume: sessionId`。
- **不**让 `spawn`/`wait` 无限阻塞 MCP；每次请求在宿主超时预算内返回。
- **不**盲目重放未知结果的 Git/网络/部署工具操作；恢复先核实真实外部状态。
- 使用 Anthropic 品牌/SDK 开发或将 Claude Code 集成到产品时遵守其 Legal & Compliance：不得擅自向第三方提供 claude.ai OAuth 登录、转售订阅凭据；使用用户自己授权的 API Key/适用第三方推理提供商凭据。发布商业产品前复核品牌与条款。

## 12. 最终 Codex 交付清单

1. `npm install && npm run build && npm run typecheck && npm test` 在干净源码目录通过。
2. `node dist/main.js` 可作为可用的 stdio MCP 服务；MCP Inspector/真实 Codex `tools/list` 确认。
3. 本机示例配置 `examples/codex-config.example.toml` 不含密钥、不覆盖用户现有配置。
4. `doctor` 输出清晰：Node/SDK/MCP 版本、Claude 运行时、Z.ai model/endpoint 配置是否可用（不显示 secret）、Skill/MCP 选择、沙箱、PATH。
5. 隔离工作区 + 真实 `glm-5.3` 和 `glm-5.3-flash` API Smoke Test；若失败，列出阻断项与证据，不伪称全部完成。
6. 至少 2 个并行任务、续接、取消、失败测试，以及最终集成门禁的真实记录。
7. 中文 README：安装、配置、调用、权限、故障恢复、测试/兼容边界和最小实例，不超过阶段文档上限。
8. 最终输出每阶段完成/未完成事项、测试命令及结果、未解决风险、后续建议和 commit SHA。

---

**实施原则总结**：先证明 “Claude Agent SDK + GLM-5.3” 真实能工作；用 MCP stdio 暴露给 Codex；坚持单任务唯一 Session、独立 Worktree 和明确权限；完成整个任务批次再统一验收；长任务的 Steering、持久化和恢复逐阶段增强。切勿直接移植 Pi SDK 的内部接口，也无需 ACP。
