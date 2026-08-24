# commands/ — slash commands

Two entry points shipped with the Claude plugin:

| Command | Runs | For |
| --- | --- | --- |
| [/tether-check](tether-check.md) | `check --json` | schema drift + affected skills |
| [/tether-resolve](tether-resolve.md) | `resolve` | instance drift for declared identifiers |

## Shape

Frontmatter with a one-line `description:`, then numbered instructions. Each
command tells the agent to shell out to the CLI with `--json` and summarize —
the command file holds no logic, just how to present what the core returned.

## Rules

- **Prefer `--json`.** Parsing the Markdown report is drift waiting to happen.
- **Handle every exit code**, especially `2`. "Could not check" must be reported
  as could-not-check, never as clean.
- **Be quiet when clean.** Exit `0` with no warnings → one line, stop.
- **Never instruct the agent to `snapshot`.** That accepts all drift, including
  drift nobody reviewed. The escape hatch is `.tether/acknowledged.json`, and a
  human writes it.
- Keep these consistent with [../skills/tether/SKILL.md](../skills/tether/SKILL.md)
  and the MCP tools in [../src/server.js](../src/server.js). A change to CLI
  output usually touches all three.
