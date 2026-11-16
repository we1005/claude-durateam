# 交给 Codex 的执行指令

请阅读同目录的 `CLAUDE_DURATEAM_IMPLEMENTATION_PLAN.md`，将它作为本次工程任务的技术规范和验收契约。目标是在 macOS Apple Silicon 上从零实现可由 Codex 通过 MCP 调用、以 Claude Agent SDK 驱动真实 Claude Code Worker、使用 Z.ai GLM-5.3/GLM-5.3-Flash 的 `claude-durateam`。

**请直接按方案动手实现，不要只给架构建议。** 先做 Phase 0 的依赖与真实接口验证，再按 Phase 1 → Phase 2 → Phase 3 实现。每个阶段持续完成一大块后统一测试、修复；最终统一做端到端验收。不要在每几行修改后跑测试。每个大阶段最多新增 3 个 Markdown 文档，保持中文自然易懂，行动前用一句话说明即将进行的工作。

优先级：官方 SDK 与 MCP v2、GLM 官方模型路由、权限和会话隔离；其次任务队列、并发、续接、Steering；最后 SQLite durable、Worktree 和质量门禁。尽可能使用已存在的成熟库及官方 API；不要自行重写 Claude Agent Loop、MCP/ACP 协议栈。阅读文档内的官方资料 URL 并根据实际安装 SDK 的 TypeScript 声明确认代码。**V1 不需要 ACP。**

**硬性安全约束**：不可修改用户现有 Codex Pro/Claude/Pi 登录凭据；不可覆盖已有 `~/.codex/config.toml` 或 `~/.claude/settings.json`；不可在项目内、MCP 参数或日志中保存 API Key；不可默认使用 `bypassPermissions`、无沙箱 Bash、自动 push/merge main；未经用户实际批准的外部副作用不得执行。所有会访问 Z.ai 额度的 live 测试必须清楚标识并使用受限任务。

测试与结果：首次必须证明 `Claude Agent SDK + GLM` 真实完成工具调用。若兼容性失败，停止依赖该接口的后续实现，提供具体阻断证据并尝试独立 CLI Adapter 原型；不可假造成功。每个阶段提交可运行代码与测试，最后给出准确测试结果、已完成/未完成能力、实际 SDK/CLI 版本和 commit。对工具/模型尚未验证的能力，必须标记为未知或未通过。

开始时先检查 Node/npm/Claude CLI/Codex/SDK/MCP 版本，以及工作目录权限；不要重复询问已给出的任务目标。若本机没有 Z.ai Key，不要索取明文密钥到聊天窗口：完成离线测试，给出最小本机密钥注入步骤并清楚标明 live 验证尚未完成。
