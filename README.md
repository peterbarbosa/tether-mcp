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

**2 breaking changes** across 1 connector.

## linear — breaking

- 🔴 `create_issue` now requires `teamId`. Agents that omitted it will start guessing a value.
- 🔴 Tool `search_issues` appears to have been renamed to `find_issues` (high confidence).

## Affected skills

### `skills/file-a-bug/SKILL.md`

- `create_issue` now requires `teamId`. Agents that omitted it will start guessing a value.
  - **Suggested edit:** pass `teamId` explicitly when calling `create_issue`; do not let the agent infer it
```

Exit codes: `0` clean, `1` breaking drift, `2` a connector could not be reached.
A checker that cannot reach a connector must never report all clear.

## The two tiers of drift

**Tier 1 — schema drift.** A tool is renamed or removed, a parameter becomes
required, an enum narrows. Detected by diffing `tools/list` snapshots. Cheap,
universal, no per-connector code. This is `snapshot` and `check`.

**Tier 2 — instance drift.** The wiki path, the project key, the folder, the
channel. MCP introspects *capabilities*, not *instances*: `tools/list` tells you
`update_page(path, content)` exists, and nothing about whether `/Engineering/API`
still does. This is the silent tier — the one that fails without erroring — and
it is `index`, `allowlist` and `resolve`.

## Tier 1: schema drift

```bash
npx tether-mcp snapshot        # capture
npx tether-mcp check           # compare
```

| Change | Severity |
| --- | --- |
| Tool or resource removed | 🔴 breaking |
| Tool renamed (successor named where detectable) | 🔴 breaking |
| Parameter removed, or became required | 🔴 breaking |
| Parameter type changed | 🔴 breaking |
| Enum narrowed | 🔴 breaking |
| Output field removed | 🔴 breaking |
| Tool stopped declaring itself read-only | 🔴 breaking |
| Optional parameter added, enum widened | 🟡 warning |
| Snapshot incomplete | 🟡 warning |
| Tool added, description or version changed | ⚪ info |

Rename detection is deterministic. A rename usually preserves the parameter
surface exactly, and an identical surface is much stronger evidence than a
similar name. Tether pairs a removed tool with a new one only when the surfaces
match uniquely, or the names are close *and* the parameter sets are identical.
Anything ambiguous is reported as a plain removal rather than a confident and
wrong patch suggestion.

## Tier 2: instance drift

### 1. Declare what a skill assumes

Add a `tether:` block to a skill's frontmatter. This turns drift checking from
inference into lookup — no model involved.

```yaml
---
name: file-a-bug
description: File a bug in the right place.
tether:
  connectors: [linear]
  tools:
    - linear.create_issue
  identifiers:
    - id: platform-team
      connector: linear
      probe: list_teams        # a read-only tool that enumerates
      match: name              # the field in each result to compare
      value: Platform          # what this skill assumes exists
      args:                    # optional static arguments for the probe
        includeArchived: false
---
```

Everything under `tether:` is optional. A skill with no manifest still gets
tool-reference checking; the manifest is what unlocks instance resolution.

### 2. Index the library

```bash
npx tether-mcp index
```

Writes `.tether/index.json` — which skills reference which tools. Commit it.

This stays in the deterministic core. The lockfile already holds ground-truth
tool names from `tools/list`, so finding the skills that reference them is a
search against a known vocabulary, not an inference over prose. Detection only
matches code-formatted references (`` `create_issue` ``); matching bare prose
would flag every skill containing the word "add" against a server that happens
to expose an `add` tool.

`index` exits `1` if a skill declares a tool that exists in no lockfile.

### 3. Authorize probes — the safety story

```bash
npx tether-mcp allowlist
```

This writes **proposals** to `.tether/allowlist.proposed.json`. Nothing in that
file is active. Tether will not probe a tool until a human moves it into
`.tether/allowlist.json` and commits it. The friction is the feature.

Proposals are nominated from two kinds of evidence — a `readOnlyHint: true`
annotation, and a name that reads as retrieval — and anything whose name
suggests mutation is never nominated, whatever its annotations claim.

### 4. Resolve

```bash
npx tether-mcp resolve --dry-run   # log intended probes, call nothing
npx tether-mcp resolve             # check for real
```

```
# Tether instance drift report

