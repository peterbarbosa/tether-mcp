import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLocks, BREAKING, WARNING, INFO } from '../src/diff.js';
import { lockOf, tool } from './helpers.js';

const typesOf = (r) => r.changes.map((c) => c.type);
const find = (r, type) => r.changes.find((c) => c.type === type);

test('identical snapshots produce no changes', () => {
  const t = [tool('a', { x: { required: true } })];
  const r = diffLocks(lockOf(t), lockOf(t));
  assert.deepEqual(r.changes, []);
  assert.equal(r.severity, null);
  assert.equal(r.breaking, 0);
});

test('removed tool is breaking', () => {
  const r = diffLocks(lockOf([tool('a'), tool('b')]), lockOf([tool('a')]));
  assert.equal(find(r, 'tool_removed').severity, BREAKING);
  assert.equal(r.breaking, 1);
});

test('added tool is info, not breaking', () => {
  const r = diffLocks(lockOf([tool('a')]), lockOf([tool('a'), tool('b')]));
  assert.equal(find(r, 'tool_added').severity, INFO);
  assert.equal(r.breaking, 0);
});

test('optional param becoming required is breaking', () => {
  const before = lockOf([tool('a', { x: { required: false } })]);
  const after = lockOf([tool('a', { x: { required: true } })]);
  assert.equal(find(diffLocks(before, after), 'param_now_required').severity, BREAKING);
});

test('new required param is breaking, new optional param is a warning', () => {
  const before = lockOf([tool('a', {})]);
  const required = diffLocks(before, lockOf([tool('a', { x: { required: true } })]));
  const optional = diffLocks(before, lockOf([tool('a', { x: { required: false } })]));
  assert.equal(find(required, 'param_added_required').severity, BREAKING);
  assert.equal(find(optional, 'param_added_optional').severity, WARNING);
});

test('param type change is breaking', () => {
  const before = lockOf([tool('a', { x: { type: 'string' } })]);
  const after = lockOf([tool('a', { x: { type: 'number' } })]);
  const c = find(diffLocks(before, after), 'param_type_changed');
  assert.equal(c.severity, BREAKING);
  assert.deepEqual([c.from, c.to], ['string', 'number']);
});

test('narrowed enum is breaking, widened enum is a warning', () => {
  const before = lockOf([tool('a', { x: { enum: ['p', 'q'] } })]);
  const narrowed = diffLocks(before, lockOf([tool('a', { x: { enum: ['p'] } })]));
  const widened = diffLocks(before, lockOf([tool('a', { x: { enum: ['p', 'q', 'r'] } })]));
  assert.deepEqual(find(narrowed, 'enum_narrowed').removed, ['q']);
  assert.equal(find(narrowed, 'enum_narrowed').severity, BREAKING);
  assert.equal(find(widened, 'enum_widened').severity, WARNING);
});

test('description change alone is info and never fails a build', () => {
  const before = lockOf([tool('a', {}, { description: 'old' })]);
  const after = lockOf([tool('a', {}, { description: 'new' })]);
  const r = diffLocks(before, after);
  assert.deepEqual(typesOf(r), ['description_changed']);
  assert.equal(r.breaking, 0);
});

test('a tool that stops declaring itself read-only is breaking', () => {
  const before = lockOf([tool('a', {}, { annotations: { readOnlyHint: true } })]);
  const after = lockOf([tool('a', {}, { annotations: { readOnlyHint: false } })]);
  assert.equal(find(diffLocks(before, after), 'readonly_revoked').severity, BREAKING);
});

test('differing credentials report a scope mismatch instead of mass removals', () => {
  const before = lockOf([tool('a')], { principalHint: 'alice' });
  const after = lockOf([], { principalHint: 'ci-bot' });
  assert.equal(diffLocks(before, after).scopeMismatch, true);
});

test('an incomplete snapshot warns rather than silently reporting removals', () => {
  const r = diffLocks(lockOf([tool('a')]), lockOf([tool('a')], { complete: false }));
  assert.equal(find(r, 'snapshot_incomplete').severity, WARNING);
});

test('output schema field removal is breaking', () => {
  const withOut = (fields) =>
    tool('a', {}, {
      outputSchema: { properties: Object.fromEntries(fields.map((f) => [f, { type: 'string' }])) }
    });
  const r = diffLocks(lockOf([withOut(['id', 'url'])]), lockOf([withOut(['id'])]));
  assert.equal(find(r, 'output_removed').severity, BREAKING);
});

test('the per-tool digest fast path cannot skip a surface-only change', () => {
  // Regression: the differ reads `surface`, so the digest it short-circuits on
  // must cover the surface. A hand-edited lockfile must still diff correctly.
  const before = lockOf([tool('a', { x: { required: false } })]);
  const after = lockOf([tool('a', { x: { required: false } })]);
  after.tools[0].surface.params.x.required = true; // surface edited, digest untouched
  const r = diffLocks(before, after);
  assert.ok(r.changes.some((c) => c.type === 'param_now_required'), 'must not short-circuit');
});
