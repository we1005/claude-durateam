# Claude-Durateam Skill：初版、独立试用与修订记录

日期：2026-11-16。目标是让不具备作者会话上下文的 Codex 使用同一 MCP 完成新任务，验证交接与验收方式，再沉淀为个人可复用 Skill。本次没有使用 Pi 或 DeepSeek Worker。

## 已交付的 Skill

- 项目源文件：[SKILL.md](.agents/skills/claude-durateam-orchestrator/SKILL.md)。
- 操作示例和已知边界：[operations reference](.agents/skills/claude-durateam-orchestrator/references/claude-durateam-operations.md)。
- 需要明确授权的官方 MCP Client 连接助手：[mcp-client.mjs](.agents/skills/claude-durateam-orchestrator/scripts/mcp-client.mjs)。
- 已同步安装到 `~/.agents/skills/claude-durateam-orchestrator`。本机 `~/.agents/skills` 是链接，实际位置为 `/Users/YOU/.mirasim/skills`。

采用“先制作初版，再交给全新 Agent，依据实际失败修改”的顺序。初版快照及哈希保留在 `.artifacts/skill-discovery/initial-skill/` 与 `initial-skill-hashes.json`。最终版本不是重新开第三个冷启动 Agent 的盲测结果：两位原评估者在完成自己的初始试用后，获知文档修订并可检查新版。

Skill 把 Codex 的工作集中在契约、任务划分、会话复用、集成和验收。Worker 自主决定实现、调查和测试方案。Codex 先读简洁结果与失败证据，遇到具体阻塞才做局部诊断，不把通读所有 Worker 代码作为每轮固定流程。

## 新 Codex 会话的发现与接入

用户配置 `~/.codex/config.toml` 已新增 `claude_durateam`；原有其他 MCP 和其余顶层配置经解析比较保持一致。修改前备份保留在 `~/.codex/backups/claude-durateam-skill-20261116-153145/config.toml`。密钥继续由私有文件提供，本记录不包含密钥值。

新建 Codex app-server 的实测结果：

- `skills/list` 找到 `claude-durateam-orchestrator`，作用域 `user`，启用状态为真。
- `mcpServerStatus/list` 加载全部 13 个工具，无工具发现错误。
- 通过原生 `mcpServer/tool/call` 调用 `init`、`models` 成功；调度器可用，凭据状态为已配置。
- 当前个人注册容量为每连接 3 个并发 Worker。模型任务显式使用 `glm-5.3-flash` / `high`；桥接器自身的 `init.defaults.model` 仍为 `glm-5.3`，不应混淆。

证据在 `.artifacts/skill-discovery/app-server-discovery.json`、`installation-verification.json`。

另一次全新 `codex exec --ephemeral` 遇到现有独立 CLI 登录的 `401 Missing bearer/basic authentication`，未完成模型对话。因此，本次证明了新进程中的 Skill 发现和原生 MCP 初始化，没有证明模型会在任意新聊天中自动选择 Skill 并完成任务；没有更改 Codex 登录配置来掩盖这一限制。

显式使用示例：

```text
用 $claude-durateam-orchestrator 完成这个项目的任务。
使用 glm-5.3-flash / high，让 Worker 自主编码和测试，
按模块复用已有会话，完成后集成并运行约定检查。
```

自动选择保持启用，实际是否选中仍由请求和模型决定。已经运行的聊天若未刷新工具，需新建或重启对应会话。

## 两轮独立任务

两位 Codex 协调 Agent 均以 `fork_turns: none` 启动，只收到初版 Skill、全新任务、允许操作的范围和测试预算，没有继承作者会话、此前验证报告或业务参考实现。分别完成 SQLite 持久队列与版本化文档存储任务。全部业务实现和实现者自有测试由真实 GLM Worker 编写；第一轮协调 Agent 编写外置黑盒断言，第二轮由独立 GLM Worker 编写验收套件。协调者编写驱动、运行命令和集成，没有补写业务实现。

