# 0.4.0 Workflow 改进与验证

日期：2026-11-16。承接 `PI_DURATEAM_COMPARISON.md` 的 0.3.0 差距审查。本次没有把功能名称相似或自测数量当作与 Pi 完全等价的证明。

## 范围与派工

改动横跨执行器、任务状态、持久化、工作树和 MCP 入口，属于中等规模的联动修改。由主 Codex 统一维护接口和集成；仅将可独立交付的实例目录/交接笔记模块交给 **一个** Pi Worker。没有增加第二层 Codex 协调者或默认派满并发。

Pi Worker 使用本机专属配置的 DeepSeek V4.1 Flash / max，独立工作树，自主编码、自测。负责 `src/instances/catalog.ts` 与 `test/instance-catalog.test.ts`，11 项测试和 typecheck 实际退出 0。主进程机械集成后，另加路由与 MCP 协议验收。Worker 原始交付摘要另保留在 `.artifacts/implementation/pi-delivery.json`。

Pi 调度 Skill 已增加“先判断是否值得委派”：按独立交付量、耦合、上下文和交接开销选择主会话、旧 Worker、单 Worker 或并行。没有把项目后期固定解释为不使用 Worker。更新同步到 Codex-Pi-workflow 的项目版和 v2 副本。

## 最终行为

| 领域 | 0.4.0 行为 |
| --- | --- |
| 日常 coding | 默认无 OS 沙箱，`acceptEdits` + 预批准 Bash，可自行执行命令、测试、返修；未启用 bypassPermissions 或 classifier auto |
| 可选限制 | `read`、`edit` 保留；`sandboxed-bash` 显式选择 OS 沙箱及审批回调 |
| 默认模型 | GLM-5.3-Flash / high，与调度 Skill 对齐 |
| 并发 | 默认 5，可配置 1..32；按实例计算，不是所有窗口共享的本机总上限 |
| 简洁证据 | 轮次、最近 5 个工具及状态、活动时间、文件工具修改收据、空答警示、最近 steer 回执 |
| 答复输出 | 私有最终答复文件及 reportPath；常规快照不导出 API 原文、推理正文或完整工具输出 |
| fork 文件 | 父工作树的普通 tracked/untracked 文件状态、未提交修改、删除进入独立子树；忽略文件、秘密路径和 Git 内部文件排除 |
| fork 来源 | task.forkBase 记录父 cwd 与 HEAD；文件快照复制中检查变化，父子写入互不影响 |
| 稳定资源 | configDir 独立于每次连接实例；首次生成空 Skill/MCP catalog，保留已有内容，可指定目录/文件 |
| 跨窗口 | sessions(includeStored:true) 只读发现；handoff save/read 提供实例/任务交接；工具显式带 instanceId，服务按需打开闲置旧实例 |
| 所有权 | 活 owner 始终拒绝接管；旧连接退出后可续接原 UUID；异常中断仍检查 unknown_outcome，不自动重放未知结果 |

用户在实施中明确要求不使用沙箱，因此最终 coding 模式按该偏好实现。较早的沙箱实验是保留的失败/中止证据，不是最终默认行为。SDK 官方的 permissionMode 与 sandbox 独立：TUI 的本机 Bash 沙箱默认关闭，`--dangerously-skip-permissions` 不会自动打开沙箱；auto 与 acceptEdits 也不要求沙箱。

