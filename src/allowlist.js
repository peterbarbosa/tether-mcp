// The probe allowlist: the only thing that authorizes Tether to call a tool.
//
// MCP tool annotations are server-controlled and the spec says clients MUST
// treat them as untrusted. So they can nominate a tool for review; they can
// never authorize one. Nothing is probeable until a human has written it into
// `.tether/allowlist.json` and committed that file.
//
// `tether allowlist` writes *proposals* to a separate file. Promoting a
// proposal is a manual edit, on purpose. The friction is the feature.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LOCK_DIR, listLocked, readLock } from './lock.js';

export const ALLOWLIST_VERSION = 1;
export const allowlistPath = (dir) => join(dir, LOCK_DIR, 'allowlist.json');
export const proposalPath = (dir) => join(dir, LOCK_DIR, 'allowlist.proposed.json');

/** Tools whose names read as enumeration or retrieval. Evidence, not proof. */
const READ_PREFIX = /^(list|get|search|read|find|query|describe|fetch|show|lookup|view|count|resolve)[_.-]/i;

/** Names that must never be proposed, whatever the annotations claim. */
const MUTATING_HINT = /(create|update|delete|remove|write|send|post|patch|put|add|set|move|rename|archive|close|merge|deploy|run|exec|invoke|upload|revoke|grant|assign|comment|reply)/i;

export function loadAllowlist(dir) {
  const path = allowlistPath(dir);
  if (!existsSync(path)) return { allowlistVersion: ALLOWLIST_VERSION, connectors: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { allowlistVersion: parsed.allowlistVersion ?? 1, connectors: parsed.connectors ?? {} };
  } catch {
    // A malformed allowlist authorizes nothing. Failing closed is the point.
    return { allowlistVersion: ALLOWLIST_VERSION, connectors: {}, malformed: true };
  }
}

/**
 * The single authorization question. Everything else in Tether that wants to
 * call a tool must route through this, and it defaults to no.
 */
export function isAllowed(allowlist, connector, tool) {
  const entry = allowlist?.connectors?.[connector]?.[tool];
  if (!entry) return false;
  if (entry === true) return true;
  return entry.classification === 'read-only';
}

/**
 * Nominate candidates for a human to review. Returns entries with the evidence
 * that produced them, so the reviewer sees why each one is here.
 */
export function proposeAllowlist(dir) {
  const connectors = {};
  for (const id of listLocked(dir)) {
    const lock = readLock(dir, id);
    const proposed = {};
    for (const tool of lock?.tools ?? []) {
      const hint = tool.annotations?.readOnlyHint;
      if (hint === false || tool.annotations?.destructiveHint === true) continue;
      if (MUTATING_HINT.test(tool.name)) continue;

      const evidence = [];
      if (hint === true) evidence.push('server annotation readOnlyHint: true');
      if (READ_PREFIX.test(tool.name)) evidence.push('name reads as retrieval');
      if (!evidence.length) continue;

      proposed[tool.name] = {
        classification: 'read-only',
        confidence: evidence.length > 1 ? 'high' : 'low',
        evidence,
        reviewedBy: null,
        description: tool.description?.slice(0, 140) ?? null
      };
    }
    if (Object.keys(proposed).length) connectors[id] = proposed;
  }
  return { allowlistVersion: ALLOWLIST_VERSION, connectors };
}

export function writeProposal(dir, proposal) {
  mkdirSync(join(dir, LOCK_DIR), { recursive: true });
  const body = {
    _comment:
      'PROPOSAL ONLY -- Tether will not probe anything in this file. Review each entry, ' +
      'set reviewedBy, and move the ones you trust into allowlist.json.',
    ...proposal
  };
  writeFileSync(proposalPath(dir), JSON.stringify(body, null, 2) + '\n');
}

/** Count of tools a given allowlist actually authorizes. */
export const allowedCount = (allowlist) =>
  Object.values(allowlist?.connectors ?? {}).reduce(
    (n, tools) => n + Object.entries(tools).filter(([, v]) => v === true || v?.classification === 'read-only').length,
    0
  );
