// The surface used to walk top-level parameters only. That made three kinds of
// drift completely invisible -- and all three are exactly the failure Tether
// exists to catch: no error, plausible output, wrong result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { surfaceOf, flattenSchema, MAX_SCHEMA_DEPTH } from '../src/canonical.js';
import { diffLocks, BREAKING } from '../src/diff.js';
import { lockOf } from './helpers.js';

const find = (r, type) => r.changes.find((c) => c.type === type);
const withSchema = (name, inputSchema, extra = {}) => ({ name, description: 'a tool', inputSchema, ...extra });

// --- nested objects ------------------------------------------------------

const nested = (required) =>
  withSchema('create_issue', {
    type: 'object',
    properties: {
      fields: {
        type: 'object',
        properties: { teamId: { type: 'string' }, title: { type: 'string' } },
        required
      }
    },
    required: ['fields']
  });

test('a nested field becoming required is breaking', () => {
  const r = diffLocks(lockOf([nested([])]), lockOf([nested(['teamId'])]));
  const change = find(r, 'param_now_required');
  assert.equal(change.severity, BREAKING);
  assert.equal(change.param, 'fields.teamId', 'the report must name the full path');
});

test('nested parameters are flattened to dotted paths', () => {
  const surface = surfaceOf(nested(['teamId']));
  assert.deepEqual(Object.keys(surface.params).sort(), ['fields', 'fields.teamId', 'fields.title']);
  assert.equal(surface.params['fields'].required, true);
  assert.equal(surface.params['fields.teamId'].required, true);
  assert.equal(surface.params['fields.title'].required, false);
});

test('required means required within its parent, which composes', () => {
  // `fields` optional, but teamId required *if* fields is supplied. Both facts
  // are recorded separately so either can drift without hiding the other.
  const surface = surfaceOf(
    withSchema('t', {
      type: 'object',
      properties: {
        fields: { type: 'object', properties: { teamId: { type: 'string' } }, required: ['teamId'] }
      },
      required: []
    })
  );
  assert.equal(surface.params['fields'].required, false);
  assert.equal(surface.params['fields.teamId'].required, true);
});

test('a nested enum narrowing is breaking', () => {
  const withEnum = (values) =>
    withSchema('t', {
      type: 'object',
      properties: { opts: { type: 'object', properties: { mode: { enum: values } } } }
    });
  const r = diffLocks(lockOf([withEnum(['a', 'b'])]), lockOf([withEnum(['a'])]));
  assert.equal(find(r, 'enum_narrowed').param, 'opts.mode');
});

// --- arrays --------------------------------------------------------------

test('array element fields get a [] segment', () => {
  const surface = surfaceOf(
    withSchema('t', {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' } } } } }
    })
  );
  assert.ok('items[].sku' in surface.params);
});

test('an array outputSchema is no longer invisible', () => {
  // This is the MCP specification's own `list_users` example.
  const listUsers = (fields) => ({
    name: 'list_users',
    inputSchema: { type: 'object' },
    outputSchema: {
      type: 'array',
      items: { type: 'object', properties: Object.fromEntries(fields.map((f) => [f, { type: 'string' }])) }
    }
  });
  assert.deepEqual(surfaceOf(listUsers(['id', 'name'])).outputs, ['[].id', '[].name']);
  const r = diffLocks(lockOf([listUsers(['id', 'name', 'email'])]), lockOf([listUsers(['id'])]));
  assert.equal(r.breaking, 2);
  assert.deepEqual(r.changes.map((c) => c.param).sort(), ['[].email', '[].name']);
});

// --- $ref ----------------------------------------------------------------

const refTool = (type) =>
  withSchema('t', {
    type: 'object',
    properties: { a: { $ref: '#/$defs/A' } },
    $defs: { A: { type } }
  });

test('a type change behind a $ref is detected', () => {
  const c = find(diffLocks(lockOf([refTool('string')]), lockOf([refTool('number')])), 'param_type_changed');
  assert.equal(c.severity, BREAKING);
  assert.deepEqual([c.from, c.to], ['string', 'number']);
});

test('a JSON Pointer with escaped tokens resolves', () => {
  const surface = surfaceOf(
    withSchema('t', {
      type: 'object',
      properties: { a: { $ref: '#/$defs/we~1ird' } },
      $defs: { 'we/ird': { type: 'boolean' } }
    })
  );
  assert.equal(surface.params.a.type, 'boolean');
});

test('an unresolvable $ref is reported, not silently treated as empty', () => {
  const surface = surfaceOf(withSchema('t', { type: 'object', properties: { a: { $ref: 'https://elsewhere/x' } } }));
  assert.equal(surface.params.a.unresolvedRef, 'https://elsewhere/x');
});

test('a self-referential $ref terminates instead of hanging', () => {
  const surface = surfaceOf(
    withSchema('t', {
      type: 'object',
      properties: { node: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } }
    })
  );
  assert.ok('node' in surface.params);
  assert.ok(surface.params['node.child']?.cyclicRef, 'the cycle must be recorded, not followed');
});

// --- depth ---------------------------------------------------------------

test('a schema deeper than the cap is marked truncated rather than silently cut', () => {
  let deep = { type: 'string' };
  for (let i = 0; i < MAX_SCHEMA_DEPTH + 3; i++) deep = { type: 'object', properties: { down: deep } };
  const surface = surfaceOf(withSchema('t', deep));
  assert.equal(surface.truncated, true, 'under-reporting must be visible');
});

test('a shallow schema is not marked truncated', () => {
  assert.equal(surfaceOf(nested(['teamId'])).truncated, undefined);
});

test('flattenSchema on an empty schema yields nothing and does not throw', () => {
  assert.deepEqual(flattenSchema({}).params, {});
  assert.deepEqual(flattenSchema({ type: 'object' }).params, {});
});

// --- lockfile version ----------------------------------------------------

test('a v1 lockfile is refused rather than compared against a v2 snapshot', () => {
  const current = lockOf([nested(['teamId'])]);
  const old = { ...lockOf([nested(['teamId'])]), lockfileVersion: 1 };
  const r = diffLocks(old, current);
  assert.deepEqual(r.lockfileOutdated, { from: 1, to: 2 });
  assert.deepEqual(r.changes, [], 'comparing across formats would flood the report with phantom additions');
  assert.equal(r.breaking, 0);
});
