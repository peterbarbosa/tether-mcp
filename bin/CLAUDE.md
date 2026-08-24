# bin/ — the CLI

[tether.js](tether.js) is the primary surface: for a human at a terminal, for a
cron, and for CI. It parses args, dispatches, and prints. **It holds no rules** —
every decision lives in [../src/](../src/).

## Commands

| Command | Does | Writes |
| --- | --- | --- |
| `list` | What Tether can see from the MCP config | — |
| `snapshot` | Capture the live surface | `.tether/<id>.lock.json` + `.meta.json` |
| `check` | Diff live state against the lockfile | report (`--out`, `--json`) |
| `index` | Which skills reference which tools | `.tether/index.json` |
| `allowlist` | Nominate probeable tools | `.tether/allowlist.proposed.json` |
| `resolve` | Instance drift for declared identifiers | report |
| `mcp` | Run Tether as an MCP server | — |

Flags worth knowing: `--out <file>`, `--json`, `--dry-run` (resolve only),
`--help`.

## Exit codes are the contract

```
0  clean
1  breaking drift, or an identifier that no longer resolves
2  could not check
```

`2` is the one that matters. An unreachable connector, a connector named on the
command line with no lockfile, a snapshot taken under different credentials —
none of those are a pass and none are a breakage. **A checker that reports "no
result" as "all clear" is worse than no checker.** Never collapse `2` into `0`.

Exit codes are computed in [../src/report.js](../src/report.js), not here. This
file calls `process.exit` with what the core decided.

## Conventions

- `fail()` for user error, `note()` for stderr commentary, `emit()` for the
  report itself. Reports go to stdout so they pipe; everything else to stderr.
- New command → also consider whether the MCP server
  ([../src/server.js](../src/server.js)) should expose a read-only equivalent.
  It must never gain snapshot, probe or write.
- CLI behaviour is covered by [../test/cli.test.js](../test/cli.test.js), which
  runs the binary as a subprocess and asserts exit codes.
