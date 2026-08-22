# Tether

**Know when your MCP connectors drift out from under your agent skills.**

Agent skills — reusable Markdown procedures that tell an agent how to do a job —
are becoming the unit of institutional knowledge inside companies. Large orgs
already run libraries of hundreds of them, written by domain teams rather than
platform engineers.

Skills are dependent artifacts. They reference tools, parameters, endpoints,
project keys, folder paths. All of that changes underneath them, and nothing
tells you when it does.

When a skill's world changes, the skill doesn't error. It quietly does the wrong
thing. A tool that gained a required parameter means the agent starts guessing
values. A renamed project key means tickets get filed nowhere useful. The output
still looks plausible, so nobody notices for six weeks.

Software solved this with lockfiles, `npm outdated`, and CI. Skill libraries have
no equivalent. Tether is that equivalent.

`tools/list` is the lockfile. `tether check` is `npm outdated`. A skill whose
references no longer resolve is a broken build.

---

## Quick start

Tether reads the `.mcp.json` your project already has. There is nothing to
configure.

```bash
npx tether-mcp list        # what Tether can see
npx tether-mcp snapshot    # capture the current surface into .tether/
npx tether-mcp check       # diff live state against the lockfile
```

Commit `.tether/` to your repository. From then on, `tether check` tells you what
moved.

```
# Tether drift report

**1 breaking change** across 1 connector.

## linear — breaking

- 🔴 `create_issue` now requires `teamId`. Agents that omitted it will start guessing a value.
- 🟡 `search_issues` added an optional parameter `includeArchived`.
```

Exit codes: `0` clean, `1` breaking drift, `2` a connector could not be reached.
A checker that cannot reach a connector must never report all clear.

## In CI

```yaml
- run: npx tether-mcp check --out drift.md
```

A ready-made workflow is in [`.github/workflows/tether.yml`](.github/workflows/tether.yml).

## In Claude Code

Tether ships as a plugin. Install it and your agent can check drift mid-task:

- **Skill** `tether` — the agent runs a check, reads the report, and finds the
  skills that reference the affected tools.
- **Command** `/tether-check` — run a check and get an affected-skills summary.

## What counts as breaking

Severity answers one question: would a skill written against the old snapshot
still do the right thing against the new one?

| Change | Severity |
| --- | --- |
| Tool or resource removed | 🔴 breaking |
| Parameter removed, or became required | 🔴 breaking |
| Parameter type changed | 🔴 breaking |
| Enum narrowed | 🔴 breaking |
| Output field removed | 🔴 breaking |
| Tool stopped declaring itself read-only | 🔴 breaking |
| Optional parameter added, enum widened | 🟡 warning |
| Snapshot incomplete | 🟡 warning |
| Tool added, description or version changed | ⚪ info |

## The lockfile

One file per connector in `.tether/`, designed to be read in a pull request.

```jsonc
{
  "lockfileVersion": 1,
  "connector": { "id": "linear", "transport": "http", "serverInfo": {...} },
  "scope": { "authMode": "credentialed", "principalHint": "9f2a1c…", "complete": true },
  "digest": "sha256:…",
  "tools": [
    {
      "name": "create_issue",
      "digest": "sha256:…",
      "inputSchema": { /* verbatim, for human review */ },
      "surface": {                    /* normalized, what the differ reads */
        "required": ["teamId"],
        "params": { "teamId": { "type": "string", "required": true } },
        "outputs": ["id", "url"],
        "readOnly": "unknown"
      }
    }
  ]
}
```

Three decisions worth knowing about:

**Provenance lives in a sidecar.** `capturedAt` is in `<id>.meta.json`, never in
the lockfile body. If a timestamp lived in the lock, every snapshot would produce
a diff even when nothing changed. Two snapshots of an unchanged server are
byte-identical — a clean `git diff` means nothing drifted.

**`surface` is what the differ reads.** The same JSON Schema constraint can be
written three equivalent ways. Diffing raw schema produces phantom breaking
changes, so Tether normalizes each tool down to the facts a skill can actually
depend on. The raw schema stays in the lockfile for human review.

**Snapshots are credential-scoped.** MCP allows a `tools/list` result to vary by
the authorization presented. `principalHint` is a non-reversible digest of the
credentials used — never the credential itself. If it doesn't match, Tether
reports a *scope mismatch* rather than inventing hundreds of phantom removals.

## Safety

Tether calls `tools/list` and `resources/list`. Nothing else.

`tools/call` is never imported, referenced, or reachable from any code path.
An auditor that creates pages or files tickets while checking for drift is worse
than no auditor, so this is enforced by tests that fail if any source file
reaches for a tool-invoking method — not by care.

Tool annotations like `readOnlyHint` are server-controlled, and the MCP spec says
clients must treat them as untrusted. Tether records them as *evidence*
(`"readOnly": "hinted"`), never as authority.

## Non-goals

Not a security scanner. Not a spec linter. Not a registry or control plane. Not
an evaluator — Tether checks whether a skill's references still resolve, not
whether the skill produces good output.

## Status

**v0.** Schema drift only: Tether tells you when a connector's *capabilities*
change. It does not yet tell you when an *instance* changes — whether
`/Engineering/API` still exists, whether that project key still resolves. That is
the silent tier and it is next. The lockfile format is designed for it.

Requires Node 20+. One dependency: the official MCP SDK. No build step.

MIT.
