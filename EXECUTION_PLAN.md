# Claude-Durateam 实施与流程观察

## 本次目标与资料修订（2026-11-16）

已阅读四份原始 Markdown。以 CLAUDE_DURATEAM_IMPLEMENTATION_PLAN.md 的功能契约为起点，按用户最新要求接入**火山引擎 Coding Plan**，不是旧资料的 Z.ai。默认模型 glm-5.3，glm-5.3-flash 单独验证；Anthropic 兼容 base URL 为 `https://ark.cn-beijing.volces.com/api/coding`。原始讨论保留，不将历史建议当作实测结论。

Codex 主 Agent 使用现有 pi-durateam-orchestrator Skill 直接调度 Pi/DeepSeek，自主实现、自测与返修，主 Agent 负责契约、协调、集成和按证据验收。相关增量优先续接原会话；仅在明确风险处定向阅读源码。不开额外 GPT 监督层。

现有四份文档不改写，现有主力 Codex/Claude/Pi 登录、设置及 MCP 不改动；开发本地项目与示例接入配置，不自动发布或推送。凭据只允许从已提供的本机文件在运行时读取，不输出、不复制进仓库或日志，不传 CLI 参数。live 验证会消耗火山引擎额度，仅运行小型受限任务。

## 阶段和门槛

1. **P0：真实接口和依赖基线。** 精确锁定依赖；隔离 Claude 配置；doctor、官方 SDK/CLI 小型 Read 工具链、错误/缺失凭据测试、MCP 最小握手。至少 GLM 5.3 SDK 工具链成功才进入依赖它的主线；真实失败保留脱敏证据，必要时独立 CLI 原型，不能用 FakeRunner 冒充兼容。模型 Flash 是否可用分别报告。
2. **P1：可用调度。** 冻结内部 TypeScript 契约；按 SDK/权限、调度状态、工作区/状态存储、MCP/验收的文件责任拆分。非阻塞 spawn、原子 batch、并发队列、事件 wait、status/sessions、精确 UUID resume、abort。写入使用独立 Git worktree。
3. **P2：控制和资源。** 使用当前 SDK 实际支持的流式输入/steer/fork；审批必须对应真实请求；按任务 Skill/MCP catalog；沙箱不可用拒绝启动。queued 不等于 delivered，未验证能力明确标记。
4. **P3：持久化和工程验收。** SQLite ownership、崩溃恢复标 unknown_outcome 而不盲重放；worktree 生命周期、受保护路径门禁；常规离线测试不请求模型，显式 live 命令另列；最终真实 MCP client E2E、续接、取消、双 Worker、错误及资源隔离检查。

每个大模块成形后做定向测试，集成后统一 typecheck/test/build/E2E。新增测试执行器需真实负对照；每次验收保存唯一日志和真实退出码。最终区分模型完成、门禁通过、未验证能力；费用对照按此前要求暂缓。

## 当前基线与分工

- 本机 Node v26.13.0、npm 11.20.0、Claude CLI 2.1.322、Codex CLI 0.167.0。
- Registry 实测 Agent SDK 0.3.325、MCP Server 2.4.0；以 lockfile 与安装类型为最终依据。
- P0 由首个 Pi Worker 在当前新仓库完成，单一写入者；后续在已提交基线上准备隔离工作区再派发，先明确共享类型和模块所有权。
- Pi 专属环境 `/Users/YOU/pi-durateam-config`，返回默认 DeepSeek V4.1 Flash，当前 max，并发容量 5。Claude-Durateam 产品本身先默认并发 2、可配到 3，区别于开发侧 Pi 容量。

## Skill 观察记录

本节只记真实问题和可复用改进，不将每个业务 Bug 固化为通用限制。关注契约同步、相关上下文续接、开发自主性、测试完整性、主 Agent 阅读范围及调度开销。当前尚未有本项目运行结论。

### P0 实际结果及后续分工

