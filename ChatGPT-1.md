# Codex 指挥 Claude Code：能否做出 `claude-durateam`？

**能，而且不需要重新实现 Claude Code 的编程能力。**

我查了 Anthropic 最新的 Claude Code 和 Agent SDK 官方文档。Claude Code 现在已经公开了足够多的控制接口，可以让 Codex 通过 MCP 启动、管理和恢复真正的 Claude Code 编码会话。

最关键的是官方的 **[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)**：它提供的就是 Claude Code 背后的 Agent Loop、文件工具、终端工具、权限、会话和上下文管理，而不只是一个调用模型 API 的普通 SDK。

所以，你想实现的架构完全有技术基础：

**Codex · GPT-6.1**

任务拆分、监督、最终验收

**claude-durateam · 你可以开发的 MCP**

spawn\_batch · wait · steer · follow\_up · sessions · abort

**Claude Code Worker**

GLM-5.3 · 独立 Worktree

**Claude Code Worker**

GLM-5.3-Flash · 独立 Worktree

而且 **Z.ai 官方已经提供 Claude Code 接入 GLM-5.3 的配置方法**：让 Claude Code 使用 Z.ai 的 Anthropic 兼容接口，模型请求消耗你的 GLM Coding Plan 或对应 API 额度，不必消耗 Anthropic 的 Claude 模型额度。

但是，“可以做到相同的任务调度能力”和“底层实现与 Pi 一样”是两件事。

| 关键区别                 | Pi + pi-durateam   | Claude Code + 自研 MCP                           |
| ------------------------ | ------------------ | ------------------------------------------------ |
| 原生 Agent 编程运行时    | Pi SDK             | Claude Agent SDK                                 |
| 从主 Agent 派发任务      | 支持               | 支持，可封装为 MCP                               |
| 多个并行 Worker          | 支持               | 支持，调度层自行管理                             |
| 会话恢复、继续对话       | 支持               | 官方支持                                         |
| 会话分支                 | 支持               | 官方支持                                         |
| 中断运行                 | 支持               | 官方支持                                         |
| 运行中调整任务           | Pi `steer`         | 可以通过流式输入和会话控制实现，但语义不完全相同 |
| 复用 Skill、MCP、插件    | 支持，需要资源配置 | 官方支持，需要正确加载设置与插件                 |
| 对工具执行进行权限控制   | 主要依靠桥接器限制 | 官方有工具权限、Hook 和审批接口                  |
| 持久化任务队列、失败恢复 | pi-durateam 已实现 | 需要额外开发调度与恢复层                         |

Claude Agent SDK 还提供 `forkSession()`、`interrupt()`、`setModel()`、权限回调、工具事件以及会话列表读取等接口。

**所以不是因为 Pi 有什么不可替代的特殊能力。真正的区别在于：Pi 把 Agent 内核开放得比较直接，而 Claude Code 更适合通过官方 Agent SDK 或 CLI 子进程来控制。**

下面再看现成 GitHub 项目到底实现到了什么程度，以及 ZCode 为什么可能比这两者更难做。

## 一、现成的 Claude Code MCP：找到了，但成熟度差异很大

我在 GitHub 找到下面几种真正把 **Claude Code CLI** 当作 Worker 的实现。它们不是简单地把 Anthropic 模型包装成工具。

GitHub Star、Fork 和更新日期为本次查询时的数据；功能依据仓库文档和关键源码核查，尚不代表我在你的 Mac 上完成了实测。

