# 配置与运行参考

[← 返回项目首页](../README.md)

以下命令均从仓库根目录执行。本文保留完整配置、工具契约、权限边界、
诊断方式和历史验证限制；首次接入请先看首页的快速开始。

## 安装与构建

```bash
npm ci
npm run build && npm run typecheck && npm test
npm run doctor        # 只读诊断，不联网、不显示密钥
```

依赖精确锁定：`@anthropic-ai/claude-agent-sdk@0.3.325`、
`@modelcontextprotocol/server@2.4.0`、`zod@4.6.7`（见 `package-lock.json`）。
Node.js 要求 **>=22.19**（`node:sqlite` 基线；早期 22.0 不支持）。

## 配置

凭据只在运行时从本机文件读取，路径经环境变量传入；值不进入仓库、日志、argv 或 MCP 响应。

```bash
export CLAUDE_DURATEAM_KEY_FILE=/absolute/path/to/api-key.txt   # 纯 token 或 ANTHROPIC_AUTH_TOKEN=...
export CLAUDE_DURATEAM_MAX_CONCURRENT=5                         # 1..32，默认 5
export CLAUDE_DURATEAM_ALLOWED_ROOTS=/absolute/repo              # 逗号分隔
export CLAUDE_DURATEAM_RUNTIME=/absolute/state-dir              # 默认 ~/.local/share/claude-durateam
export CLAUDE_DURATEAM_WORKTREE_ROOT=/absolute/sibling-dir       # 可选；默认位于批准源目录的父目录下
export CLAUDE_DURATEAM_RESOURCE_CATALOG=/absolute/resource-catalog.json  # 可选，默认 <runtime>/config/resource-catalog.json
```

未指定密钥路径时，读取 `~/.config/claude-durateam/credentials/volcengine.key`；不再读取某台机器的历史资料目录。
建议该文件权限为0600。默认worktree位于源仓库之外的 `.claude-durateam-worktrees/<scope-hash>`，
状态目录不再写入程序安装目录；已有外置路径配置可继续使用。

每个 job 使用持久隔离 HOME：`<runtime>/jobs/<jobId>/home`，配置路径位于该 HOME 内，
其中 `projects` 符号链接指向桥接器专属会话库。会话 transcript 存放在
**桥接器专属共享 config root** `<runtime>/claude-config`（不读取任何主力用户配置）：
这样新 job（新 jobId + 新 cwd/worktree）在 fork/resume 时能定位父会话。执行 resume/fork
前，桥接器会把父 transcript 复制（不移动）到目标 cwd 的 project 目录，父会话保持不变。
用户/项目/本地设置仍一律不加载（`settingSources: []` + `strictMcpConfig: true`）。

MCP 注册示例见 `examples/codex-config.example.toml`（不含密钥，不覆盖现有配置）：

```toml
[mcp_servers.claude_durateam]
command = "/opt/homebrew/bin/node"
args = ["/ABSOLUTE/PATH/claude-durateam/scripts/codex-mcp-launcher.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 120

[mcp_servers.claude_durateam.env]
CLAUDE_DURATEAM_KEY_FILE = "/Users/YOU/private/api-key.txt"
CLAUDE_DURATEAM_MAX_CONCURRENT = "5"
```

Codex 接入使用 `scripts/codex-mcp-launcher.mjs`：每条连接独立分配
`<runtime>/instances/<id>`，避免两个新聊天竞争同一个SQLite ownership锁。
同连接内继续复用Worker；新聊天不会自动接管旧聊天的任务。`init.connection`返回实例标识，
需要恢复时在原owner退出后显式设置`CLAUDE_DURATEAM_INSTANCE=<id>`；活owner仍拒绝接管。
并发上限以实例为单位，多个聊天或显式打开的多个实例不会共享这一上限。
`dist/main.js`仍是直接MCP入口，适合已经自行分配独立runtime的宿主。

本项目另附Codex主管Skill：`.agents/skills/claude-durateam-orchestrator/SKILL.md`。
个人安装目录为`~/.agents/skills/claude-durateam-orchestrator`，用于其他项目的新会话发现。
可在新聊天中输入`$claude-durateam-orchestrator`显式使用；自动选择依据Skill描述，不能保证每次隐式命中。
只安装Skill不等于启用MCP，两者需要分别配置。已经运行的聊天若工具列表未刷新，需新建/重启相应会话。

例如：`用 $claude-durateam-orchestrator 实现这个项目的任务；使用 glm-5.3-flash / high，
由 Worker 自主编码，按模块复用会话，完成后集成并运行约定检查。`
新会话接入及两次独立任务的实测边界见 `SKILL_VALIDATION.md`。
与本机 Pi-Durateam 的逐项对照、已确认差距及改进优先级见 `PI_DURATEAM_COMPARISON.md`。

## MCP 工具

