// The project's core invariant.
//
// Tether may only ever invoke a tool that (1) a skill declared as a probe,
// (2) a human put on the allowlist, and (3) is not being dry-run. These tests
// exist so the guarantee survives edits by people who have not read the brief.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveIdentifier, SKIPPED, DRY_RUN, RESOLVED } from '../src/probe.js';
import { createToolCaller } from '../src/client.js';
import { isAllowed, loadAllowlist, proposeAllowlist } from '../src/allowlist.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** MCP client methods Tether may reach for outside the single gated caller. */
const READ_ONLY_METHODS = new Set([
  'connect', 'close', 'getServerCapabilities', 'getServerVersion', 'listTools', 'listResources'
]);

const FORBIDDEN_ANYWHERE = ['readResource', 'resources/read', 'getPrompt', 'prompts/get'];

function sourceFiles() {
  const files = [];
  for (const dir of ['src', 'bin']) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (name.endsWith('.js')) files.push([dir + '/' + name, readFileSync(join(ROOT, dir, name), 'utf8')]);
    }
  }
  return files;
}

// --- static guarantees ---------------------------------------------------

test('no source file invokes a tool outside the single gated caller', () => {
  for (const [name, text] of sourceFiles()) {
    for (const match of text.matchAll(/\bclient\.(\w+)\s*\(/g)) {
      const method = match[1];
      if (READ_ONLY_METHODS.has(method)) continue;
      assert.ok(
        method === 'callTool' && name === 'src/client.js',
        `${name} calls client.${method}() -- tool invocation belongs only in createToolCaller`
      );
    }
  }
});

test('client.callTool appears exactly once in the codebase', () => {
  const total = sourceFiles().reduce(
    (n, [, text]) => n + [...text.matchAll(/\bclient\.callTool\s*\(/g)].length, 0
  );
  assert.equal(total, 1, 'more than one call site means more than one thing to audit');
});

test('the gated caller checks the allowlist before reaching the client', () => {
  const text = readFileSync(join(ROOT, 'src/client.js'), 'utf8');
  const gate = text.indexOf('isAllowed(allowlist, connectorId, tool)');
  const call = text.indexOf('client.callTool(');
  assert.ok(gate !== -1 && gate < call, 'the allowlist check must precede the call');
});

test('prompt and resource-read methods are never referenced', () => {
  for (const [name, text] of sourceFiles()) {
    for (const forbidden of FORBIDDEN_ANYWHERE) {
      assert.ok(!text.includes(forbidden + '('), `${name} references ${forbidden}`);
    }
  }
});

test('only client.js may open an outbound connection to a server', () => {
  // src/server.js legitimately constructs a *server* transport -- that is
  // Tether being called, not Tether calling out. Only outbound client
  // transports are restricted.
  for (const [name, text] of sourceFiles()) {
    if (name === 'src/client.js') continue;
    assert.ok(
      !/\b\w*ClientTransport\s*\(/.test(text),
      `${name} constructs a client transport; outbound access belongs in client.js`
    );
  }
});

test('the MCP server surface exposes no tool that can write or probe', async () => {
  const text = readFileSync(join(ROOT, 'src/server.js'), 'utf8');
  for (const forbidden of ['snapshotConnector(connector, { write', 'writeLock', 'resolveIdentifier', 'withConnectors']) {
    assert.ok(!text.includes(forbidden), `server.js must not expose ${forbidden}`);
  }
  // Every advertised tool must declare itself read-only, since Tether holds
  // other servers to that standard.
  const { readFileSync: read } = await import('node:fs');
  const source = read(join(ROOT, 'src/server.js'), 'utf8');
  const advertised = [...source.matchAll(/name: '(tether_\w+)'/g)].length;
  const readOnly = [...source.matchAll(/readOnlyHint: true/g)].length;
  assert.equal(advertised, readOnly, 'every exposed tool must declare readOnlyHint: true');
});

// --- behavioural guarantees ----------------------------------------------

/** A callTool that fails the test if it is ever reached. */
const forbiddenCaller = () => {
  throw new Error('SAFETY VIOLATION: a tool was called when it must not have been');
};

const ALLOWED = { connectors: { wiki: { list_pages: { classification: 'read-only' } } } };

test('an unallowlisted probe is skipped without any call being made', async () => {
  const r = await resolveIdentifier(
    { id: 'x', connector: 'wiki', probe: 'delete_page', match: 'path', value: '/a' },
    { allowlist: ALLOWED, callTool: forbiddenCaller }
  );
  assert.equal(r.status, SKIPPED);
  assert.match(r.reason, /allowlist/);
});

test('dry run makes no call even when the probe is allowlisted', async () => {
  const r = await resolveIdentifier(
    { id: 'x', connector: 'wiki', probe: 'list_pages', match: 'path', value: '/a' },
    { allowlist: ALLOWED, callTool: forbiddenCaller, dryRun: true }
  );
  assert.equal(r.status, DRY_RUN);
  assert.deepEqual(r.intended, { tool: 'list_pages', arguments: {} });
});

test('an incomplete declaration is skipped before the allowlist is even consulted', async () => {
  const r = await resolveIdentifier(
    { id: 'x', connector: 'wiki', probe: null, value: '/a' },
    { allowlist: ALLOWED, callTool: forbiddenCaller }
  );
  assert.equal(r.status, SKIPPED);
});

test('an allowlisted probe does get called', async () => {
  let called = null;
  const r = await resolveIdentifier(
    { id: 'x', connector: 'wiki', probe: 'list_pages', match: 'path', value: '/Engineering/API' },
    {
      allowlist: ALLOWED,
      callTool: async (c, t, a) => {
        called = { c, t, a };
        return { structuredContent: { pages: [{ path: '/Engineering/API' }] } };
      }
    }
  );
  assert.deepEqual(called, { c: 'wiki', t: 'list_pages', a: {} });
  assert.equal(r.status, RESOLVED);
});

test('the second gate refuses independently of the resolver', async () => {
  const callTool = createToolCaller(new Map([['wiki', { callTool: forbiddenCaller }]]), ALLOWED);
  await assert.rejects(() => callTool('wiki', 'delete_page', {}), /not on the probe allowlist/);
});

test('a malformed allowlist authorizes nothing', () => {
  const broken = { connectors: null };
  assert.equal(isAllowed(broken, 'wiki', 'list_pages'), false);
  assert.equal(isAllowed(undefined, 'wiki', 'list_pages'), false);
  assert.equal(loadAllowlist('/nonexistent-path-for-test').connectors.wiki, undefined);
});

test('an allowlist entry only authorizes when classified read-only', () => {
  assert.equal(isAllowed({ connectors: { w: { t: { classification: 'unknown' } } } }, 'w', 't'), false);
  assert.equal(isAllowed({ connectors: { w: { t: { classification: 'read-only' } } } }, 'w', 't'), true);
});

test('proposals never authorize anything by themselves', () => {
  const proposal = { connectors: { wiki: { list_pages: { classification: 'read-only', reviewedBy: null } } } };
  // A proposal file is written to allowlist.proposed.json, which loadAllowlist
  // does not read. The only way in is a human editing allowlist.json.
  assert.equal(loadAllowlist(ROOT).connectors.wiki, undefined);
  assert.ok(proposal.connectors.wiki.list_pages.reviewedBy === null);
});

test('credentials are never written into a lockfile', async () => {
  const { principalHint } = await import('../src/config.js');
  const hint = principalHint({ headers: { Authorization: 'Bearer super-secret-token-value' } });
  assert.ok(hint && !hint.includes('secret'), 'principal hint must be a digest, not the credential');
  assert.equal(hint.length, 12);
});
