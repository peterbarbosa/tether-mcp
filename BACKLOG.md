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

## Near-term

- **Assert the plugin version matches package.json in CI.** The one remaining
  hand-maintained version. It is exactly the drift Tether complains about, in
  Tether. See [.claude-plugin/CLAUDE.md](.claude-plugin/CLAUDE.md).
- **`tether ack` subcommand.** `check` already prints a paste-ready entry;
  writing it into `acknowledged.json` should not be manual. Keep the reason
  mandatory — the friction that matters is *stating why*, not editing JSON.
- **Report expiring acknowledgements before they lapse.** A lapsed entry
  currently surprises you on the day it breaks the build. Warn at N days.
- **Publish to npm.** The README carries a run-from-source workaround in place
  of a quick start. Every doc says "read `npx tether-mcp` as `node bin/…`",
  which is a tax on every reader.
- **`--since` on check.** Diff against a git ref rather than the working
  lockfile, so a PR can report what *this branch* changed.

## Bigger bets

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
