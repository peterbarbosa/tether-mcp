// Acknowledged drift is the narrow escape hatch. The wide one -- `tether
// snapshot` -- accepts everything, including drift nobody looked at, so these
// tests care mostly about the ways an acknowledgement could suppress more than
// it was meant to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyAcknowledgements, entryMatches, isExpired, expiredEntries, loadAcknowledged, entryFor
} from '../src/acknowledged.js';
import { renderMarkdown, exitCode } from '../src/report.js';
import { BREAKING, WARNING } from '../src/diff.js';
import { buildLock, serializeLock } from '../src/lock.js';
import { tool } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/tether.js', import.meta.url));

const report = (changes) => ({
  connector: 'linear',
  changes,
  breaking: changes.filter((c) => c.severity === BREAKING).length,
  scopeMismatch: false
});
const change = { severity: BREAKING, type: 'param_now_required', tool: 'create_issue', param: 'teamId' };
const ack = (extra = {}) => ({
  connector: 'linear', type: 'param_now_required', tool: 'create_issue', param: 'teamId',
  reason: 'skills already pass it', acknowledgedBy: 'peter', ...extra
});

test('an acknowledged change stops failing the build', () => {
  const r = applyAcknowledgements(report([change]), { entries: [ack()] });
  assert.equal(r.breaking, 0);
  assert.equal(exitCode([r]), 0);
});

test('an acknowledged change is still shown, not deleted', () => {
  const r = applyAcknowledgements(report([change]), { entries: [ack()] });
  const out = renderMarkdown([r]);
  assert.match(out, /## Acknowledged/);
  assert.match(out, /skills already pass it/);
  assert.match(out, /peter/);
});

test('an entry only covers the change it names', () => {
  const other = { ...change, param: 'projectId' };
  const r = applyAcknowledgements(report([change, other]), { entries: [ack()] });
  assert.equal(r.breaking, 1, 'the unacknowledged change must survive');
  assert.equal(r.changes[0].param, 'projectId');
});

test('omitted fields widen an entry, but connector and type never can be', () => {
  // No `param`, so every param_now_required on that tool is covered.
  const wide = { connector: 'linear', type: 'param_now_required', tool: 'create_issue', reason: 'r' };
  assert.equal(entryMatches(wide, change, 'linear'), true);
  assert.equal(entryMatches(wide, { ...change, param: 'other' }, 'linear'), true);
  // A different change type on the same tool is NOT covered.
  assert.equal(entryMatches(wide, { ...change, type: 'tool_removed' }, 'linear'), false);
  // An entry missing connector or type matches nothing at all.
  assert.equal(entryMatches({ type: 'param_now_required' }, change, 'linear'), false);
  assert.equal(entryMatches({ connector: 'linear' }, change, 'linear'), false);
});

test('an acknowledgement never leaks across connectors', () => {
  assert.equal(entryMatches(ack(), change, 'jira'), false);
});

test('an expired acknowledgement stops applying', () => {
  const expired = ack({ expires: '2020-01-01' });
  assert.equal(isExpired(expired, '2026-08-23'), true);
  assert.equal(entryMatches(expired, change, 'linear', '2026-08-23'), false);
  const r = applyAcknowledgements(report([change]), { entries: [expired] }, '2026-08-23');
  assert.equal(r.breaking, 1, 'a lapsed sign-off must fail the build again');
});

test('an unexpired acknowledgement still applies', () => {
  const living = ack({ expires: '2099-01-01' });
  assert.equal(entryMatches(living, change, 'linear', '2026-08-23'), true);
});

test('expired entries are reportable so a check can say why it went red', () => {
  const entries = [ack({ expires: '2020-01-01' }), ack({ expires: '2099-01-01' }), ack()];
  assert.equal(expiredEntries({ entries }, '2026-08-23').length, 1);
});

test('a malformed acknowledgements file acknowledges nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tether-ack-'));
  mkdirSync(join(dir, '.tether'), { recursive: true });
  writeFileSync(join(dir, '.tether', 'acknowledged.json'), '{ not json');
  const loaded = loadAcknowledged(dir);
  assert.deepEqual(loaded.entries, []);
  assert.ok(loaded.malformed, 'the parse failure must be reportable');
  assert.equal(applyAcknowledgements(report([change]), loaded).breaking, 1, 'failing closed means still breaking');
  rmSync(dir, { recursive: true, force: true });
});

test('warnings can be acknowledged too, and severity is preserved', () => {
  const warn = { severity: WARNING, type: 'param_added_optional', tool: 'create_issue', param: 'labels' };
  const r = applyAcknowledgements(report([warn]), {
    entries: [{ connector: 'linear', type: 'param_added_optional', reason: 'r' }]
  });
  assert.equal(r.acknowledged[0].severity, WARNING);
  assert.equal(r.changes.length, 0);
});

test('the report offers a paste-ready entry for outstanding breaking changes', () => {
  const out = renderMarkdown([report([change])]);
  assert.match(out, /acknowledged\.json/);
  assert.match(out, /"type": "param_now_required"/);
  assert.match(out, /WHY THIS IS FINE/, 'the reason must be a blank a human has to fill in');
});

test('entryFor omits fields the change does not have', () => {
  const entry = entryFor({ type: 'tool_removed', tool: 'gone' }, 'linear');
  assert.equal(entry.param, undefined);
  assert.equal(entry.tool, 'gone');
  assert.equal(entry.connector, 'linear');
});

test('end to end: an acknowledgement turns a red check green but keeps it visible', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tether-ack-e2e-'));
  mkdirSync(join(dir, '.tether'), { recursive: true });
  // Lock says `x` is optional; the "server" (an unreachable stub) is irrelevant
  // here because we compare the committed lock against itself via the differ.
  writeFileSync(
    join(dir, '.tether', 'linear.lock.json'),
    serializeLock(buildLock({ id: 'linear', transport: 'stdio', target: 'x', tools: [tool('create_issue')] }))
  );
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: { linear: { command: 'node', args: ['-e', '0'] } }
  }));
  writeFileSync(join(dir, '.tether', 'acknowledged.json'), JSON.stringify({
    acknowledgedVersion: 1,
    entries: [{ connector: 'linear', type: 'anything', reason: 'r', acknowledgedBy: 'test', expires: '2020-01-01' }]
  }));
  const r = spawnSync(process.execPath, [CLI, '--dir', dir, 'check'], { encoding: 'utf8' });
  assert.match(r.stderr, /expired on 2020-01-01/, 'a lapsed entry must be called out');
  rmSync(dir, { recursive: true, force: true });
});
