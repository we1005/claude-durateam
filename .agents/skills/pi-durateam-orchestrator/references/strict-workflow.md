# 可选：脚本管理的严格模式

适合需要已冻结验收、文件范围门禁和多分支集成的复杂批次。目标项目需先安装 v2 模板的 `.agent-orch` 脚本和示例；只有本 Skill 时仍可使用普通委派模式，无需伪造缺失脚本。

1. 原始仓库中检查并提交选定的模板内容，执行 `bash .agent-orch/scripts/worktrees.sh init <feature>`。
2. 在脚本输出的 integration 工作区定义 `.agent-orch/tasks/<TASK>.json` 与 `.agent-orch/integration-checks.json`，填真实 checks 和合理的路径/规模范围，并提交。任务检查应只验证，不自动修复源码。
3. 从原始仓库运行 `worktrees.sh add <feature> <TASK>`，使用实际输出的绝对目录派发。任务卡可通过 attachments 提供，项目说明与 `.agent-orch/worker.md` 通过 resources.contextFiles 提供。
4. 确认 Worker 停止写入后运行 checkpoint。它先提交有变化的候选，再运行检查；失败后保留候选和修改，不自动回滚。干净候选可以重复 checkpoint；检查若产生修改，审查后重新 checkpoint。
5. 核对实际改动范围并按风险定向查看关键 diff，不默认通读全部实现；按依赖顺序 merge 到 integration。每次 merge 会复验任务，所有批次合入后运行一次 verify 验证组合行为。检查后 HEAD、分支或可见工作区发生变化都应失败，不能把自动修复前的提交当成已通过。
6. 清理已合入且干净的 Worker 使用 remove。主分支集成、提交和推送按本轮用户授权处理。

脚本默认保护编排配置、密钥、依赖清单等路径；需要这些修改时由主管单独处理或调整流程，普通自主模式不受这套门禁前置条件限制。路径门禁属于事后检查，无法隔离进程。检查产生的构建缓存应按项目约定忽略；不得用忽略规则掩盖需要交付的文件。
