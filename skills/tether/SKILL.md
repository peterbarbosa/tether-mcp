---
name: tether
description: Check whether the MCP connectors this project depends on have changed since they were last locked, and explain which skills are affected. Use when a tool call fails unexpectedly, when an agent skill starts producing wrong-looking output, before relying on a connector for important work, or when the user asks about connector drift, tool schema changes, or tether.
---

# Checking connector drift with Tether

Agent skills reference tools by name and by parameter. When a connector changes
underneath them, the skill does not error — it quietly does the wrong thing.
Tether snapshots what each MCP connector exposes and tells you what moved.

## Running a check

```bash
npx tether-mcp check
```

Exit codes: `0` no breaking changes, `1` breaking drift, `2` a connector could
not be reached. Add `--json` when you need to process the result rather than
read it.

To check a single connector: `npx tether-mcp check <connector-id>`.
To see what Tether can see: `npx tether-mcp list`.

## Reading the report

Severity answers one question — would a skill written against the old snapshot
still do the right thing?

- 🔴 **breaking** — no. A tool vanished, a parameter became required, a type
  changed, an enum narrowed, or a tool stopped declaring itself read-only.
- 🟡 **warning** — maybe. New optional parameter, widened enum, incomplete
  snapshot. Worth a look, never fails a build.
- ⚪ **info** — yes. New tool, description change, version bump.

## What to do about breaking drift

1. Read the report. Each line names the tool and the parameter.
2. Search the skill library for references to the affected tool:
   `grep -rl "<tool_name>" skills/`
3. Update those skills to match the new surface. A parameter that became
   required is the dangerous case — without it the agent invents a value, and
   the output still looks plausible.
4. Once the skills are corrected, accept the new state:
   `npx tether-mcp snapshot <connector-id>`
5. Commit the updated lockfile alongside the skill changes, so the reason for
   the change is visible in one diff.

## Accepting a new snapshot

`tether snapshot` overwrites the lockfile with current reality. Only run it
after the affected skills have been reviewed — otherwise you have recorded the
drift rather than fixed it.

## Scope mismatch

If the report says *scope mismatch*, the lockfile was captured under different
credentials than this run. A connector may legitimately expose different tools
to different principals, so the two snapshots are not comparable. Re-snapshot
with the original credentials, or keep a separate lockfile per principal.

## What Tether will not do

Tether only ever calls `tools/list` and `resources/list`. It never invokes a
tool, so a drift check can never create a page, file a ticket, or send a
message. Do not ask it to verify a tool by calling it.

Tether also does not check whether a skill produces *good* output — only
whether the things it references still exist.
