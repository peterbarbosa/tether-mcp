# Changelog

All notable user-visible changes. Every change lands here in the same commit
that makes it. Ideas that have not landed live in [BACKLOG.md](BACKLOG.md).

## Unreleased

### Published to npm

[`tether-mcp@0.2.0`](https://www.npmjs.com/package/tether-mcp) is on the
registry. Every `npx tether-mcp` in the docs was a 404 until now, and the quick
start carried a run-from-source workaround in place of an install line. Both are
gone — verified by installing from the registry into an empty directory and
running `list`, `snapshot` and `check` against a live connector.

Two things were wrong with the payload and were fixed before it went out:

- **Agent instructions were shipping.** The five subdirectory `CLAUDE.md` files
  are for working *on* Tether, not for consuming it, and they rode along because
  their directories are listed in `files`. Excluded — the tarball is now 22
  files, 38.4 kB.
- **A broken build was publishable.** `prepublishOnly` now runs the suite.
  "Could not check is not a pass" applies to releasing too; verified by
  publishing a deliberately failing tree and watching it refuse.

The release itself was published by hand, which npm now requires a 2FA prompt
for. Moving that to OIDC trusted publishing from CI is in the backlog.

### A synthetic MCP fixture server, and the branches it reached for the first time

Every lockfile in this repo is a toy: flat tools, one page, no credentials. So
the code that *produces* a snapshot — connect, follow `nextCursor` to
exhaustion, decide whether the result is complete — had unit tests around its
inputs and no execution coverage at all. The branches with none were the ones
that matter most on a large connector.

`test/fixtures/mcp-server.js` is a real stdio MCP server that misbehaves on
request, configured through `TETHER_FIXTURE_*` env vars on an ordinary
connector spec. Tests reach it through `snapshotConnector` by the same path
production takes — no mocking past the client. The suite stays offline; the
transport is a child process, not a socket.

Newly executed, in some cases for the first time:

- **`complete: false`** — a server that never stops paginating now provably
  yields an incomplete snapshot rather than a short one silently locked as
  whole. This was correctness-critical and entirely unexercised.
- **Pagination** — a 7-tool surface split into pages assembles to the same
  bytes as the same surface served in one.
- **Credential-scoped tool sets** — a snapshot taken with a token and a check
  run without one now demonstrably report a scope mismatch instead of a
  phantom removal.
- **The stdio timeout** — a server that accepts the connection and then answers
  nothing fails inside its budget instead of hanging.
- **A server that advertises resources and then refuses them** — degrades to
  "no resources" without losing the tool drift alongside it.
- **The schema walk against schemas Tether did not author** — nesting, depth
  cutoff, `$ref`, a self-referential type, and an unresolvable ref.

Two things the fixture corrected on contact:

- MCP requires `outputSchema.type` to be `object`, so a conforming server
  cannot return a bare top-level array. Output arrays arrive one level in and
  flatten to `users[].id`. A comment in `src/canonical.js` claiming `[].id`
  described a shape no real server can send.
- `node --test` sweeps up every `.js` file under `test/`, so the fixture ran
  as a test and hung the suite waiting for a client. It now exits unless
  spawned with `TETHER_FIXTURE=1`.

### Documentation corrected to match the code

The README's *Limits worth knowing* still described the pre-v2 walker — it told
readers that nested drift was invisible and that `$ref` was an opaque string,
both of which 0.2.0 fixed. A limits list that overstates the blind spots is the
same failure as one that hides them: the doc is the interface, and it was
lying in both directions.

It now states the limits that are real — the depth-6 cutoff surfacing as
`truncated`, and same-document-only `$ref` resolution surfacing as
`unresolvedRef` / `cyclicRef`.

Also corrected: the lockfile example carried `"lockfileVersion": 1` after the
format moved to 2, and the test count was three releases stale.

A comment in `src/lock.js` claimed the differ short-circuits on the per-tool
digest. It does not, deliberately — `src/diff.js` compares content because a
hand-edited lockfile's digest cannot be trusted. The comment now says why the
surface is in the digest anyway: so deriving it differently shows up in review.

### Repo documentation

`CLAUDE.md` at the root and in every subdirectory, so an agent working here can
navigate the repo and — more importantly — knows which invariants it must not
break: byte-stable lockfiles, one `callTool` site, three gates before any probe,
annotations as evidence rather than authority, and exit `2` never collapsing
into `0`.

Added `BACKLOG.md`, including a *Rejected, and why* section so settled design
arguments are not relitigated.

Removed two empty files (`git`, `node`) committed by accident during release
prep — stray shell redirects, never referenced by anything.

## 0.2.0

**The lockfile format is now v2. Run `tether snapshot` once after upgrading.**
`check` refuses to compare a v1 lock against a v2 snapshot and exits 2 rather
than reporting every newly-visible nested field as an addition. Review that
first re-snapshot on its own — it can contain drift that was previously
invisible.

### Nested schemas, `$ref` and array outputs are no longer blind spots

The surface walked top-level parameters only, so three kinds of drift went
completely undetected — each one the exact failure Tether exists to catch: no
error, plausible output, wrong result.

```
nested `fields.teamId` becomes required   -> "No drift"
array outputSchema drops name + email     -> "No drift"
param type changes behind a $ref          -> "No drift"
```

The first is the README's own headline scenario, and nested parameters are the
norm for GitHub, Linear, Jira and Slack. The second is the MCP specification's
own `list_users` example.

Schemas now flatten to dotted paths (`fields.teamId`, `items[].sku`), local
`$ref`s resolve by JSON Pointer, recursive types expand one level and record the
cycle, unresolvable refs are reported rather than treated as empty, and anything
past the depth limit is marked `truncated`.

### Acknowledged drift

`.tether/acknowledged.json` records a reviewed decision that one named change is
fine. Previously the only way past a breaking change was `tether snapshot`,
which accepts everything — training people to re-snapshot on red.

Acknowledged changes still appear in the report with their reason and author.
Entries can carry an `expires` date; a lapsed entry stops applying and says so.
A malformed file acknowledges nothing.

### Also

- The version is read from `package.json` instead of being hardcoded in five
  places, which was itself a small piece of drift.
- `repository`, `bugs` and `homepage` added to the package manifest.

## 0.1.0

First release. Snapshot MCP connectors to a byte-stable lockfile, diff them,
index which skills reference which tools, resolve declared instance
identifiers behind a human-reviewed probe allowlist, and report all of it as
Markdown or JSON with CI exit codes. Ships as a CLI, a Claude plugin, and an
MCP server.