两个既有 SubAgent 的工具集都没有原生 Claude-Durateam 工具，因此按任务中明确允许的方式使用官方 MCP Client，连接生产 MCP。它们的真实模型执行证明 MCP/SDK 路径可用，但不能被写成原生 Codex 工具调用成功；原生发现证据来自上一节的新 app-server。

### 第一轮：持久化调度队列

工作目录：`.artifacts/skill-independent-round1/project/`。公开契约涵盖租户幂等、优先级与时间排序、租约与旧令牌 fencing、重试、事件事务回滚、真实多进程争抢与分页。

最终使用一个 Worker、同一 job/session 共 4 次 SDK 执行段，完成实现、返修及目标集成：

| 检查 | worktree 结果 | 集成后目标结果 | 退出码 |
| --- | --- | --- | --- |
| Worker 自有测试 `npm test` | 44/44 | 44/44 | 均为 0 |
| 外置独立验收 | 10/10 | 10/10 | 均为 0 |

相同测试在不同位置的复跑不累加为覆盖量。真实 Node 子进程 claim 测试带 IPC ready/start 屏障与 owned child 退出等待，避免只跑多个顺序进程就声称并发验证。

第一段实际返回 `succeeded/modelSucceeded=true`，但没有实现文件，测试退出 0 且执行测试数为 0。协调 Agent 拒绝验收，并复用原会话继续。随后保留了构造器 SQLite 索引错误、真实锁冲突处理、幂等快照及测试夹具失败的原始记录。

第一轮详细证据及阅读范围见 `.artifacts/skill-independent-round1/feedback.json`、`checks/`、`gates/`。

目标任务提交为 `defdcd95b83c48c80371a3464a10cda988b96095`，以 fast-forward 集成到目标分支，工作区干净，原 `TASK.md` 和 `package.json` 未改变。managed worktree、owned PID 及临时数据库目录均已清理。自建控制器在官方 `Client.close()` 后仍闲置，最后由协调 Agent 主动终止，退出码 1 单列在 `controller-exit.json`，没有被当作测试成功退出。最终观测到 3 个明确 `steer_ack`，另有未获 acknowledgement 的提醒，其仍需内容在后续 follow-up 中重述；compact MCP 调用仍无法直接查询这一送达状态。

### 第二轮：版本化文档存储

工作目录：`.artifacts/skill-independent-round2/project/`。公开契约涵盖 JSON 校验、深拷贝、TTL 边界、跨删除/过期的单调版本、CAS、原子批事务、历史回滚、真实多进程竞争与分页。

协调 Agent 使用一个实现 Worker 和一个独立测试 Worker，各自独立 worktree 与写入范围。最终目标目录的实际结果：

| 检查 | 结果 | 退出码 |
| --- | --- | --- |
| Worker 自有测试 `npm test` | 29/29 通过 | 0 |
| 独立契约 `node --test acceptance/store-contract.test.mjs` | 18/18 通过 | 0 |
| 独立验收中的真实多进程 CAS | 实际启动并通过 | 包含于独立契约 |

原先 6 次 SDK 执行段内没有全通过，原结论保留在 `evidence/six-segment-result.json`。经主协调 Agent 扩展预算，追加第 7、8 段短续接，分别修复原实现测试和独立测试的夹具；没有新建 Worker 或由 Codex 代写测试改成绿色。

原始失败包括：空产物却返回模型成功、源目录与 worktree 绝对路径混淆、JSON 快照原型差异、独立测试的 async 语法、时钟和 URL 夹具错误，以及按公开契约判定的历史条数预期错误。曾有一轮 CAS 因 URL 夹具错误而未启动子进程，不能把那一轮记作并发验收成功。最终修复后确实运行并通过，相关日志分别保留。

最终两组绿测日志为 `evidence/extension-worker-tests-pYhisg/` 与 `evidence/extension-independent-contract-CbVUmM/`。完整反馈、集成哈希和清理结果由 `.artifacts/skill-independent-round2/feedback.json` 及同目录证据记录。

目标任务仓库提交为 `c3357774ab57134dc7848b3f899c40c2d6032f5c`，工作区干净。两个 worktree 和临时分支均已删除；MCP 服务及控制器退出，审计状态保留。该轮自建控制器曾在 `client.close()` 后因 readline 仍持有输入句柄而未退出，最终显式 EOF 清理并记录；Skill 附带的新助手已显式关闭 readline。

