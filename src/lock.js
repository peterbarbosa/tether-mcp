// The tether.lock format: read, write, build.
//
// One lockfile per connector, so a noisy connector does not churn a monolith
// and a pull request stays scoped to the thing that changed.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { digest, stripVolatile, surfaceOf } from './canonical.js';

// 2: the surface walks nested objects, resolves $ref, and flattens array
// outputs. A v1 lock cannot be compared against a v2 snapshot -- every nested
// field would read as newly added -- so the differ refuses rather than floods.
export const LOCKFILE_VERSION = 2;
export const LOCK_DIR = '.tether';

export const lockPath = (dir, id) => join(dir, LOCK_DIR, `${id}.lock.json`);
export const metaPath = (dir, id) => join(dir, LOCK_DIR, `${id}.meta.json`);

/** Build a lockfile body from a live snapshot. Pure. */
export function buildLock(snapshot) {
  const tools = [...(snapshot.tools ?? [])]
    .map((raw) => {
      const tool = stripVolatile(raw);
      const surface = surfaceOf(tool);
      return {
        name: tool.name,
        // Covers the derived surface too, not just the raw tool. This is a
        // review aid, not a fast path -- the differ deliberately compares
        // content instead (see diff.js). Including the surface means a change
        // in how Tether derives it shows up as a diff in the pull request,
        // rather than the lock reading as unchanged while its meaning moved.
        digest: digest({ tool, surface }),
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema ?? {},
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        surface
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const resources = [...(snapshot.resources ?? [])]
    .map((raw) => {
      const res = stripVolatile(raw);
      return {
        uri: res.uri,
        digest: digest(res),
        name: res.name,
        description: res.description,
        mimeType: res.mimeType
      };
    })
    .sort((a, b) => a.uri.localeCompare(b.uri));

  return {
    lockfileVersion: LOCKFILE_VERSION,
    connector: {
      id: snapshot.id,
      transport: snapshot.transport,
      target: snapshot.target,
      protocolVersion: snapshot.protocolVersion,
      serverInfo: snapshot.serverInfo ?? {}
    },
    capabilities: snapshot.capabilities ?? {},
    // A tools/list result MAY vary by the authorization presented (MCP
    // 2026-07-28). Two snapshots taken under different credentials are not
    // comparable, so `check` compares scope first and reports a scope mismatch
    // rather than inventing hundreds of phantom removals.
    scope: {
      authMode: snapshot.authMode ?? 'none',
      principalHint: snapshot.principalHint ?? null,
      complete: snapshot.complete !== false
    },
    digest: digest({ tools, resources }),
    tools,
    resources
  };
}

/** Serialize with a stable, diff-friendly shape. */
export const serializeLock = (lock) => JSON.stringify(stripUndefined(lock), null, 2) + '\n';

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = stripUndefined(v);
    return out;
  }
  return value;
}

export function writeLock(dir, lock, meta) {
  mkdirSync(join(dir, LOCK_DIR), { recursive: true });
  writeFileSync(lockPath(dir, lock.connector.id), serializeLock(lock));
  // Provenance is quarantined in a sidecar. If `capturedAt` lived in the lock
  // body, every snapshot would produce a diff even when nothing changed.
  writeFileSync(metaPath(dir, lock.connector.id), JSON.stringify(meta, null, 2) + '\n');
}

export function readLock(dir, id) {
  const path = lockPath(dir, id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Every connector id that has a committed lockfile. */
export function listLocked(dir) {
  const path = join(dir, LOCK_DIR);
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((f) => f.endsWith('.lock.json'))
    .map((f) => f.slice(0, -'.lock.json'.length))
    .sort();
}
