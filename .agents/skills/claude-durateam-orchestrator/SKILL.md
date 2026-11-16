---
name: claude-durateam-orchestrator
description: Use Codex to delegate coding, investigation, testing, and repair work to claude-durateam workers running Claude Agent SDK on Volcengine GLM models. Apply when a task should be executed by the local Claude-Durateam MCP with isolated worktrees, session reuse, scoped writes, and evidence-based acceptance.
metadata:
  short-description: Dispatch and verify Claude-Durateam GLM workers from Codex
---

# Claude-Durateam orchestration

Use this skill to run work through the `claude_durateam` MCP server. The MCP is a local stdio bridge: Codex calls MCP tools, the bridge calls the official Claude Agent SDK, and the Worker routes through the Volcengine Anthropic-compatible Coding Plan endpoint. Do not replace this workflow with a direct API call, a direct `claude` CLI invocation, or a Pi/DeepSeek delegate.

Codex owns planning, shared contracts, integration, and acceptance. Workers own implementation and choose their design, investigation, and testing approach within the agreed scope. Give them useful context and broad module ownership; do not prescribe each coding step. Read compact results and failure evidence first. Inspect a small relevant code slice when it resolves a concrete blocker; escalate repeated failures with hypotheses or focused diagnosis rather than routinely rereading every Worker's code or taking over implementation.

## First check

At the start of a new Codex session:

1. Inspect the available MCP tools. The configured server is normally named `claude_durateam`; tool names usually appear as `mcp__claude_durateam__init`, `mcp__claude_durateam__spawn`, and so on.
2. Call `init` before model work. Confirm scheduler availability, the Volcengine base URL, allowed models, credential presence only, concurrency, and the current default effort. Never request or print the credential value.
3. If tools are missing, check registration and restart/new-session discovery before dispatch. A task may explicitly authorize the official MCP Client stdio fallback; it must use the registered command, arguments, and full nonsecret environment configuration. Keep credential values in the private key file. Report fallback use, since it does not prove native tool discovery. If `scheduler.available` is false, resolve the entrypoint/ownership error before model work; do not override a live lock or silently switch providers.
4. Prefer `glm-5.3-flash` with `effort: high` for ordinary coding and testing. Use `glm-5.3` only when the task needs the stronger model and the user has authorized the extra quota. Always pass the model and effort explicitly for a measured experiment.

The supported task fields are `cwd`, `prompt`, `model`, `effort`, `profile`, `maxTurns`, `deadlineMs`, `allowedPaths`, `allowedSkillNames`, and `enabledMcpServers`. The bridge validates model, effort, paths, and budgets before starting a Worker.

Codex's launcher gives each connection an independent durable instance. Use `sessions(includeStored:true,cwd:...)` to discover other instances, and `handoff` save/read to preserve a concise project note. Continue an old job by passing its returned `instanceId` and `jobId` to `follow_up`; use that instanceId on status/wait/steer too. The server opens an idle old instance on demand and rejects a live owner. Stop the former connection before resuming it elsewhere. Manual `CLAUDE_DURATEAM_INSTANCE` selection remains available. Capacity defaults to five per instance; read `init` for actual limits.

## Task handoff

Give the Worker a concrete outcome, relevant paths, ownership, and a real completion check. Do not send the whole Codex conversation. Include:

- the absolute source project `cwd` as a tool parameter; tell the Worker to work in its actual runtime cwd and use relative project paths, since edit work runs in a separate worktree;
- the required behavior and acceptance criteria;
- the files or directories the Worker owns;
- the command or independent check that will verify the change;
- the model and effort (`glm-5.3-flash` + `high` by default);
- a request to save useful progress early and report actual checks and limitations.

Use `profile: "coding"` (the default) for autonomous implementation and tests. Per the operator's preference it runs Bash on the host without an OS sandbox, using acceptEdits and pre-approved Bash, not bypassPermissions or the classifier auto mode. Give broad module ownership and let the Worker investigate, run tests and repair itself. Isolated cwd/HOME and file-tool hooks do not confine shell access to that cwd: Bash has the operator user's filesystem/network permissions. Keep task ownership explicit and check resulting changes before integration.

Use `read` for investigation, `edit` when commands are intentionally reserved for the supervisor, and `sandboxed-bash` only when OS sandboxing and approval callbacks are explicitly desired. Do not silently require a sandbox for ordinary coding. Write profiles require nonempty allowedPaths; these govern file tools and Gate ownership checks, not arbitrary host shell writes.

Prepare a Git base containing the shared contract and required input files before dispatch; an edit worktree starts from that base and does not inherit uncommitted source files. Preserve unrelated user changes.

For parallel work, give each edit Worker an independent worktree created by the bridge. Do not have two Workers write the same files. Use `spawn_batch` only after every task has been validated; one invalid task must result in zero starts. Choose concurrency from task dependencies and `init`'s actual capacity, not a fixed Worker count. The limit is per connection, not a cross-session global quota.

## Observe and control

`spawn` and `spawn_batch` are non-blocking. Follow the returned job IDs with `wait`, using `afterRevision` and a bounded timeout. A wait timeout means that this wait call saw no new revision; it does not mean the Worker failed or timed out. Read compact snapshots first: progress contains recent tools/results, file-tool write receipts, turn count, activity timestamps, answer warnings and steer acknowledgement. Verbose does not expose raw tool bodies.