## 实测引发的产品修复

### 每连接独立的持久实例

最初注册直接使用固定 runtime。新 app-server 与正在执行的试用连接争抢 SQLite 单 owner 锁，后启动连接无法调度。新增 [codex-mcp-launcher.mjs](scripts/codex-mcp-launcher.mjs)，为每条连接分配 `instances/<id>`，在 `init.connection` 暴露当前实例标识。显式指定旧实例仍保留活 owner 拒绝机制，旧 owner 退出后可恢复。

真实双连接测试验证了独立存储、活 owner 冲突拒绝及退出后恢复。并发上限按连接计算，多个聊天没有共享的全局并发上限。自动分配实例也不等于跨聊天自动找回历史任务。

### 合并高频思考通知

第一轮观察到 14,634 个事件中有 14,616 个 `system:thinking_tokens` 通知。此前每个通知都会写入 SQLite 并增加 revision，使 revision 增长看起来像任务推进。

Runner 现将这一类通知限制为每次执行中每 5 秒最多一条，不保留思考正文；工具事件、其他系统通知和终态结果继续保留。回归用 1,000 个通知验证事件数量有界、工具与结果不丢失、思考正文不进入事件。

这两轮运行中的桥接进程没有热更新，仍按各自启动时的代码执行。通知修复的证据来自新构建的离线回归，不能声称它已经改善了这两轮模型执行时间。模型空成功与 steer 时间接近，没有足够证据断言因果。

## 对 Skill 的实际修订

1. 明确运行目录映射：源项目 cwd 是 MCP 参数；Worker 在实际 worktree 中使用相对路径。
2. 明确命令执行能力：`edit` 不包含 Bash；由 Gate/协调者运行检查，或按需事先选择可执行命令的 profile。
3. 明确交付与集成：检查实际产物，包含新文件与删除，集成回目标后再跑适用检查。worktree 测试成功不等于目标已交付。
4. 验收检查真实退出码与实际测试数，区分模型结果、产物、测试、集成、清理。没有产物或零测试不算完成。
5. 返修先分类：实现、契约、测试夹具、环境。独立测试也可能错误，修订须由公开契约支持，不能为了实现而放宽断言。
6. 保留原会话续接与较高实现自由度。Codex 以具体失败证据、阶段目标和必要的局部帮助介入，避免每个新任务都重建 Worker 或通读所有代码。
7. 为明确允许的官方 MCP Client 连接方式提供脚本，保持注册环境一致，并使用管道防止终端截断长 JSON。
8. 不把高频思考通知当作交付进度；不把 queued steer 当作已送达，终态后仍需的指令写进下一次 follow-up。

连接助手已实测初始化、模型目录、100 KB 单行请求、无效 JSON 拒绝、禁用注册时拒绝启动；这些检查没有调用模型。它不替代原生工具发现。新修订版保留语法验证与用户/项目副本一致性校验。

## 回归结果与未解决边界

`npm run verify` 退出 0：类型检查、27 个测试文件中的 190 项测试、13 工具 MCP 握手均通过。日志：`.artifacts/skill-discovery/checks/20261116T074812-b0bbf48e361f.log`。Skill 官方校验脚本通过。

仍应明确保留的边界：

- 新独立 CLI 模型会话受现有 401 登录问题阻断；原生发现/初始化与真实 GLM 任务分别有证据，尚未在一次全新 CLI 模型对话中串联完成。
- 当前 `status(verbose: true)` 没有安全事件摘要输出，compact snapshot 也未暴露可查询的 steer 送达回执。Skill 已避免依赖不存在的可观测能力，产品仍可补充相应接口。
- 高努力模型可以长时间思考而不保存文件；本轮通过具体交付目标及原会话续接恢复，不能据此保证所有新任务都顺利完成。
- 本轮未验证费用收益，SDK 估算不能代替供应商账单。

这是一套经过两类真实后端任务试用并据实修订的初版模式，后续应在不同项目中继续验证，不应称为“完美”或“最佳”。
