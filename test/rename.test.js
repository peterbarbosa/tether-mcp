import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLocks, BREAKING } from '../src/diff.js';
import { lockOf, tool } from './helpers.js';

const find = (r, type) => r.changes.find((c) => c.type === type);

test('a tool whose surface is unchanged but name changed is reported as a rename', () => {
  const before = lockOf([tool('create_issue', { teamId: { required: true }, title: { required: true } })]);
  const after = lockOf([tool('createIssue', { teamId: { required: true }, title: { required: true } })]);
  const r = diffLocks(before, after);
  const renamed = find(r, 'tool_renamed');
  assert.equal(renamed.severity, BREAKING, 'a rename still breaks skills calling the old name');
  assert.equal(renamed.to, 'createIssue');
  assert.equal(renamed.confidence, 'high');
  assert.equal(find(r, 'tool_added'), undefined, 'the successor must not also be reported as new');
  assert.equal(find(r, 'tool_removed'), undefined);
});

test('unrelated removal and addition are not paired into a false rename', () => {
  const before = lockOf([tool('delete_everything', { confirm: { type: 'boolean', required: true } })]);
  const after = lockOf([tool('search_wiki', { query: { required: true }, limit: { type: 'number' } })]);
  const r = diffLocks(before, after);
  assert.ok(find(r, 'tool_removed'), 'must stay a removal');
  assert.ok(find(r, 'tool_added'));
  assert.equal(find(r, 'tool_renamed'), undefined);
});

test('ambiguous identical surfaces are not paired', () => {
  // Two removed and two added tools all share an empty surface. Guessing which
  // maps to which would produce a confident and wrong patch suggestion.
  const before = lockOf([tool('alpha'), tool('beta')]);
  const after = lockOf([tool('gamma'), tool('delta')]);
  const r = diffLocks(before, after);
  assert.equal(find(r, 'tool_renamed'), undefined);
  assert.equal(r.changes.filter((c) => c.type === 'tool_removed').length, 2);
});

test('a close name with the same parameters pairs as a likely rename', () => {
  const before = lockOf([tool('list_pages', { parent: {} }), tool('other', { z: {} })]);
  const after = lockOf([tool('list_page', { parent: {} }), tool('other', { z: {} })]);
  const renamed = find(diffLocks(before, after), 'tool_renamed');
  assert.equal(renamed.to, 'list_page');
});

test('renames are still counted as breaking for the exit code', () => {
  const before = lockOf([tool('a_tool', { x: { required: true } })]);
  const after = lockOf([tool('b_tool', { x: { required: true } })]);
  assert.equal(diffLocks(before, after).breaking, 1);
});