官方依据：[Bash sandbox](https://code.claude.com/docs/en/sandboxing)、[permission modes](https://code.claude.com/docs/en/permission-modes)。本次通过 Context7 和官方网页核对；没有声称火山 GLM 的 classifier auto 模式已经验证。

无沙箱意味着 Bash 以本机用户权限执行，可以访问工作树之外；隔离 HOME、文件工具 hook、allowedPaths 和 Gate 都不是其 OS 级访问边界。保留这些组织和验收机制，同时避免把它们描述成沙箱。

## 已完成的确定性验证

- 实际调度五个并发 Runner，第六个排队，释放槽位后推进。
- 工具成功/失败、文件收据、空答案警示和 steer 确认进入摘要，并可经 SQLite 重新加载。
- 返回快照不能反向修改内部 progress 数组。
- fork 包含已提交、未提交、新增和删除文件；父子独立，原 source 不变，秘密/忽略文件不带入。
- 跨实例只读发现不夺取 owner；活 owner 拒绝接管，退出后精确 UUID 续接。
- 两个独立真实 MCP 客户端验证 handoff、stored 发现、显式 instanceId 状态读取和所有权拒绝/恢复。
- 两个连接共用稳定配置目录；实例状态彼此独立，初始资源 catalog 不覆盖已有文件。
- 目录模块的 corrupt/foreign metadata、路径/符号链接逃逸、cwd/name 隔离、原子替换及私有模式检查。

最终 `npm run verify` 退出 0：31 个测试文件、206 项测试全部通过，typecheck 和原有 13 工具的直接入口握手通过。日志为 `.artifacts/implementation/checks/20261116T114303-3b4b5776f5e9.log`。Codex launcher 另外启用 handoff，工具数为 14；新 app-server 已实际加载版本 0.4.0、5 并发及 codingSandboxEnabled:false，用户级 Skill 发现正常。

## 真实 GLM 自主执行实验

采用之前文档存储项目的独立克隆，故意把 TTL 截止判断改错，先证明测试实际非零退出，再交给 GLM-5.3-Flash / high。模型只能交付 source 的约定变更，自行运行项目与独立验收；最后 Gate 使用不经管道的命令独立复跑，并检查改动范围。

保留的过程证据：

1. 初始沙箱运行在 npm registry 访问上进入审批，未通过。
2. 后续运行碰到 SDK 对复合命令的审批；没有用主进程逐条批准来伪装自主完成。
3. 用户明确选择无沙箱后，停止了仍在进行的沙箱实验，保留 owned PID 中止记录。
4. 无沙箱复用原会话后，模型自行跑出项目测试 29/29；独立并发测试暴露了原探针的竞态：较慢的 contender 在另一个已更新版本后还坚持等 version 1，误报 SEED_TIMEOUT。
5. 协调者只修复验证夹具的等待条件为“观察到版本至少 1”，仍真实执行 expectedVersion=1 CAS，仍要求一胜一真实 CONFLICT，没有改弱并发断言。此项改动只在实验克隆中提交，不修改产品来迁就探针。
6. Node 26 的默认测试输出使用 `ℹ tests/pass/fail`，实验记录器最初只解析 `# tests`。解析器现同时支持两种格式，并检查 fail=0；原日志保留。

最终自主执行通过，证据位于 `.artifacts/implementation/live/20261116114302/summary.json`：

| 项目 | 真实结果 |
| --- | --- |
| Worker 模型 | glm-5.3-flash / high |
| 运行方式 | coding，无 OS 沙箱，审批请求 0 |
| Worker 实际 Bash 测试 | npm test 29/29；独立契约 18/18；从自己会话的工具结果聚合核验 |
| 主进程独立 Gate | 两组原始命令退出 0，改动仅 src/store.mjs，无遗留调试文件 |
| 模型终态 | succeeded，modelSucceeded:true，lastError:null |
| 主验证会话 | f3b36493-4672-4e88-8a19-6de1c001e4fc |
| 旧实例 | 20261116112109-7627ff9e-42f；跨多个新 MCP 连接实际续接原 UUID |

主验证会话共 6 个执行段，另有 1 个初始独立沙箱探针，总计 7 段；中间的取消、中止、失败均保留，不能算成 7 次成功测试。修正夹具后又抓到原后端样例构造器初始化的 SQLite 锁竞争（CHILD_CRASH / database is locked），实际业务修复交回原 GLM 会话，没有改变 MCP 来掩盖业务错误。独立 Gate 全绿后仍有一段模型终态为 failed，最终补充短续接才取得成功终态，不能仅以测试绿替代模型状态判断。

最终对真实双进程 CAS 又独立复跑 5 轮，全部退出 0，每轮 1 个有效测试、fail 0，源码哈希保持一致，见 `.artifacts/implementation/cas-final.json`。相同用例的复跑不累加为新覆盖量。实验克隆工作树、原 SDK 会话和失败日志保留供继续调查/续接；未把初期审批、中止或纯主进程自测算作 Worker 自主验收通过。

## 配置与使用

个人 Codex 的 claude_durateam 并发环境已改为 5，其余配置经 TOML 解析比较保持一致。修改前备份：`~/.codex/backups/claude-durateam-04-20261116-193130/config.toml`。旧 MCP 连接不热更新；重新连接或新会话加载新版本。

普通派发省略 profile 即使用 coding；也可显式传 `profile:"coding"`。保存交接时提供 cwd、jobId、简洁 goal/completed/next；新窗口先 handoff read，再用返回的 instanceId 与 jobId follow_up。工作树和原 SDK 会话应保留到不再需要后续任务时。新建写任务仍要求源 Git 基线干净。

新增项目 `AGENTS.md`：保留 Context7 文档要求；内置 Web Search 不可用或无有效结果时，使用 Subscription Powers 的 Codex / Dot Web Search 或路由工具，读取原始依据，不用记忆替代搜索。本轮内置 Web Search 可正常读取官方页面，因此没有虚构一次 fallback 调用。

尚未实施的 Pi 功能包括可选子 coordinator、跨模型故障切换、完善的保留/清理策略及自动重放式恢复；这些不在本批四项改进范围内。
