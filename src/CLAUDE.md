# src/ — the core

Every rule lives here. The three surfaces (CLI, MCP server, plugin) are thin
wrappers over these modules and must stay that way — if you find yourself
writing a decision in `bin/` or `src/server.js`, it belongs here instead.

Node 20+, ESM, no build step. Every module opens with a comment explaining why
it exists and what it refuses to do.

## Module map

| Module | Responsibility | I/O? |
| --- | --- | --- |
| [config.js](config.js) | Discover connectors from the MCP config the project already has | reads config files |
| [client.js](client.js) | The **only** module that touches the network | network |
| [canonical.js](canonical.js) | Canonical form, digests, schema flattening, similarity | pure |
| [lock.js](lock.js) | The `.tether/*.lock.json` format — read, write, build | fs |
| [diff.js](diff.js) | Compare two lock bodies, assign severity | pure |
| [manifest.js](manifest.js) | Parse the `tether:` frontmatter block a skill declares | pure |
| [skills.js](skills.js) | Index which skills reference which tools | fs |
| [allowlist.js](allowlist.js) | The only thing that authorizes a probe | fs |
| [probe.js](probe.js) | Instance resolution — the only module permitted to call a tool | via client |
| [acknowledged.js](acknowledged.js) | Reviewed decisions that one named change is fine | fs |
| [report.js](report.js) | Render reports, compute exit codes | pure |
| [server.js](server.js) | Tether as an MCP server (read-only tools) | surface |
| [version.js](version.js) | One source of truth, read from `package.json` | fs |

Keep the pure modules pure. `canonical.js`, `diff.js`, `manifest.js` and
`report.js` do no I/O, which is why they are cheap to test exhaustively.

## Rules that live in specific files

**canonical.js** — Everything written to a lockfile passes through here so two
snapshots of an unchanged server are byte-identical. Volatile fields
(`ttlMs`, `nextCursor`, `_meta`, `icons`, …) are stripped. Schemas flatten to
dotted paths (`fields.teamId`, `items[].sku`); local `$ref`s resolve by JSON
Pointer; recursion expands one level and records the cycle; an unresolvable ref
is reported, never treated as an empty schema; past the depth limit is marked
`truncated`. **Under-reporting must always be visible.**

**lock.js** — `LOCKFILE_VERSION` is 2. A v1 lock cannot be compared against a v2
snapshot (every newly-visible nested field would read as an addition), so the
differ refuses and exits 2 rather than flooding. Bumping the version is a
breaking change requiring a `snapshot` and a CHANGELOG entry.

**diff.js** — Severity answers exactly one question: *would a skill written
against the old snapshot still do the right thing against the new one?*
breaking = no, warning = maybe, info = yes. The differ never short-circuits on a
digest — lockfiles are meant to be hand-edited, and a hash Tether did not
compute cannot be trusted. Rename detection is deterministic: pair a removed
tool with a new one only when parameter surfaces match uniquely, or the names
are close *and* the parameter sets are identical. Anything ambiguous reports as
a plain removal.

**client.js** — `createToolCaller` is the single `callTool` site in the
codebase, and it re-checks the allowlist independently of `probe.js`. Two gates
that share no code, on purpose. Snapshotting calls `tools/list` and
`resources/list` and nothing else. `principalHint` is a non-reversible digest of
credentials, never the credential.

**allowlist.js** — Proposals go to `allowlist.proposed.json`; nothing there is
active. Promotion to `allowlist.json` is a manual human edit. **The friction is
the feature.** A name that reads as mutation is never nominated, whatever the
server's annotations claim. A malformed allowlist authorizes nothing.

**probe.js** — Three gates in order: declared → allowlisted → not a dry run.
Anything uncertain is skipped and *reported*, never guessed. A drift auditor
that files a ticket while auditing is worse than no auditor.

**skills.js** — Detection matches only code-formatted references
(`` `create_issue` ``). Matching bare prose would flag every skill containing
"add" against a server exposing an `add` tool. Declared manifests are
authoritative; detections are hints for a human to promote.

**acknowledged.js** — An acknowledged change **still appears in the report**,
with its reason and author. An acknowledgement is a decision on the record, not
a delete key. `connector` and `type` are always required so nothing is
blanket-suppressed by accident; other omitted fields act as wildcards.

**report.js** — Every change renders as a sentence a human can act on without
opening the lockfile. If you add a change type to `diff.js`, add its sentence
here in the same commit.

## Adding a new change type

1. Emit it in [diff.js](diff.js) with a severity, justified by the one question.
2. Add its sentence to `describe()` in [report.js](report.js).
3. Make it acknowledgeable — the `type` string is the acknowledgement key.
4. Add a case to [../test/diff.test.js](../test/diff.test.js) and a regression
   test if it was ever a blind spot.
5. CHANGELOG entry in the same commit.