`init`、`models`、`spawn`、`spawn_batch`、`wait`、`status`、`sessions`、`follow_up`、
`abort`、`steer`、`fork`、`answer`，可选 `gate`；Codex launcher 另启用 `handoff`。批次示例见 `examples/batch.example.json`。

- `spawn` 非阻塞；`wait` 有界（≤30s），超时 ≠ 任务失败。
- 所有返回 JobSnapshot 的工具（spawn/spawn_batch/wait/status/sessions/follow_up/abort/fork）统一输出
  紧凑快照，不回显完整 prompt 或长正文。
- `follow_up`/`fork` 使用精确 session UUID（`resume`/`forkSession`），不用 `continue:true`。
- `spawn`/`spawn_batch` 可传 `effort`，默认 `high`，会保存到任务并传入 SDK；续接/Fork保持该值。
- 显式预算范围为1–100轮、时限最长6小时；保持原默认轮次，SDK不再静默压低请求值。
  `follow_up` 可以单独更新 `maxTurns`、`deadlineMs`，不借此改变模型、权限或工作目录。
- `steer` 返回 `queued`；只有观察到 SDK echo 后才发 `steer_ack`（`delivered`），
  否则保持 `queued`/`unsupported`。
- `answer` 只解析真实 `canUseTool` 回调产生的 requestId；无人值守默认 **deny**。
- 调度/工作区/状态模块缺失时工具仍列出，但调用返回结构化 `scheduler_unavailable`，
  不伪装成功。

## 权限与 Profile

| profile | 可用工具 | 写入/执行 |
|---|---|---|
| `read` | Read/Glob/Grep | 无；`permissionMode: dontAsk` |
| `edit` | + Edit/Write/NotebookEdit | 必须非空 `allowedPaths`；范围内自主写入，越界直接拒绝 |
| `sandboxed-bash` | + Bash | 命令走审批回调，OS sandbox 不可用直接拒绝 |
| `coding`（默认） | + Bash | 默认无 OS 沙箱；acceptEdits + 预批准 Bash，自主执行命令、测试及返修 |

- 默认禁用 Task/原生子代理、WebFetch/WebSearch、Skill 等；不使用 `bypassPermissions`。
- PreToolUse 钩子做真实路径/符号链接校验：必须位于 worktree，写入必须位于 `allowedPaths`；
  `.git`、`.env*`、凭据类文件禁止写入。
- `allowedPaths` 限定文件工具写入；Bash 以本机用户权限执行，可访问工作树以外的路径；使用任务约定和 Gate 检查最终改动归属。Agent 可读取仓库普通接口和测试。
- 取消/超时虽然可立即显示终态，但旧Runner未退出时仍占并发槽，且不能对同会话续接/Fork。
- `allowedSkillNames` 按**名称**从 operator 的 resource catalog 选择：
  ```json
  { "skills": { "alpha": { "dir": "/absolute/path/to/skill-alpha" } } }
  ```
  桥接器仅为本次运行复制**所选技能目录**生成最小 plugin bundle（无 hooks/commands/MCP，
  `skipMcpDiscovery: true`），`plugins` + `skills` 只加载/启用所选技能；`Skill` 工具仅在
  非空选择时启用，并由 PreToolUse 按精确名称放行。伪造/未批准名称在 query 前拒绝。
  CLI 仍可能列出内置 skill 元数据；这不等于已卸载，调用内置/未选 skill 会被钩子拒绝。
  技能内容不能升级工具权限：仍受 profile、`allowedPaths` 与 PreToolUse 约束。
- `enabledMcpServers` 只能来自预批准 catalog（`<configDir>/config/mcp-catalog.json`，
  `command` 必须绝对路径），否则拒绝。选择 server 只会把它注入 Worker；**只有 entry 的
  `tools: ["echo"]` 才精确授权 `mcp__<server>__<echo>`**，未列出的 tool 与未选择的 server 一律拒绝。
  外部 MCP 副作用**不受 Bash 沙箱保护**。

## 自主执行、资源和跨窗口延续

`coding` 按用户要求关闭 OS 沙箱，使用 acceptEdits 和预批准 Bash；没有启用 bypassPermissions 或官方 classifier auto。
它可以自行运行开发命令、测试及返修。`sandboxed-bash` 保留为显式选择的沙箱模式，
可用 `CLAUDE_DURATEAM_NETWORK_DOMAINS` 配置其开发域名。普通 coding 不受这份沙箱网络名单限制。
`edit` 保留给有意由主管执行命令的任务。工作树与隔离 HOME 是组织手段，不是 host Bash 的 OS 权限边界。

`status.progress` 返回最近 5 个工具及成功/失败、轮次、文件写入收据、活动时间、空答警示与 steer 回执。
Shell 的写入不等于文件工具收据；以工作树/Gate 为准。`reportPath` 指向私有最终答复文件。

