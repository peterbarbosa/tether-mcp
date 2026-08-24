# Tether

**Know when your MCP connectors drift out from under your agent skills.**

Agent skills are Markdown procedures that reference tools, parameters, project
keys and folder paths. All of that changes underneath them, and nothing tells
you when it does. A skill whose world moved doesn't error — it quietly does the
wrong thing, and the output still looks plausible.

Tether is the lockfile layer for that problem:

> `tools/list` is the lockfile. `tether check` is `npm outdated`. A skill whose
> references no longer resolve is a broken build.

Read [README.md](README.md) for the full product story. This file is for
navigating the repo.

## The two tiers

| Tier | Question | Detected by | Modules |
| --- | --- | --- | --- |
| **1 — schema drift** | Did the tool's *shape* change? | diffing `tools/list` snapshots | [snapshot](src/lock.js), [diff](src/diff.js) |
| **2 — instance drift** | Does the *thing* the skill assumes still exist? | probing a declared, allowlisted read-only tool | [manifest](src/manifest.js), [probe](src/probe.js), [allowlist](src/allowlist.js) |

Tier 2 is the silent tier. MCP introspects capabilities, not instances:
`tools/list` says `update_page(path, content)` exists and nothing about whether
`/Engineering/API` still does.

## Repo map

| Path | What lives there |
| --- | --- |
| [bin/](bin/) | The CLI — arg parsing, command dispatch, exit codes |
| [src/](src/) | Everything else. Small single-purpose ES modules |
| [test/](test/) | `node --test`. Offline by design |
| [skills/](skills/) | The `tether` agent skill shipped with the plugin |
| [commands/](commands/) | `/tether-check`, `/tether-resolve` slash commands |
| [examples/](examples/) | Example skills with `tether:` manifests |
| [.tether/](.tether/) | This repo's own lockfiles. Tether tracks itself |
| [.claude-plugin/](.claude-plugin/) | Claude plugin manifest |
| [.github/](.github/) | CI and the reusable drift workflow |

## Three surfaces, one core

The CLI ([bin/tether.js](bin/tether.js)), the MCP server
([src/server.js](src/server.js)) and the Claude plugin all call the same pure
functions in `src/`. When adding behaviour, put it in `src/` and let the
surfaces thin-wrap it — never implement a rule in a surface.

## Invariants — do not break these

1. **Byte-stable lockfiles.** Two snapshots of an unchanged server are
   byte-identical. A clean `git diff` means nothing drifted. Provenance
   (`capturedAt`) lives in a `.meta.json` sidecar, never in the lock body.
2. **One call site for `callTool`.** Tool invocation exists exactly once, in
   [src/client.js](src/client.js). `test/safety.test.js` greps the whole
   codebase to assert it.
3. **Three gates before any probe**, in order: a skill declared it → a human
   allowlisted it → it is not a dry run. Two independent gates enforce this
   (resolver and client) and they deliberately share no code.
4. **Annotations are evidence, never authority.** `readOnlyHint` is
   server-controlled; the MCP spec says treat it as untrusted. It can nominate
   a tool for review; only a committed `allowlist.json` authorizes one.
5. **"Could not check" is not a pass.** Exit `2` exists for unreachable
   connectors, missing lockfiles and scope mismatches. Never collapse it into
   `0` or `1`.
6. **Under-reporting must be visible.** An unresolvable `$ref` is recorded as
   unresolved; a schema past the depth limit is marked `truncated`. Silence is
   never allowed to look like cleanliness.
7. **No model in the core.** Every detection is deterministic. Ambiguity is
   reported as ambiguity, not resolved by guessing.

## Exit codes

`0` clean · `1` breaking drift / unresolved identifier · `2` could not check

## Working agreements

- **Commit often, commit early.** Small commits that each leave the suite green.
- **Simplest solution that scales.** No dependency, no build step, no
  TypeScript unless the problem genuinely demands it. One dep today: the MCP SDK.
- **Brainstorm first.** We're collaborators. Argue the design before writing it;
  disagreement is the point.
- **Keep [BACKLOG.md](BACKLOG.md) alive.** Ideas go there when they surface, not
  when they're ready.
- **Keep [CHANGELOG.md](CHANGELOG.md) honest.** Every user-visible change lands
  under `Unreleased` in the same commit that makes it.
- **Coherence over speed.** When iteration causes drift in naming, structure or
  shapes, realigning is the work — not a distraction from it.

## Commands

```bash
npm test                     # node --test, no network required
node bin/tether.js --help
node bin/tether.js list      # what Tether can see
node bin/tether.js snapshot  # capture the surface into .tether/
node bin/tether.js check     # diff live state against the lockfile
node bin/tether.js index     # which skills reference which tools
node bin/tether.js allowlist # propose probeable tools for human review
node bin/tether.js resolve --dry-run
```

Not published to npm yet — read every `npx tether-mcp` in the docs as
`node bin/tether.js`.

## House style

Node 20+, ESM, no build step. Every module opens with a comment explaining *why
it exists and what it refuses to do*, not what it does — the code says that.
Match that density; it is the repo's most valuable documentation.