Use `status` for one bounded snapshot and `sessions` for filtered state. MCP responses intentionally omit full prompts and long Worker output. Use `reportPath` to read the final answer only when needed. A stream of thinking notices proves liveness, not useful progress. If no artifacts appear, give a concrete next milestone or wait for the task budget; avoid repetitive polling and reminders. Gate results include real command exit codes and retained logs.

Use `steer` only for a running job. A `queued` receipt is not delivery; the bridge reports delivery only after an SDK echo. Use `answer` only for a real pending approval request and bind it to the exact job/request ID. Unattended approvals default to deny. Do not answer Bash or external-side-effect requests merely to make a test green.

If a run finishes without an observable steer acknowledgement, delivery remains unverified. Put any still-needed instruction into the next `follow_up` instead of assuming it was applied.

Use `abort` for a task that should stop. A cancelled terminal snapshot does not mean the underlying Runner has settled: the concurrency slot and session remain occupied until the Runner promise exits. Do not `follow_up` or `fork` that same job while it still holds its slot.

## Reuse sessions deliberately

For an incremental fix, test extension, or follow-up in the same module, prefer `follow_up` on the original job. It resumes the exact Claude session ID and keeps useful context. You may renew `maxTurns` or `deadlineMs` when the original budget is genuinely insufficient; the bridge does not silently truncate a requested budget. Renewal cannot change the Worker model, effort, cwd, profile, or allowed paths.

Use `fork` for an independent direction that benefits from the parent's context; it creates a new job, worktree, and Claude session. A managed write fork snapshots the parent's tracked and ordinary untracked files, including uncommitted edits and deletions, into the child; ignored files and protected secrets are excluded. `task.forkBase` identifies its parent cwd/HEAD. Keep parent writers settled during the snapshot. For an independent acceptance evaluator, start a fresh task with the public contract and relevant outputs, without the implementer's reasoning or proposed answers.

Loading this skill does not require dispatching on every turn. For a small change spanning tightly coupled interfaces, or a focused repair whose evidence the current Codex already holds, direct bounded work can cost less than handoff and integration. Reassess per task rather than assuming every early task needs parallelism or every late task must stay local. Do not create a new Worker for every new task. Reuse a relevant session when its module knowledge and failure history remain useful. Create a new one when the work is independent, the old context is stale, the Worker repeats a failed assumption, or independent acceptance is required.

## Acceptance

Treat these as separate facts:

1. the Worker produced a model result;
2. the task reached a terminal state;
3. a Gate or test command passed with a real exit code;
4. the working tree and owned processes were cleaned up;
5. the evidence is complete enough to support the claim.

Check that promised output files actually exist in the returned Worker cwd. `edit` has no Bash: use the MCP `gate` or the supervisor's command runner for checks, or choose `sandboxed-bash` up front when autonomous command execution is needed. Do not ask an edit-only Worker to claim it ran commands.

Integrate only owned changes from that worktree into the target source project, including new files and intentional deletions. The bridge does not automatically merge them. Preserve unrelated edits and run the relevant integration checks on the resulting target. A green worktree alone does not prove delivery to the target project.

When the contract requires tests, verify both the real exit code and effective coverage: an empty `node --test` run can exit zero with zero tests. Missing required outputs, zero promised tests, or a static-only Gate cannot establish that those tests passed. Keep unique logs and first failures; record source hashes when reproducibility requires them. Exclude archived/generated copies from test discovery. A test that prints `FAILED` but exits zero is not a valid negative control.

When a Worker reports a failure, classify it before changing code:

- implementation defect: give the minimal failure evidence back to the original owner;
- handoff or contract defect: update the shared contract and affected Worker;
- test or fixture defect: correct the test only when the contract supports that correction;
- environment/provider issue: record it without changing product semantics.

Do not replace a hidden acceptance failure with a weaker assertion. If an acceptance script was exposed to an implementer, call it an external regression and add a small genuinely unprovided variant.

## Resource and security boundaries

Skills and MCP servers are operator-catalog resources in a stable configuration directory shared across connection instances (`init.connection.configDir`, config/resource-catalog.json and config/mcp-catalog.json). The launcher creates empty catalogs without overwriting existing content. This does not automatically import daily Claude/Pi resources. A task can select approved names only; it cannot supply arbitrary paths. An unselected Skill or MCP tool must be rejected before or during the query. The Worker does not inherit the user's main Claude/Codex/Pi settings. The bridge uses an isolated per-job HOME, an operator-owned session store, and a private credential file. A loopback proxy supplies a dummy API token to command-capable Workers while keeping the real token in the bridge. Without an OS sandbox, this is credential hygiene and not a host filesystem or multi-tenant boundary.

Never log API keys or authorization headers. Keep prompts, tool bodies, raw API responses and full transcripts out of routine logs; the bridge deliberately retains only the final answer in a private report file. Safe wire observation may record only model, effort, thinking type, stream flag, fixed endpoint category, and a parsed/overflow/invalid status. Do not call live tasks from normal `npm test`; use the explicit acceptance driver only when the user has authorized the live quota cost.

## Report

Report a concise delivery summary: model/effort, job references, changed paths, effective checks and exit codes, integration status, and material limitations. Keep detailed traces in artifacts rather than repeatedly loading them into Codex context. Distinguish fake-runner, offline, independent-evaluator, and real GLM evidence. Do not claim cost savings from SDK estimates or provider usage fields.

For operation examples, the explicitly authorized stdio fallback helper, and measured caveats, read [references/claude-durateam-operations.md](references/claude-durateam-operations.md).
