// `src/client.js` against a real MCP server.
//
// Every other test in this suite hands `buildLock` a literal array of tools,
// which means the code that actually produces that array -- connect, walk
// `nextCursor` to exhaustion, decide whether the result is complete -- has
// never run under test. These branches are the ones that matter most when a
// connector is large, and they are precisely the ones a toy lockfile cannot
// reach.
//
// The fixture is a real stdio MCP server (`test/fixtures/mcp-server.js`) driven
// entirely through the connector spec, so these go through `snapshotConnector`
// by the same path production does. Still offline: the transport is a child
// process, not a socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { snapshotConnector } from '../src/client.js';
import { buildLock, serializeLock } from '../src/lock.js';
import { diffLocks } from '../src/diff.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.js', import.meta.url));

// Deliberately unlike any tool or field name in the fixture, so asserting it is
// absent from the lock body cannot pass or fail for an unrelated reason.
const SECRET = 'hunter2-not-a-real-token';

/** A stdio connector spec pointed at the fixture, configured by env. */
const fixture = (env = {}, id = 'fix') => ({
  id,
  transport: 'stdio',
  command: process.execPath,
  args: [FIXTURE],
  // TETHER_FIXTURE=1 is the marker that tells the fixture it was spawned by a
  // test rather than swept up by `node --test`. Without it the fixture exits.
  env: {
    TETHER_FIXTURE: '1',
    ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]))
  },
  target: 'fixture'
});

const snapshot = (env, options) => snapshotConnector(fixture(env), { timeoutMs: 20000, ...options });

// --- pagination ----------------------------------------------------------

test('tools/list is followed across pages until the cursor runs out', async () => {
  const single = await snapshot({ TETHER_FIXTURE_TOOLS: 7 });
  const paged = await snapshot({ TETHER_FIXTURE_TOOLS: 7, TETHER_FIXTURE_PAGE_SIZE: 2 });

  assert.equal(paged.tools.length, 7, 'a paginated list must assemble to the same size');
  assert.equal(paged.complete, true);
  assert.deepEqual(
    paged.tools.map((t) => t.name),
    single.tools.map((t) => t.name),
    'pagination is a transport detail and must not change the surface'
  );
});

test('resources/list is paginated too', async () => {
  const snap = await snapshot({ TETHER_FIXTURE_RESOURCES: 'list', TETHER_FIXTURE_PAGE_SIZE: 1 });
  assert.equal(snap.resources.length, 2);
  assert.equal(snap.complete, true);
});

test('a server that never stops paginating yields an incomplete snapshot, not a short one', async () => {
  // The correctness-critical branch. Without it Tether would lock whatever it
  // managed to read and report every unread tool as removed on the next run --
  // a flood of breaking changes that were never real.
  const snap = await snapshot({ TETHER_FIXTURE_ENDLESS: 1 });

  assert.equal(snap.complete, false, 'hitting the page ceiling must be reported, not swallowed');
  assert.ok(snap.tools.length > 0, 'the partial result is still returned for context');

  const lock = buildLock(snap);
  assert.equal(lock.scope.complete, false, 'incompleteness has to survive into the lockfile');
});

// --- unreachable and unresponsive ---------------------------------------

test('a server that accepts the connection and then stalls fails within the timeout', async () => {
  const started = Date.now();
  await assert.rejects(
    () => snapshot({ TETHER_FIXTURE_MUTE: 1 }, { timeoutMs: 2000 }),
    'a mute server must not hang the run forever'
  );
  // Generous upper bound -- this asserts the timeout fires at all, not its
  // precision. A regression here means a scheduled job hangs until CI kills it.
  assert.ok(Date.now() - started < 15000, 'timeout did not abort the request');
});

test('a server that advertises resources and then refuses them still snapshots', async () => {
  // Common in the wild, and it must degrade to "no resources", not to a failed
  // snapshot -- tool drift is the larger signal and should not be lost with it.
  const snap = await snapshot({ TETHER_FIXTURE_RESOURCES: 'refuse', TETHER_FIXTURE_TOOLS: 4 });
  assert.equal(snap.tools.length, 4);
  assert.deepEqual(snap.resources, []);
  assert.equal(snap.complete, true);
});

test('a server with no resources capability is not asked for resources', async () => {
  const snap = await snapshot({ TETHER_FIXTURE_RESOURCES: 'none' });
  assert.deepEqual(snap.resources, []);
  assert.equal(snap.complete, true);
});

// --- credential scoping --------------------------------------------------

test('a tool set that varies by credential reports scope mismatch, not mass removal', async () => {
  // The failure this prevents: CI runs under a service account that sees fewer
  // tools, and the report claims the connector deleted half its surface.
  const asAdmin = buildLock(await snapshotConnector(
    fixture({ TETHER_FIXTURE_TOKEN: SECRET }), { timeoutMs: 20000 }
  ));
  const anonymous = buildLock(await snapshotConnector(
    fixture({}), { timeoutMs: 20000 }
  ));

  assert.ok(
    asAdmin.tools.some((t) => t.name === 'privileged_audit'),
    'fixture precondition: the credential sees an extra tool'
  );
  assert.ok(!anonymous.tools.some((t) => t.name === 'privileged_audit'));
  assert.notEqual(asAdmin.scope.principalHint, anonymous.scope.principalHint);

  const report = diffLocks(asAdmin, anonymous);
  assert.equal(report.scopeMismatch, true);
  assert.equal(report.breaking, 0, 'a scope mismatch must not be counted as breaking drift');
  assert.deepEqual(report.changes, [], 'the comparison is abandoned before changes are computed');
});

