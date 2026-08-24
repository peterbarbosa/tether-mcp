// Regression tests for bugs found by auditing the finished v0.1.
//
// Every one of these was a *silent* wrong answer -- a green exit code, a
// summary that contradicted its own body, or a stale artifact that made the
// MCP server deny a reference that plainly existed. Those are the failures that
// matter most in an auditing tool, because nobody goes looking for them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffLocks } from '../src/diff.js';
import { exitCode, renderMarkdown, renderResolveMarkdown, renderResolveJson, resolveExitCode } from '../src/report.js';
import { buildIndex, indexStaleness } from '../src/skills.js';
import { loadConnectors } from '../src/config.js';
import { MISSING, ERROR, SKIPPED, RESOLVED } from '../src/probe.js';
import { buildLock, serializeLock } from '../src/lock.js';
import { lockOf, tool } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/tether.js', import.meta.url));
const run = (dir, args) => spawnSync(process.execPath, [CLI, '--dir', dir, ...args], { encoding: 'utf8' });
const temp = () => mkdtempSync(join(tmpdir(), 'tether-reg-'));
const write = (dir, path, content) => {
  const full = join(dir, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
};

// --- a scope mismatch must not manufacture drift -------------------------

test('a scope mismatch suppresses phantom changes entirely, not just in the render', () => {
  const before = lockOf([tool('a'), tool('b'), tool('c')], { principalHint: 'alice', authMode: 'credentialed' });
  const after = lockOf([], { principalHint: 'ci-bot', authMode: 'credentialed' });
  const r = diffLocks(before, after);
  assert.equal(r.scopeMismatch, true);
  assert.deepEqual(r.changes, [], 'changes computed under a mismatch are not real');
  assert.equal(r.breaking, 0, 'a phantom removal must never reach the breaking count');
});

test('a scope mismatch exits 2 (could not check), never 0 or 1', () => {
  const r = diffLocks(
    lockOf([tool('a')], { principalHint: 'alice', authMode: 'credentialed' }),
    lockOf([], { principalHint: 'ci-bot', authMode: 'credentialed' })
  );
  assert.equal(exitCode([r]), 2, 'not comparable is not a pass, and not a breakage either');
});

test('the summary never counts a connector it could not compare', () => {
  const clean = diffLocks(lockOf([tool('a')]), lockOf([tool('a')]));
  const broken = { connector: 'z', changes: [], breaking: 0, error: 'Could not reach connector' };
  const out = renderMarkdown([clean, broken]);
  assert.match(out, /1 connector could not be checked/);
  assert.ok(!/All 2 connectors match/.test(out), 'an unreachable connector must not be reported as matching');
});

// --- the resolver must not report a failed probe as a pass ---------------

test('an errored probe is never counted as resolved', () => {
  const results = [{ id: 'a', connector: 'c', probe: 'p', value: 'v', status: ERROR, reason: 'unreachable' }];
  const out = renderResolveMarkdown(results);
  assert.match(out, /Nothing could be confirmed/);
  assert.ok(!/still resolve/.test(out), 'a failed probe confirmed nothing');
});

test('an errored probe exits 2, a missing identifier exits 1', () => {
  const base = { id: 'a', connector: 'c', probe: 'p', value: 'v' };
  assert.equal(resolveExitCode([{ ...base, status: ERROR }]), 2);
  assert.equal(resolveExitCode([{ ...base, status: MISSING, candidates: 0 }]), 1);
  assert.equal(resolveExitCode([{ ...base, status: RESOLVED }]), 0);
  assert.equal(resolveExitCode([{ ...base, status: SKIPPED, reason: 'x' }]), 0, 'a reported refusal is not a failure');
});

test('resolve --json exposes every outcome, not only missing', () => {
  const base = { id: 'a', connector: 'c', probe: 'p', value: 'v' };
  const json = JSON.parse(renderResolveJson([
    { ...base, status: RESOLVED }, { ...base, status: ERROR }, { ...base, status: SKIPPED, reason: 'x' }
  ]));
  assert.deepEqual(
    { missing: json.missing, resolved: json.resolved, skipped: json.skipped, errors: json.errors },
    { missing: 0, resolved: 1, skipped: 1, errors: 1 }
  );
});

test('the resolve summary agrees with its own body', () => {
  const base = { id: 'a', connector: 'c', probe: 'p', value: 'v' };
  const out = renderResolveMarkdown([
    { ...base, id: 'ok', status: RESOLVED }, { ...base, id: 'bad', status: ERROR, reason: 'boom' }
  ]);
  assert.match(out, /1 identifier still resolves/);
  assert.match(out, /1 identifier could not be checked \(0 skipped, 1 errored\)/);
});

// --- the index must be reproducible and know when it is stale ------------

test('the index records the roots it scanned so a plain re-run reproduces it', () => {
  const dir = temp();
  write(dir, 'examples/skills/x/SKILL.md', '# x\n\nCall `create_issue`.\n');
  const vocab = { linear: new Set(['create_issue']) };
  const built = buildIndex(dir, vocab, undefined, ['examples/skills']);
  assert.deepEqual(built.roots, ['examples/skills']);
  rmSync(dir, { recursive: true, force: true });
});

test('the index knows when the lockfiles moved underneath it', () => {
  const dir = temp();
  const built = buildIndex(dir, { linear: new Set(['a', 'b']) }, []);
  assert.deepEqual(indexStaleness(built, { linear: new Set(['a', 'b']) }), [], 'unchanged locks are not stale');
  assert.match(indexStaleness(built, { linear: new Set(['a']) })[0], /changed tools/);
  assert.match(indexStaleness(built, { linear: new Set(['a', 'b']), jira: new Set(['x']) })[0], /locked after/);
  assert.match(indexStaleness(built, {})[0], /no longer has a lockfile/);
  rmSync(dir, { recursive: true, force: true });
});

test('a plain `tether index` re-run does not drop skills from custom roots', () => {
  const dir = temp();
  mkdirSync(join(dir, '.tether'), { recursive: true });
  writeFileSync(
    join(dir, '.tether', 'linear.lock.json'),
    serializeLock(buildLock({ id: 'linear', transport: 'stdio', target: 'x', tools: [tool('create_issue')] }))
  );
  write(dir, '.mcp.json', JSON.stringify({ mcpServers: { linear: { command: 'node', args: ['-e', '0'] } } }));
  write(dir, 'examples/skills/x/SKILL.md', '# x\n\nCall `create_issue`.\n');

  run(dir, ['index', '--skills', 'examples/skills']);
  const first = JSON.parse(readFileSync(join(dir, '.tether', 'index.json'), 'utf8'));
  assert.equal(first.skills.length, 1);

  run(dir, ['index']); // no flags -- must reuse the recorded roots
  const second = JSON.parse(readFileSync(join(dir, '.tether', 'index.json'), 'utf8'));
  assert.equal(second.skills.length, 1, 'a plain re-run silently dropping skills makes every consumer wrong');
  assert.deepEqual(second.roots, first.roots);
  rmSync(dir, { recursive: true, force: true });
});

// --- CLI must not exit 0 on things it did not actually check -------------

test('checking a connector with no lockfile fails instead of passing silently', () => {
  const dir = temp();
  mkdirSync(join(dir, '.tether'), { recursive: true });
  writeFileSync(
    join(dir, '.tether', 'locked.lock.json'),
    serializeLock(buildLock({ id: 'locked', transport: 'stdio', target: 'x', tools: [tool('a')] }))
  );
  write(dir, '.mcp.json', JSON.stringify({
    mcpServers: { locked: { command: 'node', args: ['-e', '0'] }, unlocked: { command: 'node', args: ['-e', '0'] } }
  }));
  const r = run(dir, ['check', 'unlocked']);
  assert.equal(r.status, 2, 'checking nothing must never be a green build');
  assert.match(r.stderr, /no lockfile for: unlocked/);
  rmSync(dir, { recursive: true, force: true });
});

test('a malformed MCP config is reported, not silently treated as empty', () => {
  const dir = temp();
  write(dir, '.mcp.json', '{ this is not json');
  const connectors = loadConnectors(dir);
  assert.equal(connectors.length, 0);
  assert.equal(connectors.unreadable.length, 1, 'a parse error must be recoverable by the caller');

  const r = run(dir, ['list']);
  assert.match(r.stderr, /could not read/, 'the user must be told their config is broken');
  rmSync(dir, { recursive: true, force: true });
});

test('check warns when the skill index is stale', () => {
  const dir = temp();
  mkdirSync(join(dir, '.tether'), { recursive: true });
  writeFileSync(
    join(dir, '.tether', 'linear.lock.json'),
    serializeLock(buildLock({ id: 'linear', transport: 'stdio', target: 'x', tools: [tool('a'), tool('b')] }))
  );
  write(dir, '.mcp.json', JSON.stringify({ mcpServers: { linear: { command: 'node', args: ['-e', '0'] } } }));
  run(dir, ['index']);
  // The connector gains a tool; the index still describes the old surface.
  writeFileSync(
    join(dir, '.tether', 'linear.lock.json'),
    serializeLock(buildLock({ id: 'linear', transport: 'stdio', target: 'x', tools: [tool('a'), tool('b'), tool('c')] }))
  );
  const r = run(dir, ['check']);
  assert.match(r.stderr, /skill index is stale/);
  rmSync(dir, { recursive: true, force: true });
});
