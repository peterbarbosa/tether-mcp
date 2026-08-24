# Backlog

Ideas, in rough order of how much they'd change what Tether is worth. Nothing
here is a commitment. Add freely — an idea belongs here when it surfaces, not
when it's ready.

Move an item into [CHANGELOG.md](CHANGELOG.md) under `Unreleased` when it lands.

---

## Known gaps

Things the README already admits. Each is a place Tether under-reports.

- **`$ref` across files or to a remote URL** is recorded as unresolved. Local
  JSON Pointer refs resolve; anything else does not. Following them means
  fetching, which means the differ stops being pure.
- **Out-of-band credentials are invisible to scope checking.** `principalHint`
  is derived from credentials that appear in the MCP config. A connector
  authenticated by a CLI that is already logged in hashes to nothing, so a
  credential change there produces no scope mismatch — the failure mode is
  hundreds of phantom removals looking like real drift.
- **Prose-only probes are weak.** Instance resolution wants a tool that
  enumerates. Servers returning one blob are matched by substring and reported
  as low confidence. Worth deciding whether low confidence should be its own
  status rather than a resolved-with-caveat.
- **Same-named tools across connectors.** An undeclared skill mentioning
  `search` is attributed to every connector exposing one. Declaring
  `connectors:` fixes it; the nudge to declare could be louder in the report.

- **A conforming server cannot return a bare array `outputSchema`.** The MCP
  spec pins `outputSchema.type` to `object`, so output arrays always arrive
  one level in (`users[].id`). The walker handles the bare `[].id` form
  anyway. Harmless, but it is dead defensive code and worth deciding on.

## Near-term

- **Validate against a large, authenticated connector.** Every lockfile we hold
  is a toy: 19 tools across three connectors, zero nested schemas, zero
  authentication, zero paginated responses. Pagination, `principalHint` and the
  deep schema walk have therefore never executed against a real server — they
  are tested, not proven. Doing this first points everything below it at
  reality instead of assumption.
- **Point the fixture server at the HTTP transport.** The fixture is stdio
  only, so it verified the stdio timeout and left the HTTP one exactly as
  unproven as before. Teaching it to serve Streamable HTTP is the cheap way to
  close that, and it is a precondition for the retry work below rather than a
  separate errand.
- **Retries, and a verified HTTP timeout path.** The stdio timeout works:
  measured, a 3s limit aborts a mute server at ~5s. The HTTP path is
  unverified — closing a transport may not abort an in-flight fetch, so a
  stalled remote could hang the Monday job until GitHub's six-hour limit. There
  is no retry either, so one transient failure paints the scheduled run red,
  and a flaky alert gets muted.
- **Version the `tether:` manifest block.** `lockfileVersion` earned its keep
  the moment the surface changed shape. The manifest has no equivalent, and it
  is the schema we are asking other orgs to adopt. Cheap now, awkward once
  anyone depends on it.
- **`tether ack` subcommand.** `check` already prints a paste-ready entry;
  writing it into `acknowledged.json` should not be manual. Keep the reason
  mandatory — the friction that matters is *stating why*, not editing JSON.
- **Report expiring acknowledgements before they lapse.** A lapsed entry
  currently surprises you on the day it breaks the build. Warn at N days.
- **Trusted publishing from CI.** `0.2.0` went out by hand, which meant a 2FA
  prompt and a human at a keyboard. npm is closing the token path after January
  2027, so OIDC on a `v*` tag is the direction anyway — and it brings provenance
  attestation with it. Worth doing before the next release rather than after.
- **`--since` on check.** Diff against a git ref rather than the working
  lockfile, so a PR can report what *this branch* changed.

## Bigger bets

- **Manifest authoring at scale.** Tier 2 is the differentiator and it needs a
  manifest per skill. Nobody hand-writes 500, so the differentiating feature
  currently has no adoption path. This is the one place a model earns its keep —
  a `/tether-manifest` command where the agent already running Tether proposes
  the block and a human reviews it, keeping the tool itself deterministic and
  key-free. Bulk proposal has to stay reviewable, or it becomes exactly the
  rubber stamp `acknowledged.json` was built to avoid.
- **Lockfile readability at scale.** Measured ~1.4 KB per tool, so a 100-tool
  connector is a ~137 KB lockfile and 200 tools is ~273 KB. The README calls the
  lockfile "designed to be read in a pull request". It may well be fine — the
  diff is what gets reviewed, not the whole file — but if it is not, the fixes
  (split the normalized surface from the verbatim schemas, or drop the schemas
  entirely) are format changes, and those get more expensive with every adopter.
  Answer it with data from the validation above rather than by guessing.
- **Drift budgets.** Fail the build on breaking changes but let warnings
  accumulate to a threshold, so a noisy connector doesn't train people to ignore
  the report.
- **Resource and prompt drift.** `resources/list` is snapshotted but the differ
  treats resources thinly compared to tools. Prompts aren't covered at all.
- **A `tether explain <tool>` command.** Show the locked surface, which skills
  reference it, and what changed most recently — the "why is this red" lookup,
  without reading JSON.
- **Suggested patches as an actual diff.** Today `check` suggests an edit in
  prose. A real unified diff against the skill file would be reviewable, and
  reviewable is the whole thesis.
- **Historical drift.** Every snapshot is a point in time and we throw the
  history away. "This tool has changed shape four times this quarter" is a
  different and possibly more useful signal than "it changed today."

## Rejected, and why

Keeping these so we don't relitigate them.

- **Auto-snapshot on green.** Would make the lockfile stop being a reviewed
  artifact. The whole value is that a human looked.
- **A model in the detection path.** Every detection is deterministic today.
  Ambiguity is reported as ambiguity; a model would resolve it by guessing, and
  a confident wrong patch suggestion is worse than an honest removal report.
- **A Tether config file.** Tether reads the MCP config the org already
  maintains. A second copy of the connector list would drift from the first.
- **Write tools on the MCP server.** An agent that can accept drift on its own
  behalf defeats the point of a lockfile being reviewed.