写任务 `fork` 复制父工作树当前普通文件状态（含未提交修改、新文件和删除），并记录 `task.forkBase`。
忽略文件、凭据、Git 元数据不复制；父任务应停止写入。新工作树仍需按约定集成。

launcher 为所有实例保留同一个 `CLAUDE_DURATEAM_CONFIG_DIR`（默认基础 runtime）：
`config/resource-catalog.json` 和 `config/mcp-catalog.json` 首次创建空目录文件，已有内容保留。
可用 `CLAUDE_DURATEAM_RESOURCE_CATALOG` / `CLAUDE_DURATEAM_MCP_CATALOG` 指定文件。

```json
{"action":"save","cwd":"/absolute/project","jobId":"CDT-00001","goal":"module","completed":"implemented","next":"add increment"}
```

上例交给 `handoff`；新窗口用 `handoff(action:read,cwd:...)` 读取，随后把返回的 `instanceId` 与
`jobId` 一起传给 `follow_up`。后续 status/wait/steer 也带该 instanceId。
`sessions(includeStored:true,cwd:...)` 可只读发现其他实例任务；续接时拒绝活 owner，旧连接须先退出。
工作树和原 SDK 会话需保留，不能先删除再期待完整续接。异常中断仍需检查 `unknown_outcome`，不盲目重放。

## 错误与费用

Runner 错误前缀：`credential:<code>`、`sandbox_unavailable`、`unsupported_capability:<detail>`、
`mcp_server_not_preapproved:<name>`、`aborted`、`timed_out`、`result:<subtype>`。
缺密钥/错误密钥均不回退到 Anthropic 订阅登录。

`usage.sdkCostEstimateUsd` 是 SDK 本地估算；`providerBilledCostUsd` 恒为 `null`（不对账），
不得当作 Coding Plan 账单。

## 测试

```bash
npm run typecheck     # tsc --noEmit
npm test              # 离线：env/redaction/SDK fake/runner/MCP 工具契约
npm run mcp:handshake # 真实 stdio 子进程 handshake（无需密钥）
npm run doctor
```

显式 live（消耗 Coding Plan 额度，默认不随 CI 运行）：

```bash
npm run test:live:sdk      -- --model glm-5.3        # 只读 Read 链
npm run test:live:sdk      -- --model glm-5.3-flash
npm run test:live:cli      -- --model glm-5.3        # 受限工具集的 CLI 链
npm run test:live:edit                               # 同 job：受控 Edit + 记忆-only resume + fork（3 次调用）
npm run test:live:crossjob                           # 跨 job：新 jobId+新 cwd fork，再同 SID follow_up（3 次调用）
npm run test:live:steer                              # 真实 running 中注入 steer；queued 与 SDK ack 分开（1 次）
npm run test:live:sandbox                            # sandboxed-bash：内写成功/外写拒绝/私有 canary 读拒绝 + fail-closed（1 次）
npm run test:live:skill-mcp                          # 所选 Skill + MCP echo + 自主 edit + 越界拒绝（1 次）
npm run test:live:negative -- --case missing|malformed|wrong-token
npm run test:live:all                                # 上面全部，逐项保存退出码
```

通过生产 MCP 验证指定模型与思考程度（显式消耗额度，默认测试不运行它）：

```bash
npm run build
node dist/scripts/acceptance-live-mcp.js --execute \
  --authorized-by your-local-test --candidate-sha "$(git rev-parse HEAD)" \
  --model glm-5.3-flash --effort high
```

该验证保存逐命令日志、安全RPC元数据与请求档位元数据；不会保存请求正文或认证头。
如设置 `CLAUDE_DURATEAM_WIRE_AUDIT=/absolute/private/metadata.jsonl`，普通任务也可选择同类观测。
观测使用本机凭据注入代理；记录模型、effort、thinking类型、固定端点类别和解析状态，
超出观测容量时明确标 `overflow`，不把未知档位误记为已验证。

每次 live 在 `.artifacts/<时间戳>-<类型>-<模型>-<pid>/` 下保存 `run.log`、`result.json`、
`exit-code.txt`；密钥泄漏有硬失败闸门。

> 计数口径：历史工件中的 `networkCallsMade` 实为 **SDK/CLI run 启动次数**（每次 query +1），
> 不是底层 HTTP 请求数；一条工具链会包含多轮模型 HTTP 调用。新代码已改名为
> `sdkRunsStarted` / `cliRunsStarted`，历史工件保持原字段不改。

## 已知限制

- 当前验证平台为 macOS Apple Silicon、Node 26.13.0。Linux、其他 Node 版本及长期压力负载未实测。
- 首次生产 live 的功能结果通过，但临时目录清理同时删掉了底层 gate 命令日志；原始汇总保留，
  不能重建成首次完整日志。执行器已修复，新增零模型生产 MCP 验证再次执行门禁 0/9/0，
  确认临时目录删除后日志仍存在；`node dist/scripts/acceptance-live-mcp.js --dry-run` 可复验。
