import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, digest, stripVolatile, surfaceOf } from '../src/canonical.js';
import { serializeLock } from '../src/lock.js';
import { lockOf, tool } from './helpers.js';

test('canonicalize sorts object keys but preserves array order', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalize({ enum: ['z', 'a'] }), '{"enum":["z","a"]}');
});

test('digest is stable across key insertion order', () => {
  assert.equal(digest({ a: 1, b: { c: 2, d: 3 } }), digest({ b: { d: 3, c: 2 }, a: 1 }));
});

test('volatile cache fields are stripped recursively', () => {
  const out = stripVolatile({ tools: [{ name: 'a', _meta: { x: 1 } }], ttlMs: 300, cacheScope: 'public' });
  assert.deepEqual(out, { tools: [{ name: 'a' }] });
});

test('snapshots round-trip: same server twice produces identical bytes', () => {
  const tools = [tool('b', { y: { type: 'number' } }), tool('a', { x: { required: true } })];
  const first = serializeLock(lockOf(tools));
  const noisy = [...tools].reverse().map((t) => ({ ...t, ttlMs: 12345, cacheScope: 'public' }));
  const second = serializeLock(lockOf(noisy));
  assert.equal(first, second, 'lockfile must be byte-identical when nothing drifted');
});

test('lockfile body contains no provenance or cache fields', () => {
  const text = serializeLock(lockOf([tool('a')]));
  for (const field of ['capturedAt', 'ttlMs', 'cacheScope', 'nextCursor', 'timestamp']) {
    assert.ok(!text.includes(field), 'lock body must not contain ' + field);
  }
});

test('surface normalizes equivalent schema spellings to the same shape', () => {
  const explicit = surfaceOf({ inputSchema: { properties: { a: { type: 'string' } }, required: ['a'] } });
  const union = surfaceOf({ inputSchema: { properties: { a: { anyOf: [{ type: 'string' }] } }, required: ['a'] } });
  assert.deepEqual(explicit.params.a, union.params.a);
});

test('readOnly classification never reports a bare hint as asserted', () => {
  assert.equal(surfaceOf({ annotations: { readOnlyHint: true } }).readOnly, 'hinted');
  assert.equal(surfaceOf({}).readOnly, 'unknown');
});
