---
name: research-a-repo
description: Look up how a dependency works by reading its documentation wiki before changing code that uses it.
tether:
  connectors: [deepwiki]
  tools:
    - deepwiki.read_wiki_structure
    - deepwiki.ask_question
  identifiers:
    - id: sdk-transports-topic
      connector: deepwiki
      probe: read_wiki_structure
      match: result
      value: Transports
      args:
        repoName: modelcontextprotocol/typescript-sdk
    - id: sdk-retired-topic
      connector: deepwiki
      probe: read_wiki_structure
      match: result
      value: Legacy SSE Migration Guide
      args:
        repoName: modelcontextprotocol/typescript-sdk
---

# Researching a dependency before you change it

When a task touches an unfamiliar dependency, read its wiki before editing.

## Steps

1. Get the list of documentation topics with `read_wiki_structure`, passing the
   `repoName` as `owner/repo`.
2. Find the topic that covers the area you are changing. For the MCP TypeScript
   SDK, transport behaviour is documented under **Transports**.
3. Ask a specific question with `ask_question` rather than reading everything.
4. Quote the answer in your summary so a reviewer can check it.

## Why this skill declares a `tether:` block

Steps 2 names a documentation topic. Topics get renamed and merged, and when
that happens this skill does not error — the agent just fails to find the
section and quietly answers from memory instead.

The `identifiers` block above tells Tether to check, on every run, that those
topics still exist. `tether resolve` reports it when one stops resolving.