| 项目                                                                                     | Star / Fork | 实际做到的能力                                                     | 我的评价                    |
| ---------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------ | --------------------------- |
| [mcp-agents](https://github.com/thomaswitt/mcp-agents)                                   | 21 / 5      | Codex 与 Claude Code 双向调用；Claude 侧侧重一次性任务、状态与结果 | 值得试，但不是完整 Durateam |
| [claude-mcp](https://github.com/Pr0gCat/claude-mcp)                                      | 1 / 0       | `spawn_agent`、消息投递、等待、恢复、中断、SQLite 状态             | **架构最接近**，项目较小    |
| [codex-claude-subagent](https://github.com/zetsubo-dev/codex-claude-subagent)            | 0 / 0       | Codex 调度 Claude Code 交互会话、并发审查、会话恢复                | 功能有趣，但权限设计不合适  |
| [claude-code-agent-for-codex](https://github.com/Qihao-Duan/claude-code-agent-for-codex) | 2 / 0       | `claude -p`、异步任务、续接、状态查询                              | 轻量参考实现                |
| [subagent-mcp](https://github.com/Heretyc/subagent-mcp)                                  | 3 / 2       | Claude/Codex 子 Agent、全局并发控制、任务调度                      | 功能多，27 个未关闭 Issue   |
| [agent-runtime](https://github.com/FBisca/agent-runtime)                                 | 1 / 0       | MCP 派工、SQLite 任务记录、消息传递、等待和恢复                    | 新项目，依赖外部终端管理器  |

### 其中三个值得特别分析

**`Pr0gCat/claude-mcp` 最接近你想做的 `claude-durateam`。**

它的源码确实注册了 `spawn_agent`、`send_message`、`followup_task`、`wait_agent`、`interrupt_agent`、`list_agents`、`read_agent`、`list_models` 八个 MCP 工具，不只是 README 中画了一张架构图。

它采用 Claude CLI 子进程与持久状态管理，实现多会话并发；仓库 README 还包含 macOS 进程管理和意外退出恢复的设计。

但是项目 Star 很少，公开提交历史有限。尤其它为了减少嵌套和外部依赖，会限制 Worker 访问其他 MCP 与子代理能力。**这与“最大程度保留你原本安装的 Claude Code 插件、Skill 和 MCP”不是同一个目标。**

**`thomaswitt/mcp-agents` 的维护历史相对多一些。**

它不仅能让 Claude Code 调 Codex，还能反过来让 Codex 调 Claude Code。不过我检查其项目说明和实现后发现，它对 Codex 侧的持久化线程支持更完整，Claude 侧更侧重单次任务、独立审查与后台结果收集。

它值得借鉴 MCP 服务、CLI 进程管理和状态收集方式，但不宜直接认定它已经实现了 `pi-durateam` 的全部会话控制功能。

**`zetsubo-dev/codex-claude-subagent` 不建议直接用于你的无人值守编码。**

这一个通过交互式 Claude Code 会话完成调度，确实很有意思。但我读了项目的插件 README，发现它目前让各类角色以 `--permission-mode bypassPermissions` 启动 Claude Code。

即使随后还有角色级工具限制，这种默认跳过权限确认的设计也不适合作为你的多 Worker 基础。它不是操作系统沙箱，不能只凭“审查角色”这个名称就保证只读。

**当前结论：市面上已经有人开发了 Claude Code 版的类似桥接器，但在这批项目里，我还没有发现一个同时具备 `pi-durateam` 的完整调度能力、成熟维护记录、细粒度权限和可靠恢复能力的现成项目。**

这不意味着 Claude Code 做不到，而是现有第三方封装还不够完整。

## 二、重新审查你之前的 5 个 ZCode 项目

我这次重点对照了 **MCP 工具是否真的注册、后端是否调用 ZCode 原生运行时、是否支持会话恢复和中途控制、是否需要额外适配，以及项目维护情况**。

| 项目                                                                               | 原生 ZCode Agent | Codex 直接通过 MCP 调用 | 接近 pi-durateam 的程度          |
| ---------------------------------------------------------------------------------- | ---------------- | ----------------------- | -------------------------------- |
| [coder-mcp-bridge](https://github.com/Deslord319/coder-mcp-bridge)                 |                  |                         | **功能接口很接近，兼容性待验证** |
| [zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge)                 |                  | 审查工具                | 不适合作为通用编码调度器         |
| [william0wang/zcode-acp](https://github.com/william0wang/zcode-acp)                |                  | 需要适配层              | **原生能力保留得较完整**         |
| [Liang-HZ/zcode-acp](https://github.com/Liang-HZ/zcode-acp)                        |                  | 需要适配层              | 可用作轻量协议参考               |
| [zcode-desktop-bridge](https://github.com/BaconWappedBitcoin/zcode-desktop-bridge) |                  |                         | 功能较全，但仅针对 Windows       |

### 1\. coder-mcp-bridge：并不是空壳，但我会下调它的推荐优先级

约 19 Stars · 9 Forks · 2026-08-15 最后推送

我读取了它的 `server.py`、`backend_manager.py` 和 `zcode_protocol.py`。

它确实有完整的 MCP `tools/list` 实现，并注册了 `agent-start`、`agent-wait`、`agent-observe`、`agent-control`、`agent-recover`、`agent-branch`、`agent-context`、`agent-close`。

它的 ZCode 后端也确实通过子进程启动 `zcode.cjs app-server`，并处理 ZCode 的反向请求，例如 `session/requestRuntimePreferences`。

这说明它不是“套一层提示词、直接调 GLM API”的伪 Harness。

但是：

- 它的 ZCode 能力依赖私有的 `app-server` 协议。
- 最后推送在 2026 年 8 月，而 ZCode 在后续月份继续修改了该协议。
- 它使用资源租约协调并发，但不会自动为每个任务创建、验收和合并 Git Worktree。
- 它提供的能力表不能代替最新 ZCode 版本上的实际兼容性测试。

尤其是官方 Z.ai 社区中仍有关于 ZCode 缺少正式 ACP 接口、私有协议变更和认证兼容问题的反馈。

**结论：它在“控制接口的丰富程度”上相当接近 pi-durateam；但从底层接口稳定性和维护活跃度看，我不能再把它无条件列为 ZCode 方案的第一推荐。**

### 2\. zcode-open-bridge：它的 MCP 不是通用编码 Worker

约 21 Stars · 1 Fork · 2026-10-20 最后推送

这个项目虽然同时拥有 MCP 和 ACP 两部分，但它的 MCP Server 主要提供 `zcode_review`、`zcode_security_review`、`zcode_pr_review` 等审查工具。

也就是说，它不是让 Codex 随便启动一个 ZCode Agent，然后持续 Steering、Follow-up、等待、恢复的完整调度器。

它的 ACP 部分支持更多原生会话能力，但需要 ACP 客户端或额外适配层。

**结论：非常适合当 GLM 的独立代码审查器，不适合直接替代 pi-durateam。** 其 README 还明确指出版本兼容性和部分宽松权限模式的风险。

### 3\. william0wang/zcode-acp：ZCode 侧技术基础最好，但不是现成 MCP 调度器

约 88 Stars · 32 Forks · 2026-11-15 仍有更新

这款的维护情况明显更好。

它真正驱动 ZCode 的 `app-server`，支持会话创建、恢复、Fork、流式工具事件、权限审批和原生 SubAgent 事件，还提供可选的 macOS Seatbelt 隔离。

仓库对 ZCode 0.16 之后移除、调整的协议方法也有专门的兼容代码和说明。

但它仍有明确限制：它是 **ACP Server**，通常一个 Adapter 进程对应一个活动会话。Codex CLI 的 MCP 配置不能直接把它当作 MCP Server 使用；要做到你期望的多 Worker 调度，还需要另外封装控制层。

它也不是完全没有风险。当前 README 中的某些启动模式仍较宽松，不能不检查权限配置就把它用于无人值守的代码修改。

**结论：如果你真要做一个 `zcode-durateam`，我更愿意参考这个项目的协议适配层，而不是从较老的 `coder-mcp-bridge` 直接继续开发。**

### 4\. 另外两款

`Liang-HZ/zcode-acp` 的主要价值在于轻量的 Python 协议实现，支持原生 ZCode 的 Session、Steering 和权限交互。但它只有很少的公开使用和维护信号，并且一个进程通常只有一个活动会话，不提供现成的 Codex MCP 多 Agent 调度层。

`BaconWappedBitcoin/zcode-desktop-bridge` 虽然提供原生 ZCode Session、异步调用、模型切换和丰富的 MCP 工具，但它明确针对 Windows 桌面 Harness，实现中还涉及较多桌面内部接口。对于你的 Mac，不建议拿它作为主线项目。

### ZCode 项目审查总结

从**功能设计**看，ZCode 完全有机会做到类似 pi-durateam 的任务管理能力。

但从**维护风险**看，它比 Claude Agent SDK 和 Pi SDK 都麻烦，因为第三方桥接器依赖 ZCode 尚未正式承诺稳定的内部协议。

这一点不是某个开源作者能力不足，而是上游提供的接口稳定性不同。

## 三、如果自己开发 `claude-durateam`，需要做什么？

我建议你**直接使用官方 TypeScript Claude Agent SDK**，而不是从某个只有几颗 Star 的 MCP 桥接器继续堆功能。

核心依赖是：

```bash
npm install @anthropic-ai/claude-agent-sdk \
  @modelcontextprotocol/sdk zod
```

需要明确两个容易混淆的包：

| 包名                             | 用途                                                           |
| -------------------------------- | -------------------------------------------------------------- |
| `@anthropic-ai/sdk`              | 直接调用 Anthropic Messages API，本身不是完整 Coding Harness   |
| `@anthropic-ai/claude-agent-sdk` | 运行真正的 Claude Code Agent，包含工具、会话、权限和上下文管理 |

官方文档：[TypeScript Agent SDK Reference](https://code.claude.com/docs/en/agent-sdk/typescript)。

### 你要的能力，官方到底提供了哪些接口？

| 你想实现的 MCP 工具 | 对应的 Claude 官方接口                              | 还需要自己开发什么                 |
| ------------------- | --------------------------------------------------- | ---------------------------------- |
| `spawn`             | `query()`                                           | Worker 注册、异步状态              |
| `spawn_batch`       | 多个独立 `query()`                                  | 并发调度、Worktree 分配            |
| `wait`              | SDK 事件流与结果消息                                | 事件等待、结果汇总                 |
| `status`            | SDK 消息和 Session 信息                             | 状态数据库、进度摘要               |
| `follow_up`         | `resume`、流式输入                                  | 追问队列和会话归属                 |
| `steer`             | 流式输入、`interrupt()`                             | **中途纠偏语义需要自行实现**       |
| `abort`             | `interrupt()`、`AbortController`                    | 进程退出与任务状态协调             |
| `forkFrom`          | `forkSession()`                                     | 分支关系与新任务预算               |
| `models`            | `supportedModels()`                                 | GLM 模型映射、可用性检查           |
| `resources`         | `settingSources`、`skills`、`plugins`、`mcpServers` | 按任务配置资源                     |
| `answer`            | `canUseTool`                                        | 请求队列、Codex/用户审批           |
| `durable`           | SDK 会话持久化                                      | 任务数据库、异常恢复、重复执行防护 |

这些接口都有官方依据，并非推测。特别是 `interrupt()`、`streamInput()`、`setModel()`、`mcpServerStatus()` 等，已经属于 SDK `Query` 对象的能力。

### 最关键的底层差别：Claude Agent SDK 会运行 Claude Code 子进程

Pi SDK 可以直接在同一个 Node.js 进程中创建多个 Agent Session。

Claude Agent SDK 的工作方式不同：**它把 Claude Code 可执行程序当作运行时，通过 SDK 控制这个子进程**。

所以：

- Pi 的优势是直接嵌入，便于管理多个 Session。
- Claude Code 的优势是官方已经提供完整的进程控制、流式输入、权限和会话接口。
- Claude Code 多 Worker 一般会产生多个独立进程，内存和启动开销需要实测。
- 进程分离也有好处：其中一个 Worker 异常退出，不一定拖垮其他 Worker。

从你的目标来看，这不构成架构障碍。

### 需要重点自行补足的是三件事

**第一，真正可靠的 Steering。**

Pi 的 `steer` 已经有明确的工具间纠偏行为。Claude SDK 支持流式输入、消息排队和中断，但不能把普通的“再发一条消息”直接等同于已经修改了当前执行中的任务。

我建议你为 `claude-durateam` 定义清楚：

- `send_message`：继续排队，不保证影响当前回合。
- `steer`：请求中断当前工作，保存状态，再按新指令继续。
- `abort`：明确停止当前任务，不自动重试。

尤其要避免一个 Agent 已经执行了文件修改或外部操作后，重新执行同一步骤造成重复副作用。官方流式输入文档也明确区分长期流式会话与普通单次调用的控制能力。

**第二，真正的 Durable。**

Claude Agent SDK 默认会保存 Session Transcript，但这不等于已经有 `pi-durateam` 那样的完整持久任务管理。

它能恢复模型对话历史，却不能自动保证进程崩溃前的每一次工具调用都被准确接管。

所以你仍然需要 SQLite 任务表、Worker 所有权、状态检查点、工具执行记录和重试保护。

特别是 `npm publish`、部署、数据库迁移、Git Push 等操作，恢复时必须先检查是否已经执行，不能盲目重放。

**第三，真正的安全边界。**

Claude SDK 提供的权限机制比普通 Pi 丰富，但仍然需要正确使用。

一个很容易写错的地方是：

`allowedTools` 表示这些工具可以自动通过审批，**不是“只允许使用这些工具”的严格白名单**。

要禁止工具，应配合 `disallowedTools`、权限规则和 `PreToolUse` Hook；要限制真实文件系统操作，仍然需要 macOS Seatbelt、Docker Sandbox 或其他操作系统级隔离。

---

## 四、GLM-5.3 能否完整继承官方 Claude Code 的 Skill、MCP、插件？

**可以使用官方资源加载机制，不需要为 GLM 单独重新实现这些功能。**

根据 Claude Agent SDK 文档，默认 `query()` 会读取用户和项目的设置。它能发现 Claude Code 的 Skills，加载本地插件，还能连接配置的 MCP Server。

例如，你现有的：

```text
~/.claude/
├── settings.json
├── skills/
├── plugins/
└── agents/

项目目录/
├── CLAUDE.md
└── .claude/
    ├── skills/
    └── settings.json
```

在 SDK 正确加载配置的前提下，都可以继续发挥作用。官方还允许通过 `skills` 参数控制每个 Worker 可以使用哪些 Skill。

不过，**你的 Codex 主进程和 GLM Worker 最好使用隔离的配置**。

因为如果你同时保留官方 Anthropic 登录和 Z.ai 的 `ANTHROPIC_BASE_URL` 配置，就必须防止 Worker 意外继承错误的模型路由或凭据。

我的建议是为 GLM Worker 使用单独的 `CLAUDE_CONFIG_DIR`，然后按需加载项目级 `CLAUDE.md`、Skills、MCP 和插件。这个配置变量是 Claude Code 官方支持的。

至于 GLM 本身是否能够完整发挥某些 Claude 专属的工具调用、思考、缓存或上下文功能，则取决于 Z.ai 兼容接口和模型行为，需要实际测试。**Harness 接口开放，不等于不同模型的工程表现完全相同。**

另外，SDK 的 `total_cost_usd` 是根据本地价格表计算的估值。对于 GLM-5.3 Coding Plan，不能直接拿它当真实账单或额度消耗，应该以 Z.ai 的用量记录为准。

---

## 五、什么样的 Harness 才适合被其他 Agent 调度？

这是整个问题的核心。

我认为，判断一个 Harness 是否适合做 `xxx-durateam`，最重要的并不是它是否支持 MCP Client，而是它有没有**稳定的入站控制接口**。

| 必要能力                       | Pi             | Claude Code           | ZCode                           |
| ------------------------------ | -------------- | --------------------- | ------------------------------- |
| 可编程启动完整 Agent Loop      | 官方 SDK       | 官方 Agent SDK        | 原生 app-server，接口稳定性不足 |
| 每任务指定工作目录、模型、工具 | 支持           | 支持                  | 支持，但依赖协议版本            |
| 结构化事件与最终结果           | 支持           | 支持                  | 支持，社区适配                  |
| Session ID 与恢复              | 支持           | 支持                  | 支持，社区适配                  |
| 运行中控制                     | 支持           | 支持输入/中断，需封装 | 受版本影响较大                  |
| 工具权限与审批                 | 主要由外部封装 | 官方权限、Hook、审批  | 有原生机制，需适配              |
| Skill / MCP / 插件复用         | 支持           | **官方支持**          | 依赖原生运行时与适配器          |
| 官方稳定 SDK 文档              | 有             | **有**                | 目前缺少同等级的入站 SDK        |

严格说，一个 Harness 不必同时具备以上全部能力才能被委派任务。最小可用版本只需要：

`启动一个任务 → 获取结构化结果 → 停止任务`

但你想做的是 `pi-durateam` 这种可长期使用的 **多 Agent 任务控制系统**，就必须进一步具备 Session、事件流、中途控制、权限、资源加载和恢复。

如果缺少这些接口，你仍可以用 CLI、进程和文件模拟部分能力，但代码量和维护难度会显著上升。

---

## 六、我建议你的最终技术路线

### 一个 Codex 主控，两个真正独立的 Worker Backend

**Codex · GPT-6.1**

统一调度 Skill · 任务拆分 · Worktree · 验收

**Pi Backend**

现成 pi-durateam

---

DeepSeek / Kimi / 其他 Pi Provider

**Claude Backend**

自研 claude-durateam

---

官方 Claude Code Harness + GLM-5.3

**统一质量门禁**

Git Diff · Typecheck · Tests · Build · GPT 增量审查

我建议按这个次序实施：

1. **先验证官方 Claude Code + GLM-5.3 + Agent SDK。** 检查真实模型路由、读写代码、工具调用、已有 Skill/MCP 和 Session Resume。
2. **开发最小版 `claude-durateam`。** 先实现 `spawn`、`spawn_batch`、`wait`、`status`、`follow_up`、`abort`，不要第一版就做复杂 Coordinator。
3. **再补充中途控制和 Durable。** 重点处理消息排队、进程重启、会话恢复、审批与任务副作用。
4. **最后接入现有 Worktree 和自动验收工作流。** 不必为 Claude Code 重新发明另一套 Git 管理脚本。

### 最后给你一个明确的判断

- **Pi**：嵌入式 SDK 很灵活，`pi-durateam` 已经解决大量调度工程问题。
- **Claude Code**：官方 Agent SDK 足够强，做出等价的 `claude-durateam` **完全可行**，而且在权限、资源加载和可观测性方面有很好的官方基础。
- **ZCode**：不是不能做，但目前依赖私有协议的部分更多，升级兼容成本和实现风险最大。

**如果我是为你的长期 Coding Agent 工作流选技术路线，我会优先继续使用 `pi-durateam`，同时开发一个基于官方 Claude Agent SDK 的 `claude-durateam`，不把 ZCode 的社区私有协议桥接器作为最重要的基础依赖。**

这样你既能让 Codex 指挥 DeepSeek/Kimi，也能让它直接指挥使用 GLM-5.3 的完整 Claude Code Harness，而且两条路径可以相互独立、交叉评测。

**来源:**

- [Agent SDK reference - TypeScript - Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Work with sessions - Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/sessions)
- [ACP (Agent Client Protocol) support for ZCode · Issue #286 · zai-org/feedback · GitHub](https://github.com/zai-org/feedback/issues/286)
- [&#91;Feature Request&#93; ZCode: Add Official ACP (Agent Client Protocol) Support for Third-Party Client Integration · Issue #571 · zai-org/feedback · GitHub](https://github.com/zai-org/feedback/issues/571)
- [GitHub - william0wang/zcode-acp: ACP adapter for ZCode — drive GLM-5.3 and GLM-5.3-Flash from IDEA, VS Code, Zed or any ACP client; pair with zcode-acp-remote for phone/web access · GitHub](https://github.com/william0wang/zcode-acp)
- [zcode-acp/README.md at main · william0wang/zcode-acp · GitHub](https://github.com/william0wang/zcode-acp/blob/main/README.md)
- [Configure permissions - Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Extend agents with skills - Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/skills)
- [Plugins in the SDK - Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/plugins)