- 开发末段出现账户 `AccountQuotaExceeded`，当次返回重置时间为 2026-11-16 16:45:04 +08:00。
  这是历史服务可用性记录，不是程序的永久限制；默认测试和 dry-run 无需模型额度。

- `skills: []` 不会隐藏内置 skill 列表（init 仍会列出）；**默认未选 Skill 时** read/edit profile 没有 Skill 工具，只有显式选择后才启用并受精确名字钩子约束；
  不要把该选项当作加载白名单。
- 端点对 `glm-5.3*` 会打印 `unrecognized_model` 提示，但路由与工具调用成功，按兼容告警处理。
- `allowedTools` 只是免审批规则，不是安全白名单；安全边界是 tools/disallowedTools/钩子/沙箱。
- MCP 工具的副作用不受 Bash 沙箱保护；第三方 MCP 需要单独授权后才可加入 catalog。
- resume/fork 已实测：精确 UUID resume 返回**同一 session_id**，`forkSession: true` 返回**新 session_id**；
  探针第二轮不携带 marker、且事件证明**零工具调用**，仅凭会话记忆答对 marker。升级 SDK 后需重跑 live 探针。
- 跨 job fork 已实测（新 jobId + **中文新 cwd**，当前 per-job HOME + `projects` symlink 布局）：
  复用父 session 得到新 SID 并保留上下文，随后在同 job 用该 SID follow_up 仍返回同一 SID；
  父 transcript 字节未变，fork/follow 均零工具调用。共享 projects 是桥接器会话家族存储，
  不包含用户设置；Home 仍按 job 隔离。
- **版本耦合（非官方稳定 API）**：跨 job transcript 复制依赖锁定 SDK/CLI（0.3.325 / 2.1.325）的
  磁盘布局 `<config>/projects/<cwd-key>/<session>.jsonl` 与 `[^A-Za-z0-9] -> '-'` 的 ASCII cwd 映射。
  该布局不是 SDK 公开契约；升级 SDK 必须重跑 `test:live:crossjob`。中文 cwd 已在 live 跨 job 探针中
  验证通过；其他非 ASCII 字符、空格/组合 Unicode 路径仍**未验证**，不要泛化宣称。
- 资源目录均为 operator-owned；本段 live 用临时 skill fixture 与无副作用 MCP echo fixture 验证：
  所选 Skill 可真实调用、MCP echo 返回独立 nonce、scope 内 Edit/Write 无审批、scope 外写被拒
  （工件 `.artifacts/20261116-135437-live-skill-mcp-edit-*`）。MCP catalog 仅放行 entry `tools`
  中的精确 tool 名。
- sandboxed-bash 只有在真实沙箱内执行且“工作区外写/私有 canary 读”被拒时才可用；
  强制 unavailable 时会 fail-closed（拒绝启动，绝不宿主执行）。Bash 走真实审批回调 + OS 沙箱，
  不走 Read/Write 的文件路径 PreToolUse 分支。live 已验证：Node 执行/工作区内写成功、工作区外写被拒、
  私有 canary 读被拒、canary 未变；5 次 Bash 均产生真实审批请求。
- **Bash 凭据隔离**：sandboxed-bash 的 Claude Code/Bash 环境不再包含真实凭据。CLI 只拿到
  `cdt-proxy-*` 一次性 dummy token 与 `http://127.0.0.1:<port>`；桥接器内的 loopback proxy
  在转发时注入真实 `Authorization`，响应原样流回，真实 token 不写日志/不进子进程 env。
  sandbox 的 `denyRead` 覆盖共享 config、jobs、操作者 HOME 与 key 文件所在目录；探针以
  `TOKEN_CLASS:PROXY_DUMMY`、`BASE_URL_CLASS:LOOPBACK`、`KEYFILE_READ_DENIED` 与真实 token
  全工件扫描作为证据。残余风险：Bash 可拿 dummy 经 proxy 消耗额度，但读不到真实凭证；
  不宣称外部 MCP 受 Bash 沙箱保护。
- steer 已实测通过（`.artifacts/20261116-134733-live-steer-*`）：running 中注入随机码，receipt=`queued`，
  SDK echo 触发 `steer_ack`，最终答复含随机码；`delivered` 从未在无 ack 时宣称。SDK transcript 把 steer
  存为 `queue-operation`，读取器已兼容并有单测。首次红件（maxTurns 截断）保留。
- 历史归因撤回：先前把“resume 后 SID 变化”写成 SDK 兼容局限，实际是桥接早期漏传 `resume` 选项
  （首红证据 `e1b9f3b` 保留）；修复后不再存在该现象。
