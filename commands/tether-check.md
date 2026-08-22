---
description: Check MCP connectors for drift against their lockfile and report which skills are affected
---

Run `npx tether-mcp check --json` in the project root.

Then:

1. If the exit code is 0 and there are no warnings, say so in one line and stop.
2. Otherwise, summarize the drift grouped by connector, breaking changes first.
3. For each breaking change, search the skill library for files referencing the
   affected tool (`grep -rl "<tool_name>" skills/ .claude/skills/ 2>/dev/null`)
   and list which skills need updating.
4. Do not run `tether snapshot` — accepting the new state is the user's call,
   and it should happen only after the affected skills are fixed.

$ARGUMENTS
