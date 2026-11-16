# Pi-Durateam 与 Claude-Durateam 对照及差距

审查日期：2026-11-16。此文保留 0.3.0 基线评估；0.4.0 对已确认差距的修复见 [改进记录](WORKFLOW_04_VALIDATION.md)。

本机基线：Pi-Durateam **0.7.12**、Pi SDK **1.5.0**；Claude-Durateam **0.3.0**，审查代码提交 `46fc8f390668c54a2b2756cee148cd3a86e627c3`。

本次读取了本机已安装 Pi 包的 README、reference 和关键实现，以及 Claude-Durateam 的接口、调度器、workspace、Runner、资源目录实现；通过两个 MCP 的原生 `init` 和 Pi `models` 核验当前配置。没有启动新模型任务，也没有修改执行行为或权限。只读诊断摘要保留于 `.artifacts/pi-comparison/readonly-snapshot.json`。

## 结论与定位修正

两者属于相同类型：主 Agent 经 MCP 派发有独立上下文的编码 Worker，支持并行、续接、分叉及中途指令。但当前 Claude-Durateam 的产品能力覆盖明显不完整，不能视为 Pi-Durateam 的等价替代。

Claude-Durateam 已打通 Claude Agent SDK / GLM 的基础委派路径，并增加了自动工作树、文件编辑范围和 Gate；其自主执行体验、交付观测、跨窗口连续工作、资源复用及恢复便利性仍有明显差距。此前“类似”的表述应限定到基础调度模式，不能扩展为功能完整性或成熟程度已经相当。

还有一个关键事实：本机 Pi-Durateam 的 `models(filter="glm")` 已列出 `glm-5.3`、`glm-5.3-flash` 和 `glm-latest`。因此 Claude-Durateam 的独特探索价值是 **Claude Agent SDK 的执行循环与工具生态**；仅能调用 GLM 并不构成相对于 Pi 的新增能力。本次未对两套执行循环做同模型、同任务对照，不能判断谁的编码质量或效率更高。

## 逐项对照

