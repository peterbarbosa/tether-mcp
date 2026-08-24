# skills/ — the shipped agent skill

[tether/SKILL.md](tether/SKILL.md) is what an agent loads to check drift
mid-task. It ships in the npm package and in the Claude plugin.

This is Tether being its own customer: a Markdown skill that references tools by
name, which is exactly the artifact Tether exists to protect. If you change a
CLI flag or an exit code, this file is one of the things that drifted.

## What belongs here

- **When to run a check** — a tool call failed unexpectedly, a skill started
  producing wrong-looking output, before relying on a connector for important
  work. The `description:` frontmatter is the trigger; make it concrete.
- **How to read the report** — breaking first, grouped by connector, then which
  skills are affected.
- **What the agent must not do** — never `snapshot` to make drift go away.
  Snapshot accepts *everything*, including drift nobody looked at. Accepting a
  reviewed change is `.tether/acknowledged.json`, written by a human.

## Rules

- Keep it procedural. A skill is a procedure, not an essay — the reasoning lives
  in the [README](../README.md).
- Reference commands and flags exactly as [bin/](../bin/) implements them.
- If a skill here grows dependencies on instances, give it a `tether:` manifest
  — see [../examples/](../examples/) for the shape.
- Related surfaces: [../commands/](../commands/) (slash commands),
  [../src/server.js](../src/server.js) (MCP tools). The three should agree.
