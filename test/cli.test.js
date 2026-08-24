// End-to-end tests of the CLI as a user actually runs it: a real subprocess,
// a real project directory, real files on disk. Offline -- no test here needs
// a live MCP server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLock, serializeLock } from '../src/lock.js';
import { tool } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/tether.js', import.meta.url));

const run = (dir, args) =>
  spawnSync(process.execPath, [CLI, '--dir', dir, ...args], { encoding: 'utf8' });

function fixture({ tools = [tool('create_issue', { teamId: { required: true } })], files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tether-cli-'));
  mkdirSync(join(dir, '.tether'), { recursive: true });
  const lock = buildLock({ id: 'linear', transport: 'stdio', target: 'x', tools });
  writeFileSync(join(dir, '.tether', 'linear.lock.json'), serializeLock(lock));
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: { linear: { command: 'node', args: ['-e', 'process.exit(1)'] } }
  }));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

test('--help exits cleanly and documents every command', () => {
  const r = run(process.cwd(), ['--help']);
  assert.equal(r.status, 0);
  for (const command of ['snapshot', 'check', 'list', 'index', 'allowlist', 'resolve', 'mcp']) {
    assert.match(r.stdout, new RegExp('tether ' + command));
  }
});

test('an unknown command exits 2 rather than doing something', () => {
  const r = run(process.cwd(), ['frobnicate']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command/);
});

test('list reports lock status per connector', () => {
  const dir = fixture();
  const r = run(dir, ['list']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[locked\]\s+linear/);
  cleanup(dir);
});

test('check exits 2 when a connector cannot be reached', () => {
  const dir = fixture();
  const r = run(dir, ['check']);
  assert.equal(r.status, 2, 'an unreachable connector must never report all clear');
  assert.match(r.stdout, /unreachable/);
  cleanup(dir);
});

test('index writes a committed index and finds declared references', () => {
  const dir = fixture({
    files: {
      'skills/bug/SKILL.md':
        '---\nname: bug\ntether:\n  connectors: [linear]\n  tools:\n    - linear.create_issue\n---\nbody\n'
    }
  });
  const r = run(dir, ['index']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /1 reference a known tool/);
  const index = JSON.parse(readFileSync(join(dir, '.tether', 'index.json'), 'utf8'));
  assert.equal(index.skills[0].tools[0].tool, 'create_issue');
  cleanup(dir);
});

test('index exits 1 when a skill references a tool that exists nowhere', () => {
  const dir = fixture({
    files: { 'skills/x/SKILL.md': '---\nname: x\ntether:\n  connectors: [linear]\n  tools:\n    - linear.gone\n---\n' }
  });
  const r = run(dir, ['index']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /unknown tool linear\.gone/);
  cleanup(dir);
});

test('allowlist writes proposals to a separate file and authorizes nothing', () => {
  const dir = fixture({ tools: [tool('list_teams'), tool('delete_project')] });
  const r = run(dir, ['allowlist']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /0 tool\(s\) currently authorized/);
  assert.ok(existsSync(join(dir, '.tether', 'allowlist.proposed.json')));
  assert.ok(!existsSync(join(dir, '.tether', 'allowlist.json')), 'proposing must never create the live allowlist');

  const proposal = JSON.parse(readFileSync(join(dir, '.tether', 'allowlist.proposed.json'), 'utf8'));
  assert.ok(proposal.connectors.linear.list_teams, 'an enumerating tool should be nominated');
  assert.equal(proposal.connectors.linear.delete_project, undefined, 'a destructive name must never be nominated');
  cleanup(dir);
});

test('resolve refuses to run without an index', () => {
  const dir = fixture();
  const r = run(dir, ['resolve']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /tether index/);
  cleanup(dir);
});

const IDENTIFIER_SKILL = (probe) =>
  '---\nname: x\ntether:\n  connectors: [linear]\n  identifiers:\n' +
  `    - id: team\n      connector: linear\n      probe: ${probe}\n      match: name\n      value: Platform\n---\n`;

const allow = (dir, tool) =>
  writeFileSync(
    join(dir, '.tether', 'allowlist.json'),
    JSON.stringify({ connectors: { linear: { [tool]: { classification: 'read-only', reviewedBy: 'test' } } } })
  );

test('resolve --dry-run reports intended probes and calls nothing', () => {
  const dir = fixture({ files: { 'skills/x/SKILL.md': IDENTIFIER_SKILL('list_teams') } });
  allow(dir, 'list_teams');
  run(dir, ['index']);
  // The connector command exits immediately, so a real call would error out.
  // A clean dry-run report proves nothing was opened.
  const r = run(dir, ['resolve', '--dry-run']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Dry run/);
  assert.match(r.stdout, /linear\.list_teams/);
  cleanup(dir);
});

test('an unallowlisted probe is skipped even under --dry-run', () => {
  // The allowlist gate runs before the dry-run gate, so the report says what
  // would really happen: nothing, because it was never authorized.
  const dir = fixture({ files: { 'skills/x/SKILL.md': IDENTIFIER_SKILL('list_teams') } });
  run(dir, ['index']);
  const r = run(dir, ['resolve', '--dry-run']);
  assert.match(r.stdout, /Nothing could be confirmed/);
  assert.match(r.stdout, /could not be checked/);
  assert.match(r.stdout, /allowlist/);
  cleanup(dir);
});

test('resolve skips an unallowlisted probe instead of calling it', () => {
  // The connector command here exits immediately, so any real call would fail
  // loudly. A clean skip proves the gate stopped it before the connection.
  const dir = fixture({
    files: {
      'skills/x/SKILL.md':
        '---\nname: x\ntether:\n  connectors: [linear]\n  identifiers:\n' +
        '    - id: team\n      connector: linear\n      probe: drop_database\n      match: name\n      value: Platform\n---\n'
    }
  });
  run(dir, ['index']);
  const r = run(dir, ['resolve']);
  assert.match(r.stdout, /skipped/);
  assert.match(r.stdout, /allowlist/);
  cleanup(dir);
});

test('json output is valid json for every reporting command', () => {
  const dir = fixture({ files: { 'skills/x/SKILL.md': '# x\n' } });
  for (const args of [['list', '--json'], ['index', '--json']]) {
    const r = run(dir, args);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `${args[0]} --json must emit valid JSON`);
  }
  cleanup(dir);
});

test('--out writes the report to a file as well as stdout', () => {
  const dir = fixture();
  const out = join(dir, 'report.md');
  run(dir, ['check', '--out', out]);
  assert.ok(existsSync(out));
  assert.match(readFileSync(out, 'utf8'), /Tether drift report/);
  cleanup(dir);
});
