# .claude-plugin/ — plugin manifest

[plugin.json](plugin.json) packages Tether for Claude Code. It bundles three
things that are defined elsewhere:

- the `tether` skill — [../skills/tether/](../skills/tether/)
- the `/tether-check` and `/tether-resolve` commands — [../commands/](../commands/)
- the MCP server — declared here as `npx -y tether-mcp mcp`, implemented in
  [../src/server.js](../src/server.js)

## The version is duplicated

`plugin.json` carries its own `version`, which must match
[../package.json](../package.json). Everything else reads the version from the
manifest via [../src/version.js](../src/version.js) — this file cannot, because
a plugin manifest must be static JSON.

**So it is the one place drift can hide.** Bump both in the same commit. There
is a standing backlog item to assert the match in CI; see
[../BACKLOG.md](../BACKLOG.md).

## Rules

- The MCP server exposes **read-only** tools only: `tether_check_drift`,
  `tether_list_connectors`, `tether_affected_skills`. None can snapshot, probe
  or write. An agent that could accept drift on its own behalf defeats the point
  of a lockfile being reviewed. Adding a tool here means arguing that case first.
- New files the plugin needs must also be listed in `files` in
  [../package.json](../package.json), or the packed tarball ships without them.
  The CI smoke job is the backstop.
