# Changelog

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
