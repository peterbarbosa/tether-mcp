# examples/ — skills with manifests

Reference skills showing the `tether:` frontmatter block. They double as live
fixtures: [skills/research-a-repo/SKILL.md](skills/research-a-repo/SKILL.md)
declares real identifiers against the `deepwiki` connector in this repo's
[.mcp.json](../.mcp.json), so `tether index` and `tether resolve` have something
true to run against.

## The manifest shape

```yaml
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
```

Everything under `tether:` is optional. A skill with no manifest still gets
tool-reference checking; the manifest is what unlocks instance resolution and
what turns drift checking from inference into lookup.

## Rules for examples

- **Must be realistic.** An example that nobody would actually write teaches the
  wrong thing.
- **Probes must be genuinely read-only.** These are the shape people copy.
- Declaring `connectors:` resolves the ambiguity when two connectors expose a
  tool with the same name.
- The spec lives in [../src/manifest.js](../src/manifest.js). If it changes,
  these change in the same commit — an example that no longer parses is Tether
  drifting out from under itself.
