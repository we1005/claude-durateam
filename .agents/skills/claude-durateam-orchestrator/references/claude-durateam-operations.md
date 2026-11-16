# Claude-Durateam operations reference

## MCP surface

- `init`, `models`: read-only diagnostics and model routing.
- `spawn`, `spawn_batch`: non-blocking model jobs; pass `model` and `effort` explicitly in experiments.
- `wait`: bounded revision wait; use `continueIds` when several jobs are active.
- `status`, `sessions`: compact state inspection.
- `follow_up`: exact UUID resume; optional budget renewal only.
- `fork`: independent worktree/session branch.
- `steer`: running-job queue; `queued` is not `delivered`.
- `answer`: exact approval request only.
- `abort`: cancellation with possible partial writes.
- `gate`: external command/file-change acceptance with real exit codes.
- `handoff`: save/read concise project continuity; pass the returned instanceId with jobId to operational tools in a new connection.
- `sessions(includeStored:true)`: read-only cross-instance discovery; a live owner still prevents executing that instance elsewhere.

## Recommended coding request

```json
{
  "cwd": "/absolute/project",
  "model": "glm-5.3-flash",
  "effort": "high",
  "profile": "coding",
  "maxTurns": 20,
  "deadlineMs": 600000,
  "allowedPaths": ["src/owned-module", "test/owned-module.test.mjs"],
  "prompt": "Implement the requested behavior in your actual runtime cwd, using relative project paths. Save useful progress early, write the required tests, run the relevant checks and repair failures autonomously, then report actual results."
}
```

Use `coding` for autonomous host execution without an OS sandbox, as the operator requested. It pre-approves Bash with acceptEdits; it does not use bypassPermissions or classifier auto mode. `sandboxed-bash` explicitly opts into OS isolation and approval callbacks. A credential-injecting loopback proxy uses a dummy token; it is not a filesystem boundary.

An edit-only Worker cannot execute test commands. After it settles, run checks on the returned worktree, for example `gate` with `cwd` set to that worktree, the same write scope, and `commands: [["node", "--test", "test/owned-module.test.mjs"]]`. Inspect the saved command log for actual test discovery as well as exit status. The Gate's `testsVerified` field records configured-command execution, not semantic test coverage. Integrate the accepted owned files and deletions into the source project, then run the relevant integration check there.

## Explicitly authorized fallback

Prefer native MCP tools. When those are absent and the task explicitly permits the official Client fallback, run `node <this-skill>/scripts/mcp-client.mjs` in a persistent command session with pipes (`tty: false`). The helper reads only the `claude_durateam` registration from `~/.codex/config.toml`, carries its command/arguments/environment, and resolves the installed official MCP Client from the registered local Node project. It needs Python 3.11+ for TOML parsing and does not install packages. An alternate absolute config is available with `--config /absolute/config.toml`.

Send one JSON object per line, for example:

```jsonl
{"id":"ready-check","name":"init","arguments":{}}
{"id":"schema","list":true}
{"id":"models","name":"models","arguments":{}}
```

Keep that same process alive for spawn, wait, follow-up, and acceptance; EOF or `{"close":true}` closes the connection. Do not use a one-shot pipe for a non-blocking spawn and then lose its connection. Use the returned `init.connection` to identify the durable instance. Do not treat this helper as proof that native Codex tool discovery works. It emits MCP results but deliberately suppresses server stderr and raw configuration; check registration/init diagnostics when startup fails instead of enabling secret-bearing debug dumps.

## Measured behavior and caveats

- The production path has been tested with `glm-5.3-flash` + `effort: high`: two isolated edit Workers, queued cancellation, running cancellation, same-session follow-up, and cross-job fork all passed.
- Ordinary project reads remain available in `edit`; `allowedPaths` controls writes.
- Native MCP tools can be absent from an already-running Codex/SubAgent toolset even when a new app-server discovers the registration. An explicitly authorized official Client fallback must carry the registration's environment, including allowed roots, runtime/worktree roots, and key-file path; inheriting the shell alone is insufficient.
- Separate fresh-agent tasks found successful model results with no files and zero tests. Treat them as incomplete work and reuse the original session with concrete failure evidence; success state alone is not acceptance.
- `steer` returning `queued`, followed by a terminal result, is not proof of delivery or of a causal relationship. The internal `steer_ack` requires an SDK echo; `progress.lastSteer` exposes the last receipt and its delivered status after SDK echo. Earlier reminders can remain unverified; do not infer delivery from terminal timing.
- `steer` defaults to `next`; do not repeatedly send `now` merely because a high-effort turn is quiet. This evaluation did not establish the provider's precise interruption semantics.
- `status(verbose:true)` keeps metadata bounded, including progress, recent tools and file-tool receipts, rather than dumping tool bodies. Use reportPath for the final answer; inspect own-job diagnostic evidence only for a concrete unresolved failure.
- A cancelled job still holding its Runner slot cannot be resumed or forked until the Runner settles.
- Explicit task budgets are validated up to 100 turns and six hours; SDK values are not silently reduced.
- Session-family transcript copying across worktrees depends on the pinned Claude SDK/CLI transcript layout. Re-run its cross-job test after upgrades.
- `skills: []` does not hide built-in metadata. Selected Skills come from the operator catalog, and unselected Skill calls are denied.
- Safe wire metadata is not an HTTP request counter. `observedStatus: parsed` means the request body was parsed; `overflow` and `invalid` mean effort/model metadata is unavailable.
