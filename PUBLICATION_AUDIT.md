# Public repository preparation

Date: 2026-11-16. This document records preparation of the initial public source
snapshot. It is not a guarantee that arbitrary future commits or local runtime
data are safe to publish.

## Scope and findings

- Inspected the 109 previously tracked files, the four workflow diagram exports,
  and the publication configuration and documentation added in this pass.
- Reviewed 46 reachable development commits and 234 historical file blobs with
  credential-pattern checks. Also inspected local text outside dependencies,
  build output, Git internals, and downloaded audit tools.
- Used Gitleaks 8.30.1, downloaded from its official GitHub release and checked
  against that release's SHA-256 manifest. Reports were written locally with
  credential values redacted.
- No real API keys, access tokens, passwords, or private keys were identified in
  the proposed public files. Two Gitleaks findings were reviewed: the fixed fake
  credential in a redaction unit test and a source-file SHA-256 in a validation
  manifest. `.gitleaks.toml` allows only those specific fixtures or manifest lines;
  it keeps the default detection rules enabled.
- Replaced personal username and mounted-volume prefixes in documentation and
  validation manifests with example paths. Historical validation results and
  source hashes remain records of the earlier tested snapshots; they are not
  checksums or fresh validation results for this public export.

## Publication boundary

The public `main` branch starts from the reviewed source snapshot. Earlier
development branches and their commit history remain local and are not included
in the initial push. The initial public commit uses a GitHub noreply address.

Included: source, tests, dependency lockfile, configuration examples, supervisor
Skills, design and validation documents, editable workflow diagrams, and their
high-resolution PNG exports.

Excluded: `.env` files, credentials and key files, local Claude settings,
`node_modules`, `dist`, `.runtime`, `.artifacts`, session transcripts, local logs,
databases, and test working directories. Local audit reports also remain under
the ignored `.artifacts` directory. Ignored runtime data may contain prompts,
tool results, and private machine details; it was not approved for publication.

## Verification

Before publication, `npm run verify` passed: TypeScript checking and build,
31 test files with 206 passing tests, and a real stdio MCP handshake without
model credentials. This pass did not make paid model calls or repeat the earlier
live GLM validation campaigns.

To repeat the public-source check with Gitleaks installed:

```sh
gitleaks git . --log-opts=main --redact --config .gitleaks.toml
```

Runtime API tokens must continue to be supplied through private local files.
Do not paste credentials into issues, examples, screenshots, or exported logs.
