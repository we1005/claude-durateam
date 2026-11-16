# Project guidance

When current online information is needed, use the built-in Web Search tool first. If it is unavailable or fails to retrieve useful results, use Subscription Powers' Codex / Dot web-search tools (`codex_web_search`, `dot_web_search`, or its `web_search` router). Discover the available tool names rather than guessing a namespace. Read the supporting primary pages and cite them. Do not substitute remembered facts for an unavailable search.

Keep any session-level Context7 requirements for library/API documentation; the rule above governs web-search fallback and does not replace those requirements.

Claude-Durateam's normal `coding` profile intentionally runs development commands without an OS sandbox, as requested by the owner. Permission mode and sandboxing are separate controls. Retain optional sandbox execution for explicit requests; do not silently re-enable it as a condition of routine coding or testing. Keep file ownership, ordinary credential hygiene and integration checks, and describe their limits accurately.
