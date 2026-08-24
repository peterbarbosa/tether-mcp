# .tether/ — this repo's own lockfiles

Tether tracks its own MCP connectors here. **It drifts too**, and dogfooding is
how we find out that a report reads badly before a user does.

## What's in here

| File | Written by | Committed? |
| --- | --- | --- |
| `<id>.lock.json` | `snapshot` | yes — this is the lockfile |
| `<id>.meta.json` | `snapshot` | yes — provenance sidecar (`capturedAt`) |
| `index.json` | `index` | yes — which skills reference which tools |
| `allowlist.json` | **a human, by hand** | yes — the only probe authorization |
| `allowlist.proposed.json` | `allowlist` | yes — proposals; nothing here is active |
| `acknowledged.json` | **a human, by hand** | yes — reviewed drift decisions |

Currently locked: `deepwiki`, `everything`, `tether` (itself).

## Why provenance is a sidecar

`capturedAt` lives in `<id>.meta.json`, never in the lock body. If a timestamp
lived in the lock, every snapshot would produce a diff even when nothing
changed. **Two snapshots of an unchanged server are byte-identical — a clean
`git diff` means nothing drifted.** That is the entire contract of the format.

## Reviewing a lockfile diff

These files are designed to be read in a pull request. When one changes:

- **A `digest` moved and nothing else did** → the raw schema was reformatted;
  check `surface` to see whether anything a skill depends on actually changed.
- **`scope.principalHint` moved** → the snapshot was taken under different
  credentials. That is a scope mismatch, not drift. Do not merge it as if it
  were; re-snapshot under the right credentials.
- **`scope.complete: false`** → pagination didn't finish. The snapshot is
  partial and merging it will read as removals later.
- **A large snapshot after a `lockfileVersion` bump** → newly-*visible* fields,
  not new fields. Review it on its own commit; it can contain drift that was
  previously invisible.

## Never

- Never regenerate these to make a red `check` go green. `snapshot` accepts
  **everything**, including drift nobody looked at. Accepting one reviewed
  change is an entry in `acknowledged.json` — with a reason and a signer.
- Never hand-edit a lock to change a `digest`. The differ recomputes and never
  trusts a hash it did not produce; hand-editing the body for review is fine.
- Never promote a proposal into `allowlist.json` without reading what the tool
  does. Server annotations nominate; only a human authorizes.

Format and rules: [../src/lock.js](../src/lock.js),
[../src/allowlist.js](../src/allowlist.js),
[../src/acknowledged.js](../src/acknowledged.js).