| 维度 | Pi-Durateam 0.7.12 | 当前 Claude-Durateam | 判断 |
| --- | --- | --- | --- |
| 基础委派 | spawn、batch、wait、status、steer、answer、abort | 对应基础接口均存在 | 目标相近，参数和状态语义并不兼容 |
| 同会话续接 | follow_up；保留历史，可更新轮次/工具调用预算 | exact UUID follow_up；可更新轮次/时长预算 | 核心能力已实现 |
| 历史分叉 | forkFrom；可覆盖 cwd、model、tools、thinking 等 | 独立 fork 工具；继承原模型、权限和资源选择，接口只接受新 prompt | Claude 的分叉配置自由度更低 |
| 本机并发 | 当前 5；batch 当前也允许 5，环境配置可调 | 当前 3；主入口和调度校验都硬限制最多 3 | 真实缺口；只把环境变量改成 5 不会生效 |
| Worker 自主编码和测试 | 授予 edit/write/bash 后，可自己运行命令与修复 | edit 无 Bash；sandboxed-bash 可执行命令，但采用真实审批回调，未启用沙箱内自动放行 | Claude 当前常用模式增加主 Agent 执行负担 |
| Git 工作目录 | 使用传入 cwd；MCP 本身不自动创建工作树 | 写任务自动建独立 worktree，且要求源仓库干净 | Claude 有内建隔离优势，也带来交接与集成成本 |
| 父任务代码延续 | fork 默认继承 cwd；文件就是所选 cwd 当前内容 | fork 从 sourceCwd 重新准备工作树；不自动携带父 Worker 未集成的文件改动 | 对话延续与代码版本延续未对齐 |
| 任务进展观测 | phase、idleMs、turns、最近工具调用；verbose 含完整工具轨迹；有 touchedFiles/editWriteCount | revision、时长、工具计数、短文本；verbose 仍是相同摘要 | Claude 较弱，容易迫使主 Agent 做额外调查 |
| 作答与收尾 | answerState、salvagedText、预算接近上限提醒、最后一轮收尾；可选软时限 | SDK result.success 映射 succeeded；没有同等空答分类和完整收尾机制 | 测试曾出现空产物成功，Skill 拦住了，但 MCP 仍需改进 |
| 工具调用预算 | maxToolCalls；可跟随 follow_up 更新 | 当前只有轮次和时长，工具调用计数仅观察 | 缺少独立的工具调用预算 |
| 长任务恢复 | durable:true 时检查点恢复；处理未知工具结果；周期查找可恢复任务 | 状态与 SDK 会话落盘；异常在途任务标记 unknown_outcome，需检查并显式续接 | 都有持久化，自动恢复能力不同 |
| 跨窗口继续 | durable 会话目录索引、sessions stored、handoff save/read | 每连接独立实例；需知道旧 instance，并在旧 owner 退出后显式选择 | Claude 尚缺用户可直接使用的交接与发现接口 |
| 生命周期管理 | memory/durable 可选、retentionDays、存储上限、forget | 当前默认持久状态；没有对应的用户级保留/清理/forget 接口 | 长期使用便利性有差距 |
| 模型与故障切换 | 多 provider，模型目录及过滤；可选 provider 错误后的 fallback | GLM-5.3 / Flash 两个白名单模型；没有桥接层跨模型 fallback | 固定 GLM 可是有意范围，不能宣称模型能力等价 |
| 扩展生态 | 可选择加载 Pi 环境中的 extension，并授予 AST/LSP 等工具 | 不能直接运行 Pi extension；只暴露声明的 SDK 工具与预登记 Skill/MCP | Pi 的已有扩展资产没有被自然复用 |
| Skill/上下文 | resources 显式选择 Skill 和 contextFiles；默认不自动加载所有本机 Skill 或 AGENTS | 按 operator catalog 名称选择 Skill；settingSources:[]，隔离 HOME，不自动继承日常 Claude 设置 | 都需要资源选择；Claude 的共享配置尚未接好 |
| MCP 资源 | nativeMcp + 明确服务器/工具；不依赖第三方 extension 开关 | enabledMcpServers + 预登记 catalog / exact tool allowlist | 两者可选资源；当前安装不能当作已复制本机全部 MCP |
| 子协调层 | 产品可选 coordinator，能派发、等待、追问及汇总成员 | 无同等 coordinator；SDK 原生 Task/Agent 也被当前封装禁用 | Claude 目前需要 Codex 持有更多调度职责 |
| 材料输入与报告输出 | attachments、saveTo/saveDir、报告索引 | 无同等首层参数，主要返回短文本并依赖任务自己写文件 | Claude 的低上下文交付机制不够完整 |
| 权限与验收 | 明确说明不是 OS 沙箱；工具名单不能约束已授予 Bash 的全部行为 | 文件工具路径 hook、Bash OS 沙箱、独立 worktree、Gate | Claude 增加了有价值的控制，但仍需区分不同工具的边界 |

## 与用户目标关系最大的差距

### 1. 自主完成编码—测试—返修的常规路径不足

用户期望主 Codex 规划并派发，Worker 在约定模块里自由实现和测试，主 Codex 只在必要时干预。

最近两轮复杂后端验收选择的是 edit profile：Worker 能写实现和测试，实际测试命令全部由 Codex 协调 Agent 或 Gate 执行，然后再反馈失败。两轮通过证明了委派和返修路径能工作，没有证明 Worker 已能自主完成同样复杂的命令执行闭环。

根因包含封装选择：`EDIT_TOOLS` 不含 Bash；sandbox 配置设 `autoAllowBashIfSandboxed:false`；Bash 不在预批准工具集合中。不能把这些选择解释为 Claude Agent SDK 天生不支持自主执行命令。

