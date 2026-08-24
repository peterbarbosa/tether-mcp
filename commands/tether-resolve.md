---
description: Check that the instance identifiers skills declare (project keys, wiki paths, channels) still resolve
---

Run `npx tether-mcp resolve --json` in the project root.

Then:

1. If nothing is missing and nothing was skipped, say so in one line and stop.
2. For each **missing** identifier, name the skill that declares it and quote the
   suggested successors. This is the silent failure mode — the skill does not
   error, it just does the wrong thing — so say plainly what would go wrong.
3. For each **skipped** identifier, explain why. If the reason is the allowlist,
   do not work around it: report that a human needs to review the probe and add
   it to `.tether/allowlist.json`.
4. Never call a connector tool yourself to "verify" a result. Tether skipped it
   for a reason, and that reason applies to you too.
5. Do not edit `.tether/allowlist.json`. Authorizing a probe is a human decision.

If the command reports there is no index, run `npx tether-mcp index` first.

$ARGUMENTS