test('principalHint is a digest, never the credential', async () => {
  const lock = buildLock(await snapshotConnector(
    fixture({ TETHER_FIXTURE_TOKEN: SECRET }), { timeoutMs: 20000 }
  ));
  assert.equal(lock.scope.authMode, 'credentialed');
  assert.match(lock.scope.principalHint, /^[0-9a-f]{12}$/);
  assert.ok(!serializeLock(lock).includes(SECRET), 'no credential material in the lock body');
});

// --- the schema walk, against schemas Tether did not author --------------

test('a nested parameter is walked into dotted paths', async () => {
  const lock = buildLock(await snapshot({ TETHER_FIXTURE_SHAPE: 'nested', TETHER_FIXTURE_TOOLS: 1 }));
  const { params } = lock.tools[0].surface;

  assert.equal(params['fields'].required, true);
  assert.equal(params['fields.teamId'].required, true);
  assert.equal(params['fields.title'].required, false);
});

test('a schema deeper than the walker limit is marked truncated', async () => {
  const lock = buildLock(await snapshot({ TETHER_FIXTURE_SHAPE: 'deep', TETHER_FIXTURE_TOOLS: 1 }));
  assert.equal(lock.tools[0].surface.truncated, true, 'under-reporting must be visible');
});

test('a same-document $ref is followed', async () => {
  const lock = buildLock(await snapshot({ TETHER_FIXTURE_SHAPE: 'ref', TETHER_FIXTURE_TOOLS: 1 }));
  const { params } = lock.tools[0].surface;
  assert.equal(params['team.id'].type, 'string', 'the ref target must be walked, not treated as opaque');
  assert.equal(params['team.id'].required, true);
});

test('a ref Tether cannot follow is recorded as unresolved, not as an empty schema', async () => {
  const lock = buildLock(await snapshot({ TETHER_FIXTURE_SHAPE: 'broken-ref', TETHER_FIXTURE_TOOLS: 1 }));
  const entry = lock.tools[0].surface.params['team'];
  assert.equal(entry.unresolvedRef, 'https://example.invalid/schemas/team.json');
});

test('a self-referential schema terminates and says where it stopped', async () => {
  const lock = buildLock(await snapshot({ TETHER_FIXTURE_SHAPE: 'cyclic', TETHER_FIXTURE_TOOLS: 1 }));
  const params = lock.tools[0].surface.params;
  assert.ok(params['root.name'], 'the first level of a recursive type is still visible');
  const cyclic = Object.values(params).find((p) => p.cyclicRef);
  assert.ok(cyclic, 'the recursion has to be recorded rather than silently dropped');
});

test('an array outputSchema flattens to element paths', async () => {
  const lock = buildLock(await snapshot({ TETHER_FIXTURE_SHAPE: 'array-output', TETHER_FIXTURE_TOOLS: 1 }));
  assert.deepEqual(lock.tools[0].surface.outputs, ['users', 'users[].email', 'users[].id']);
});

// --- the format contract -------------------------------------------------

test('two snapshots of an unchanged server are byte-identical', async () => {
  // The invariant the whole format rests on: a clean `git diff` means nothing
  // drifted. Asserted here across two separate server processes and a
  // different page size, so neither timing nor transport chunking can leak in.
  const env = { TETHER_FIXTURE_TOOLS: 5, TETHER_FIXTURE_RESOURCES: 'list', TETHER_FIXTURE_SHAPE: 'nested' };
  const first = serializeLock(buildLock(await snapshot(env)));
  const second = serializeLock(buildLock(await snapshot({ ...env, TETHER_FIXTURE_PAGE_SIZE: 2 })));

  assert.equal(first, second);
});

test('an unchanged server produces no drift end to end', async () => {
  const env = { TETHER_FIXTURE_TOOLS: 4, TETHER_FIXTURE_SHAPE: 'nested' };
  const report = diffLocks(buildLock(await snapshot(env)), buildLock(await snapshot(env)));

  assert.equal(report.breaking, 0);
  assert.deepEqual(report.changes, [], 'a stable server must not manufacture changes');
});

test('a tool that disappears between snapshots is breaking drift', async () => {
  // The end-to-end counterpart to the scope test: same credential, genuinely
  // fewer tools, and this time it *should* report a removal.
  const before = buildLock(await snapshot({ TETHER_FIXTURE_TOOLS: 4 }));
  const after = buildLock(await snapshot({ TETHER_FIXTURE_TOOLS: 3 }));

  const report = diffLocks(before, after);
  assert.ok(!report.scopeMismatch, 'same credential, so scope must not short-circuit');
  const removed = report.changes.filter((c) => c.type === 'tool_removed');
  assert.deepEqual(removed.map((c) => c.tool), ['list_things_3']);
  assert.equal(report.breaking, 1);
});