官方 SDK 文档明确支持通过工具、权限模式和回调决定哪些操作自动运行：
[Agent loop / permissions](https://code.claude.com/docs/en/agent-sdk/agent-loop)、[Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)。本次也通过 Context7 解析并读取了对应官方文档。

建议优先提供适合日常开发的自主 coding 模式：在约定工作树内让 Worker 完成已授权的开发命令、测试及返修，把越界或无法判断的请求交回主 Agent。保留项目和模块归属，不规定每一步实现。Skill 的更新需跟随真实执行能力，不能用提示词承诺尚未实现的自主性。

#### 补充：这里与 Claude Code 的 auto 模式有何区别

`profile:"edit"` 是本项目定义的工具组合，不是 Claude Code 官方权限模式。它不给 Worker 提供 Bash。当前 Runner 对该组合显式设置 `permissionMode:"dontAsk"`，对 sandboxed-bash 则设置 `permissionMode:"default"`，并没有使用 `permissionMode:"auto"`。日常交互式 Claude Code 的模式不会自动覆盖这些明确的 SDK 选项。

三层配置应分开：工具组合决定 Worker 拿到什么工具；permissionMode 决定工具调用如何批准；sandbox 约束命令可访问的环境。即使把 permissionMode 单独改为 auto，一个仍未提供 Bash 的 edit Worker 也不能执行测试。

本机安装的 SDK 类型支持 `permissionMode:"auto"`。该官方模式会使用分类模型审核部分动作，带有 provider/model 可用性要求；目前没有验证火山 GLM-5.3-Flash 这一连接的实际兼容情况，不能因 SDK 接受该枚举值就宣称已经可用。

让 Worker 自主测试，也可以通过工作树沙箱与已授权命令的自动批准实现。官方将 Bash 沙箱的 auto-allow 与 permissionMode auto 作为可独立配置的机制，不能混称。参考：[permission modes](https://code.claude.com/docs/en/permission-modes#eliminate-permission-prompts-with-auto-mode)、[SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)。本次只核对文档与类型，没有启用 auto 或发起兼容性模型测试。

### 2. 连续任务中的文件状态与历史状态不一致

`Scheduler.fork` 使用 `source.task.sourceCwd` 建立新工作树，随后 fork 原 Claude 会话。父 Worker 可能已在自己的工作树写出一套尚未集成的代码；子 Worker 继承了这段对话，却不会自动得到那些文件。即使父 Worker 在自己的分支提交，原 sourceCwd 仍不一定已更新到那个版本。

这是由源码确认的工作目录选择行为，本次没有另发真实模型任务验证该场景。此前 cross-job fork 的会话记忆验收不能扩展为“父任务代码快照也已完整继承”。需要明确 fork 的代码基线、变更快照及路径映射，再补充实际编码续接验证。

此外，新写任务要求源 checkout 干净。已有项目中正在编辑的内容不会自动进入新 worktree，新增任务时会遇到准备基线和集成的额外步骤。可考虑让调用方选择已有工作树或受管新工作树，而非把自动新建作为所有写任务唯一模式。

### 3. 诊断需要更多主 Agent 上下文

Pi 的摘要可直接观察轮次、phase、最近工具和文件修改收据。Claude 的摘要只告诉调用方工具调用总数，无法在常规 MCP 接口里直接区分长期思考、反复失败、实际写文件、未确认 steer 等情况；verbose 没有提供额外轨迹。

这会增加 Codex 追问、读取实现或手工分析运行记录的动机，与“主 Agent 不通读大量代码”目标有冲突。应增加紧凑、按需读取的结构化诊断：最近工具名与结果状态、修改文件收据、有效进展时间、空答案/空交付信号、可查询的 steer 回执及文件报告索引。文件收据只是操作证据，不能替代 diff 和测试。

### 4. 稳定配置与跨窗口复用没有完整连接

新的 launcher 通过每连接独立实例避免了数据库 owner 冲突，但新连接不会自动发现旧实例任务。手工设置 `CLAUDE_DURATEAM_INSTANCE` 后恢复指定旧实例，与 Pi 的 handoff/sessions stored 体验有明显距离。

资源也存在类似问题：当前 Runner 默认在实例 runtime 的 `config/` 下寻找 `resource-catalog.json` 和 `mcp-catalog.json`。本次检查基础 runtime 和当前连接，这两个文件都不存在；个人 MCP 注册也未设置共享 resource catalog。代码支持按名称选择资源，不等于这份安装已配置好用户的日常 Skill/MCP。每实例状态隔离与稳定的 operator 共享资源目录应分别设计。

需注意 Pi 也不是无条件继承所有资源：当前 Pi 委派默认不自动加载所有 Skill/AGENTS；MCP 要显式选服务器与工具；extension 要显式开启。Pi 的可选 coordinator 还需要授权 codemode，而当前本机工具名单未包含它。表中的“产品支持”不能全部解释为当前配置已启用。

### 5. 默认模型、并发与配置的自由度不一致

本机 Pi 当前并发和 batch 均为 5；Claude 当前并发 3，源码有两处上限：`src/main.ts` 的 clamp 和 `src/scheduler/validation.ts` 的上限校验。单改环境变量不能放宽到 5。

Claude Skill 要求显式使用 Flash/high，但桥接器省略 model 时仍默认 `glm-5.3`。应统一日常默认选择，并让并发、队列、资源位置等运行策略集中配置。两者的并发均按服务器进程/连接计算，不是本机所有窗口共享的全局上限。

## Claude 当前值得保留的能力

- 自动建立独立工作树、记录任务归属，降低多个 Worker 直接改同一目录的冲突机会。
- scoped Edit/Write 的路径检查，以及 Bash 的 OS 沙箱集成。
- 独立 Gate 验证 Git 改动范围与真实命令退出码，集成验收不用只依赖模型自报。
- 精确 session UUID 续接、任务状态持久化、批量入队前验证、取消后等待 Runner 真正退出才释放容量。

边界不能混淆：当前 Bash 沙箱允许写工作树 cwd，`allowedPaths` 并不等同于对每条 shell 写入都做精确文件限制；Gate 是事后检查改动范围。外部 MCP 的副作用也不天然受这些文件 hook 限制。保留这些机制有价值，但不能把“控制更多”直接等同于“更符合用户需要”或“全面更安全”。

## 建议的后续优先级

| 优先级 | 工作 | 验收目标 |
| --- | --- | --- |
| P0 | 自主 coding/测试闭环，保留高自由度 | 一个复杂任务由 Worker 自行执行测试并返修，主 Codex 只读摘要和必要失败证据 |
| P0 | 紧凑诊断、文件交付收据和报告索引 | 不读业务源码，也能判断是否有产物、是否卡住、失败位于哪一层 |
| P1 | 工作树和 fork 的代码版本连续性 | 父 Worker 未集成的实现能按明确定义进入子任务；历史与文件一致 |
| P1 | 并发与默认模型集中配置，支持至少 5 | 配置 5 后真实 5 Worker 并发；省略 model 的日常选择与 Skill 一致 |
| P1 | 稳定资源目录、实例索引及 handoff | 新会话能查到原任务，判断可续接状态；资源选择跨连接稳定 |
| P1 | 空答识别、收尾、工具预算及保留策略 | 不把空结果当交付；不需主 Agent 为每种超时自行补控制逻辑 |
| P2 | 可选 coordinator、更多模型和生态集成 | 由实际项目需求驱动，不为追齐接口数量扩大范围 |

目标应是：主 Agent 做规划与必要干预，Worker 在清楚的项目边界内有充分执行权，同一模块自然续接，主 Agent 用少量证据完成验收。以此衡量当前差距，比按工具名字或测试项数判断“差不多”更有意义。

## 证据索引

Claude-Durateam：

- `src/mcp/tools.ts`：完整 MCP 参数、模型默认值、摘要与 verbose 行为。
- `src/main.ts`、`src/scheduler/validation.ts`：并发上限。
- `src/engines/agent-runner.ts`：工具 profile、审批、设置来源与资源目录。
- `src/engines/resource-catalog.ts`：Skill 名称选择及目录解析。
- `src/scheduler/scheduler.ts`：fork 源目录、终态映射及恢复。
- `src/workspace/git-workspace.ts`：受管工作树、基线要求。
- `SKILL_VALIDATION.md`：两轮后端试用的真实执行方式与失败记录。

本机 Pi-Durateam 安装：

- `/opt/homebrew/lib/node_modules/pi-durateam/docs/reference.md`：功能及配置契约。
- `dist/config.js`：实际环境配置实现。
- `dist/pi/resources.js`、`dist/pi/runtime.js`：资源显式选择与模型配置加载。
- `dist/workspace.js`：cwd 解析，未内建自动 worktree 管理。
- `dist/coordinator.js`：可选子协调层。

本次并未验证费用收益、跨平台可靠性或同模型下两套执行循环的质量差异；没有依据这些材料给出整体性能排名。
