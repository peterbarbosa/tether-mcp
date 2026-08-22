import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, findSkillFiles, affectedSkills } from '../src/skills.js';
import { BREAKING, INFO } from '../src/diff.js';

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'tether-test-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const VOCAB = { linear: new Set(['create_issue', 'list_teams', 'add']) };

test('a declared manifest is authoritative', () => {
  const dir = project({
    'skills/bug/SKILL.md': '---\nname: bug\ntether:\n  connectors: [linear]\n  tools:\n    - linear.create_issue\n---\nbody\n'
  });
  const index = buildIndex(dir, VOCAB);
  assert.equal(index.skills.length, 1);
  assert.equal(index.skills[0].declared, true);
  assert.deepEqual(index.skills[0].tools, [{ connector: 'linear', tool: 'create_issue', source: 'declared' }]);
  rmSync(dir, { recursive: true, force: true });
});

test('a code-formatted tool name is detected without a manifest', () => {
  const dir = project({ 'skills/x/SKILL.md': '# X\n\nCall `create_issue` with the team id.\n' });
  const index = buildIndex(dir, VOCAB);
  assert.deepEqual(index.skills[0].tools, [{ connector: 'linear', tool: 'create_issue', source: 'detected' }]);
  rmSync(dir, { recursive: true, force: true });
});

test('a bare prose word is not treated as a tool reference', () => {
  // `add` is a real tool name. Without this rule every skill containing the
  // word "add" would be flagged against the connector.
  const dir = project({ 'skills/x/SKILL.md': '# X\n\nPlease add a summary at the end.\n' });
  const index = buildIndex(dir, VOCAB);
  assert.deepEqual(index.skills[0].tools, []);
  rmSync(dir, { recursive: true, force: true });
});

test('detection is scoped to declared connectors when a manifest names one', () => {
  const dir = project({
    'skills/x/SKILL.md': '---\nname: x\ntether:\n  connectors: [other]\n---\n\nCall `create_issue`.\n'
  });
  const index = buildIndex(dir, VOCAB);
  assert.deepEqual(index.skills[0].tools, [], 'linear tools must not attach to a skill that declared another connector');
  rmSync(dir, { recursive: true, force: true });
});

test('a declared tool missing from every lockfile is reported as unresolved', () => {
  const dir = project({
    'skills/x/SKILL.md': '---\nname: x\ntether:\n  connectors: [linear]\n  tools:\n    - linear.ghost_tool\n---\n'
  });
  const index = buildIndex(dir, VOCAB);
  assert.deepEqual(index.skills[0].unknownTools, ['linear.ghost_tool']);
  rmSync(dir, { recursive: true, force: true });
});

test('skill discovery walks nested directories and skips node_modules', () => {
  const dir = project({
    'skills/a/SKILL.md': '# a\n',
    'skills/deep/nested/b.md': '# b\n',
    'skills/node_modules/c.md': '# c\n',
    'skills/notes.txt': 'ignored'
  });
  const files = findSkillFiles(dir).map((f) => f.replace(dir, '').replace(/\\/g, '/'));
  assert.equal(files.length, 2);
  assert.ok(!files.some((f) => f.includes('node_modules')));
  rmSync(dir, { recursive: true, force: true });
});

test('affected skills joins drift changes to the skills that reference them', () => {
  const index = {
    skills: [
      { path: 'skills/bug.md', tools: [{ connector: 'linear', tool: 'create_issue' }] },
      { path: 'skills/other.md', tools: [{ connector: 'linear', tool: 'list_teams' }] }
    ]
  };
  const reports = [{
    connector: 'linear',
    changes: [
      { severity: BREAKING, type: 'param_now_required', tool: 'create_issue', param: 'teamId' },
      { severity: INFO, type: 'tool_added', tool: 'brand_new' }
    ]
  }];
  const affected = affectedSkills(index, reports);
  assert.deepEqual([...affected.keys()], ['skills/bug.md']);
  assert.equal(affected.get('skills/bug.md').changes[0].param, 'teamId');
});

test('a change on a different connector does not implicate a same-named tool', () => {
  const index = { skills: [{ path: 'skills/a.md', tools: [{ connector: 'jira', tool: 'create_issue' }] }] };
  const reports = [{ connector: 'linear', changes: [{ severity: BREAKING, type: 'tool_removed', tool: 'create_issue' }] }];
  assert.equal(affectedSkills(index, reports).size, 0);
});

test('a rename implicates skills referencing the OLD name, not the new one', () => {
  // The skill was written against the previous snapshot, so it says the old
  // name. Keying the join on the new name would report nothing at exactly the
  // moment the report matters most.
  const index = {
    skills: [
      { path: 'skills/old.md', tools: [{ connector: 'wiki', tool: 'read_structure' }] },
      { path: 'skills/new.md', tools: [{ connector: 'wiki', tool: 'list_topics' }] }
    ]
  };
  const reports = [{
    connector: 'wiki',
    changes: [{ severity: BREAKING, type: 'tool_renamed', tool: 'read_structure', to: 'list_topics' }]
  }];
  assert.deepEqual([...affectedSkills(index, reports).keys()], ['skills/old.md']);
});

test('the suggested edit for a rename names both sides', async () => {
  const { suggestPatch } = await import('../src/report.js');
  const patch = suggestPatch({ type: 'tool_renamed', tool: 'read_structure', to: 'list_topics' });
  assert.match(patch, /read_structure/);
  assert.match(patch, /list_topics/);
});

test('a change Tether cannot patch honestly returns no suggestion', async () => {
  const { suggestPatch } = await import('../src/report.js');
  assert.equal(suggestPatch({ type: 'description_changed', tool: 'x' }), null);
  assert.equal(suggestPatch({ type: 'tool_added', tool: 'x' }), null);
});
