// The project's core invariant.
//
// Tether must never invoke a tool. Not on a snapshot, not on a check, not when
// resolving an identifier later. These tests assert that no mutating call is
// even reachable from the code -- so the guarantee survives future edits by
// people who have not read the brief.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every MCP client method Tether is permitted to reach for. */
const ALLOWED_CLIENT_METHODS = new Set([
  'connect', 'close',
  'getServerCapabilities', 'getServerVersion',
  'listTools', 'listResources'
]);

/** Method names that invoke server behaviour rather than describe it. */
const FORBIDDEN = ['callTool', 'tools/call', 'readResource', 'resources/read', 'getPrompt', 'prompts/get'];

function sourceFiles() {
  const files = [];
  for (const dir of ['src', 'bin']) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (name.endsWith('.js')) files.push([join(dir, name), readFileSync(join(ROOT, dir, name), 'utf8')]);
    }
  }
  return files;
}

test('no source file references a tool-invoking method', () => {
  for (const [name, text] of sourceFiles()) {
    for (const forbidden of FORBIDDEN) {
      assert.ok(
        !text.includes(forbidden + '('),
        `${name} references ${forbidden} -- Tether must never invoke a tool`
      );
    }
  }
});

test('every client method call is on the read-only allowlist', () => {
  for (const [name, text] of sourceFiles()) {
    for (const match of text.matchAll(/\bclient\.(\w+)\s*\(/g)) {
      assert.ok(
        ALLOWED_CLIENT_METHODS.has(match[1]),
        `${name} calls client.${match[1]}() which is not on the read-only allowlist`
      );
    }
  }
});

test('only client.js may open a transport', () => {
  for (const [name, text] of sourceFiles()) {
    if (name.endsWith('client.js')) continue;
    assert.ok(!/Transport\s*\(/.test(text), `${name} constructs a transport; network access belongs in client.js`);
  }
});

test('credentials are never written into a lockfile', async () => {
  const { principalHint } = await import('../src/config.js');
  const secret = 'Bearer super-secret-token-value';
  const hint = principalHint({ headers: { Authorization: secret } });
  assert.ok(hint && !hint.includes('secret'), 'principal hint must be a digest, not the credential');
  assert.equal(hint.length, 12);
});
