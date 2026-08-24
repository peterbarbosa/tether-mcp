import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readManifest, parseYamlSubset, splitFrontmatter, parseToolRef } from '../src/manifest.js';

const SKILL = `---
name: file-a-bug
description: File a bug in the right place.
tether:
  connectors: [linear]
  tools:
    - linear.create_issue
    - linear.list_teams
  identifiers:
    - id: platform-team
      connector: linear
      probe: list_teams
      match: name
      value: Platform
    - id: bug-label
      connector: linear
      probe: list_labels
      match: name
      value: "type: bug"
---

Body text here.
`;

test('frontmatter splits cleanly from the body', () => {
  const [front, body] = splitFrontmatter(SKILL);
  assert.ok(front.includes('name: file-a-bug'));
  assert.equal(body.trim(), 'Body text here.');
});

test('a file without frontmatter is not an error', () => {
  const [front, body] = splitFrontmatter('# Just a doc\n');
  assert.equal(front, null);
  assert.equal(body, '# Just a doc\n');
});

test('manifest reads connectors, tools and identifiers', () => {
  const m = readManifest(SKILL);
  assert.equal(m.name, 'file-a-bug');
  assert.equal(m.declared, true);
  assert.deepEqual(m.connectors, ['linear']);
  assert.deepEqual(m.tools, [
    { connector: 'linear', tool: 'create_issue' },
    { connector: 'linear', tool: 'list_teams' }
  ]);
  assert.equal(m.identifiers.length, 2);
  assert.deepEqual(m.identifiers[0], {
    id: 'platform-team', connector: 'linear', probe: 'list_teams',
    match: 'name', value: 'Platform', args: {}
  });
  assert.deepEqual(m.problems, []);
});

test('quoted scalars keep characters that would otherwise split the line', () => {
  assert.equal(readManifest(SKILL).identifiers[1].value, 'type: bug');
});

test('a skill with no tether block is valid and simply undeclared', () => {
  const m = readManifest('---\nname: plain\n---\nbody\n');
  assert.equal(m.declared, false);
  assert.equal(m.name, 'plain');
  assert.deepEqual(m.problems, []);
});

test('an identifier missing required fields reports a problem instead of throwing', () => {
  const m = readManifest(`---
name: broken
tether:
  identifiers:
    - id: orphan
      match: name
---
`);
  assert.equal(m.identifiers.length, 1);
  assert.ok(m.problems.some((p) => p.includes('orphan')));
  assert.ok(m.problems.some((p) => p.includes('probe')));
});

test('a bare tool reference without a connector is reported', () => {
  const m = readManifest('---\nname: x\ntether:\n  tools:\n    - create_issue\n---\n');
  assert.ok(m.problems.some((p) => p.includes('connector')));
});

test('inline flow sequences and nested args parse', () => {
  const parsed = parseYamlSubset('a: [x, y]\nb:\n  c: 1\n  d: true\n');
  assert.deepEqual(parsed, { a: ['x', 'y'], b: { c: 1, d: true } });
});

test('probe args survive as a map', () => {
  const m = readManifest(`---
name: docs
tether:
  identifiers:
    - id: eng-folder
      connector: wiki
      probe: list_pages
      match: path
      value: /Engineering/API
      args:
        parent: /Engineering
---
`);
  assert.deepEqual(m.identifiers[0].args, { parent: '/Engineering' });
});

test('tool references split on the first dot only', () => {
  assert.deepEqual(parseToolRef('linear.admin.tools.list'), { connector: 'linear', tool: 'admin.tools.list' });
});