基线提交 `1cbdee8`。真实 SDK 的 GLM 5.3 与 Flash 均完成随机文件 Read→tool_result→正确答案，SDK bundled Claude Code 运行时报告2.1.325，本机CLI为2.1.322。缺失/格式错误凭据本地拒绝，错误token被端点拒绝且无账号回退；最小MCP client握手通过；Root另执行typecheck/build和16项自测通过。`skills:[]`仍在init列出内置Skill，只读工具集中没有Skill工具；只能报告观察，不能宣称资源加载白名单已证明。

CLI探针读取成功且CLI本身exit0，但init工具列表过宽，验收exit1；保留原红色结果，交原作者修正。doctor没有配置key时返回未配置，不把该次诊断称live失败。真实请求证据保留在`.artifacts/`，凭据不进入仓库。

共享接口v1为 `src/task-contracts.ts`，由主Agent维护。后续职责：原SDK会话实现engines/mcp/main/scripts及依赖/README；调度Worker只写scheduler与相关测试；工作区Worker只写workspace/state及对应测试。后两者真实worktree分别为项目同级的claude-durateam-scheduler与claude-durateam-workspace。独立QA worktree及原会话保留，组合接口可运行后再续接验收，不反复重建理解。实际工作区基线/接口SHA/LSP配置核对记录为`.artifacts/workspace-preflight.json`。

初步观察：在P0尚无可运行代码时提前派独立QA，仅产出验收计划、实际测试0项，带来了额外模型开销。保留该上下文供后续实际验收，下一阶段避免让QA空等或重复规划；不是增加编码限制。

### 实现期的真实返修与验证

- 原SDK实现漏传 `options.resume/forkSession`，却把会话ID变化归为SDK限制。Root仅定向读取调用参数与探针第二轮，交原作者修复；原探针可从磁盘取回答案，不足证明记忆。`1862877`修后真实普通resume同UUID、fork新UUID，后续输入不含随机答案、零工具调用。首红日志保留，错误归因已撤回。
- 新job/new cwd跨任务fork又实际失败（找不到父transcript）；原作者`5cb7642`补专属会话家族存储，真实跨任务fork与子任务续接通过且父transcript哈希不变。该实现涉及锁定SDK内部文件布局；后续布局变更须按当前候选重跑，不能沿用旧绿色结果。
- 调度与工作区首次任务拆分过大：前者只有错误类型，后者有源码但只有旧16项测试通过。没有记成完成，沿原会话改为先保存/运行基础路径再补边界。现已交付真实模块和针对性测试。
- `maxConcurrent`原实现取消后立即释放slot，真实runner若迟退出会越限。新增忽略abort的受控Runner首红后修复：必须等run Promise settle才归还slot。
- 原StateStore的save/appendEvent分离无法单TX。契约v1.1新增可选 `commit(snapshot,event)`；生产SQLite实现单TX、Scheduler接入。真实事件INSERT trigger失败时任务状态/revision/event一起回滚，撤销trigger后同一transition成功。旧fake存储仅兼容回退，不称原子持久化。
- Root主目录组合测试已实际运行到131/131（日志`.artifacts/root-checks/20261116T054141-2436e8d9a37a.log`）。此为该检查点结果；后续代码改变需要最终候选复验，不预先计作最终验收。
- 真实Bash沙箱已阻止工作区外写与私有canary读取，但认证环境变量存在性探针仍为PRESENT。只输出布尔、不打印秘密；当前交原作者加固，尚不称权限工程完成。steer有真实queued/SDK ack/最终指令证据，辅助transcript断言曾因格式假设失败，保留红件待当前脚本复验。

Skill只增加两条窄提醒：可运行候选后再启动常规独立验收；验证会话续接要核对真实SDK参数并排除答案从磁盘重取。既有“早期可运行增量”条款不重复堆叠，本次问题属于交接执行未落实。模板、原项目及本项目副本同步，官方quick_validate通过；未安装个人级Skill或修改客户端配置。

## 最终交付与验收（2026-11-16）