**1 identifier no longer resolves.** This is the silent tier: nothing errors,
the skill just does the wrong thing.

- ✅ **platform-team** — `Platform` via `linear.list_teams` still resolves.
- 🔴 **eng-wiki-root** — `/Engineering/API` via `wiki.list_pages` was not found among 34 candidates.
  - Did it become `/Engineering/API-Reference`? (78% similar)
- ⏭️ **billing-project** — skipped: `search_projects` is not on the probe allowlist.
```

Exits `1` when an identifier no longer resolves.

## Safety

**Tether never invokes a tool unless all three of these are true**, and they are
checked in this order:

1. **A skill declared it.** Tether never chooses a tool to call on its own — only
   what a manifest names as a `probe`.
2. **A human allowlisted it.** Server annotations can nominate; only a committed
   `allowlist.json` authorizes.
3. **It is not a dry run.**

Snapshotting and checking call `tools/list` and `resources/list` only.

This is enforced by tests, not by care. `test/safety.test.js` asserts that
`client.callTool` appears exactly once in the entire codebase, that the
allowlist check precedes it, that the resolver's gates hold against a spy which
fails the suite if it is ever reached illegitimately, and that a malformed
allowlist authorizes nothing. There are two independent gates — one in the
resolver, one in the client — that deliberately share no code.

Tool annotations like `readOnlyHint` are server-controlled, and the MCP spec says
clients must treat them as untrusted. Tether records them as *evidence*
(`"readOnly": "hinted"`), never as authority.

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
depend on. The raw schema stays in the lockfile for human review. The differ
never short-circuits on a digest, because lockfiles are meant to be hand-edited
and a hash Tether did not compute cannot be trusted.

**Snapshots are credential-scoped.** MCP allows a `tools/list` result to vary by
the authorization presented. `principalHint` is a non-reversible digest of the
credentials used — never the credential itself. If it doesn't match, Tether
reports a *scope mismatch* rather than inventing hundreds of phantom removals.

## Three surfaces

**CLI** — the primary interface, for a cron and for CI.

```yaml
- run: npx tether-mcp check --out drift.md
```

A ready-made workflow is in [`.github/workflows/tether.yml`](.github/workflows/tether.yml).

**Claude plugin** — so an agent can check drift mid-task.

- Skill `tether` — the agent runs a check, reads the report, and finds the skills
  that reference the affected tools.
- `/tether-check` — drift plus an affected-skills summary.
- `/tether-resolve` — instance drift for declared identifiers.

**MCP server** — so other agents can query drift status.

```bash
npx tether-mcp mcp
```

Exposes three read-only tools: `tether_check_drift`, `tether_list_connectors`,
`tether_affected_skills`. None of them can snapshot, probe, or write — an agent
that could accept drift on its own behalf would defeat the point of a lockfile
being reviewed.

Tether tracks its own MCP server in `.tether/tether.lock.json`. It drifts too.

## Non-goals

Not a security scanner. Not a spec linter. Not a registry or control plane. Not
an evaluator — Tether checks whether a skill's references still resolve, not
whether the skill produces good output.

## Limits worth knowing

- The surface walks top-level parameters only. Drift inside a nested object is
  not yet visible.
- `$ref` is recorded as an opaque type string, so a change *behind* a ref is not
  detected.
- Instance resolution needs a probe that enumerates. Servers that only return one
  prose blob are matched by substring and reported as low confidence.

## Building on it

Requires Node 20+. One dependency: the official MCP SDK. No build step, no
TypeScript, no bundler — `npx tether-mcp` runs the source directly, so a domain
team can fork and patch it without a toolchain.

```bash
npm test    # 72 tests, no network required
```

MIT.
