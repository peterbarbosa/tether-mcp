// Acknowledged drift: a reviewed, recorded decision that one specific change is
// fine.
//
// Without this, the only way past a breaking change is `tether snapshot`, which
// accepts *everything* -- including drift nobody looked at. That trains people
// to re-snapshot on red, which is how a checker quietly stops being read. This
// is the narrow escape hatch: it suppresses one named change, it demands a
// reason, and the change still appears in the report so it never disappears.
//
// .tether/acknowledged.json
// {
//   "acknowledgedVersion": 1,
//   "entries": [
//     {
//       "connector": "linear",
//       "type": "param_now_required",
//       "tool": "create_issue",
//       "param": "teamId",
//       "reason": "Our skills already pass teamId; verified in #42.",
//       "acknowledgedBy": "peter",
//       "expires": "2026-12-01"
//     }
//   ]
// }

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LOCK_DIR } from './lock.js';

export const ACKNOWLEDGED_VERSION = 1;
export const acknowledgedPath = (dir) => join(dir, LOCK_DIR, 'acknowledged.json');

/** Fields an entry may match on. Everything else in an entry is documentation. */
const MATCHABLE = ['connector', 'type', 'tool', 'param'];

export function loadAcknowledged(dir) {
  const path = acknowledgedPath(dir);
  if (!existsSync(path)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch (error) {
    // Failing closed means acknowledging nothing, so a broken file surfaces as
    // drift rather than as silence.
    return { entries: [], malformed: error.message };
  }
}

/**
 * Does this entry cover this change?
 *
 * Every field the entry specifies must match. Fields it omits are wildcards,
 * so an entry can cover a whole tool -- but `connector` and `type` are always
 * required, so an entry can never blanket-suppress everything by accident.
 */
export function entryMatches(entry, change, connector, today = null) {
  if (!entry?.connector || !entry?.type) return false;
  if (isExpired(entry, today)) return false;
  const actual = { ...change, connector };
  return MATCHABLE.every((field) => entry[field] === undefined || entry[field] === actual[field]);
}

export function isExpired(entry, today = null) {
  if (!entry?.expires) return false;
  const now = today ?? new Date().toISOString().slice(0, 10);
  return String(entry.expires) < now;
}

/**
 * Split a report's changes into those still outstanding and those a human has
 * signed off. Acknowledged changes keep their severity -- they are still
 * breaking, they are just not news -- so the report can show them plainly.
 */
export function applyAcknowledgements(report, acknowledged, today = null) {
  const entries = acknowledged?.entries ?? [];
  if (!entries.length || !report.changes?.length) return report;

  const outstanding = [];
  const signedOff = [];
  for (const change of report.changes) {
    const entry = entries.find((e) => entryMatches(e, change, report.connector, today));
    if (entry) signedOff.push({ ...change, acknowledgedBy: entry.acknowledgedBy ?? null, reason: entry.reason ?? null });
    else outstanding.push(change);
  }

  return {
    ...report,
    changes: outstanding,
    acknowledged: signedOff,
    breaking: outstanding.filter((c) => c.severity === 'breaking').length
  };
}

/** Entries that have lapsed, so a check can say so rather than quietly re-failing. */
export const expiredEntries = (acknowledged, today = null) =>
  (acknowledged?.entries ?? []).filter((e) => isExpired(e, today));

/**
 * A ready-to-paste entry for a change the user may want to sign off.
 * Cheaper than a `tether ack` subcommand, and it keeps authorship explicit.
 */
export const entryFor = (change, connector) => ({
  connector,
  type: change.type,
  ...(change.tool ? { tool: change.tool } : {}),
  ...(change.param ? { param: change.param } : {}),
  reason: 'WHY THIS IS FINE -- required',
  acknowledgedBy: 'YOUR NAME'
});
