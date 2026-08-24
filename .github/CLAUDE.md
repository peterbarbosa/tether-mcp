# .github/ — CI

Two workflows, with different jobs.

## [workflows/ci.yml](workflows/ci.yml) — ours

- **test** — `npm test` on ubuntu **and** windows, Node 20 and 22. The matrix is
  not habit: lockfiles must be byte-identical across platforms, so the suite
  that asserts it has to run on more than one. Do not trim the OS axis.
- **smoke** — `npm pack`, install the tarball into a scratch project, run
  `npx tether --help` and `npx tether list`. Proves the published entry point
  actually runs without publishing. If you add a file the package needs, update
  `files` in [../package.json](../package.json) or this job catches it.

`npm ci` only, never `npm install` — the lockfile is the point.

## [workflows/tether.yml](workflows/tether.yml) — theirs

The ready-made drift workflow users copy into their own repo. It is
documentation as much as automation, so keep it short and obvious.

It must handle all three exit codes: `0` clean, `1` breaking drift, `2` could
not check. **A workflow that treats "could not check" as green is the exact
failure Tether exists to prevent** — it must be visible in the run, even if it
doesn't fail the build.

## Rules

- Pin actions to a major tag (`@v4`).
- No secrets in the example workflow. Connector credentials are the user's
  business, and a copy-paste template that suggests otherwise teaches badly.
- CI stays offline. No job may require a live MCP server.