已交付可运行的本地stdio MCP服务：13个工具（含gate），官方Claude Agent SDK驱动真实Claude Code Worker，火山引擎GLM 5.3默认、Flash可选；默认2并发、可配1–3。支持原子batch预检、队列/事件wait、精确UUID续接与跨任务fork、真实steer确认、审批绑定、按任务Skill/MCP、独立Git worktree、SQLite所有权/原子状态事件/恢复unknown_outcome、外部门禁。不自动重放未知副作用、不自动push或合并main。

| 验证层 | 实际结果与范围 |
| --- | --- |
| 最终全量离线 | 21文件、156/156，包含build；另typecheck通过。日志 `.artifacts/root-checks/20261116T061112-37517954cdfb.log`。常规测试不调模型。 |
| 干净安装 | 独立干净检出先npm ci（2.584秒，exit0），155项通过；补日志修复/测试范围配置后同检出更新并156项通过，日志 `061219-017b4409e139`。依赖lockfile未改变。 |
| 真实生产MCP | 功能候选 `1d47adf61aa003fa6ca6d25446b34b89cd28f259`、入口SHA256 `1bf328836b673eb5632532a1813acff15f99cf1d491474bc0f5e2d12d35de38b`。A/B两个GLM5.3在独立worktree自主写入，无普通编辑审批；C排队取消，session=null/工具0；A续接同SID、无提示答案且工具0；D真实init后取消；E新job/worktree/SID继承记忆，工具0。五段SDK运行，exit0，26个进程采样、峰值2个Worker。 |
| 生命周期与资源 | 受测bridge及全部已知子PID退出，未全局pkill；本次小任务采样子进程峰值RSS 525104kB、bridge峰值130048kB，不能当大型项目压测或全机内存。 |
| 资源与沙箱 | 选定Skill、精确授权MCP echo、自主Edit与越界拒绝真实通过；steer真实queued→SDK ack→最终响应通过；沙箱内写/外写拒绝/密钥文件读拒绝与不可用failclosed通过。Bash只拿临时代理令牌，真实凭据留bridge；代理令牌仍可调用该受限代理消耗额度，非多租户安全承诺。 |

原始生产live汇总在 `.artifacts/qa-live/20261116060241-live-1d47adf-b112/summary.json`。首次live底层gate日志随tmp被删，这是明确证据缺口，不把后续产物伪装成原件。最后执行器修复将gate日志保存在runDir/tmp外，追加安全RPC元数据；新增真实MCP门禁0→9→0的零模型检查证明清理后日志仍在，原生156项中的新增1项覆盖它。Root首次本地复验还纠正了测试自身对sessions响应形状的假设，并发现Vitest重复发现`.artifacts/clean-install`的旧155项；现在明确`test/**/*.test.ts`，避免311项假性计数，首次失败日志保留。Skill的既有测试发现提醒仅补“排除验证/归档副本”一句。

开发后段账号5小时额度返回429（AccountQuotaExceeded），返回重置时间16:45:04北京时间。已停止新增模型请求，保留原QA错误状态与未完成改动。主Agent只接续完成该测试执行器与验证基础设施（不是业务实现），并运行本地确定性检查；156项及真实五段模型行为均有对应证据。未更换提供商、追加新Agent或静默改为昂贵模型。该账号窗口可能包含其他使用，本项目未独立归算账单。

实际使用4个保留Pi会话、20个执行段，开发侧峰值4并发，SDK/调度/工作区/独立QA均复用相关会话。主Agent维护共享契约，围绕漏传resume、跨任务home、生命周期和测试证据做定向判断，未通读全部业务模块或代写业务实现。早期独立QA过早、模块拆分过粗、部分测试假设过强均实际发生；本轮改进落在交接和证据，不增加逐步编码限制。

最终交付说明：源码位于本仓库，README含安装/配置/资源catalog，Codex接入示例位于examples。未改主力Codex/Claude/Pi配置或登录，未自动注册/发布新服务。SDK transcript跨cwd复制依赖锁定0.3.325/2.1.325内部布局，已实测中文cwd，升级须复验；未证明其他平台、长期负载、所有路径/攻击或费用收益。详细机读结果见 `VALIDATION_REPORT.json` 及 `.artifacts/`。
