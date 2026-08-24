# Changelog

All notable user-visible changes. Every change lands here in the same commit
that makes it. Ideas that have not landed live in [BACKLOG.md](BACKLOG.md).

## Unreleased

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
