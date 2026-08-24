# test/ — the suite

```bash
npm test    # node --test
```

No framework, no network, no live MCP server. **The suite is offline by design.**
If a change makes a test need a network, the change is wrong — build a fixture.
[helpers.js](helpers.js) has the shared fixture builders; use them rather than
hand-rolling lock bodies.

CI runs on ubuntu **and** windows across Node 20 and 22, because byte-identical
lockfiles across platforms is a claim that needs more than one platform to hold.

## What each file guards

| File | Guards |
| --- | --- |
| [safety.test.js](safety.test.js) | **The safety invariants. Read this first.** |
| [canonical.test.js](canonical.test.js) | Byte-stability, volatile stripping, digests |
| [diff.test.js](diff.test.js) | Severity assignment per change type |
| [rename.test.js](rename.test.js) | Deterministic rename pairing, and refusing to guess |
| [schema-depth.test.js](schema-depth.test.js) | Nested walks, `$ref`, arrays, `truncated` |
| [manifest.test.js](manifest.test.js) | The `tether:` frontmatter spec |
| [skills.test.js](skills.test.js) | Index building, code-fence-only detection |
| [acknowledged.test.js](acknowledged.test.js) | Wildcards, expiry, malformed = acknowledges nothing |
| [cli.test.js](cli.test.js) | The binary as a subprocess — exit codes |
| [regressions.test.js](regressions.test.js) | Every bug we've shipped, once |

## safety.test.js is structural

It does not test behaviour so much as assert facts about the source. It greps
the codebase to prove `client.callTool` appears exactly once, that the allowlist
check precedes it, that the resolver's gates hold against a spy which fails the
suite if reached illegitimately, and that a malformed allowlist authorizes
nothing.

**This is enforced by tests, not by care.** If you refactor `client.js` or
`probe.js` and this file fails, the refactor is the problem — do not relax the
assertion to make it pass. If a legitimate restructuring needs the assertion
reshaped, reshape it to be *at least as strict*, and say so in the commit.

## Adding tests

- A new change type → a case in `diff.test.js` plus its rendered sentence.
- A bug fixed → a case in `regressions.test.js` named for the failure, not the
  fix. The name should describe the wrong behaviour a future reader would
  otherwise reintroduce.
- A new blind spot closed → its own file, the way `schema-depth.test.js` exists.
