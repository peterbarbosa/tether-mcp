// The resolver: does the instance a skill assumes still exist?
//
// This is the only module in Tether permitted to call a tool, and it is written
// to refuse by default. Every call passes three gates, in order:
//
//   1. The skill must have DECLARED the probe in its manifest. Tether never
//      picks a tool to call on its own.
//   2. The probe must be on the human-reviewed allowlist. Server annotations
//      cannot put it there.
//   3. Dry run must be off. `--dry-run` records the intended call and returns
//      without making it.
//
// Anything uncertain is skipped and reported, never guessed. A drift auditor
// that files a ticket while auditing is worse than no auditor.

import { isAllowed } from './allowlist.js';
import { similarity } from './canonical.js';

export const RESOLVED = 'resolved';
export const MISSING = 'missing';
export const SKIPPED = 'skipped';
export const ERROR = 'error';
export const DRY_RUN = 'dry-run';

/** Collect every value stored under `key`, anywhere in a nested result. */
export function collectValues(node, key, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectValues(item, key, found);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === key && (typeof v === 'string' || typeof v === 'number')) found.push(String(v));
      else collectValues(v, key, found);
    }
  }
  return found;
}

/** Pull the most structured representation available out of a tool result. */
export function candidatesFrom(result, matchKey) {
  if (result?.structuredContent !== undefined) {
    const values = collectValues(result.structuredContent, matchKey);
    if (values.length) return { values, evidence: 'structuredContent' };
  }
  const text = (result?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (text) {
    try {
      const values = collectValues(JSON.parse(text), matchKey);
      if (values.length) return { values, evidence: 'parsed text content' };
    } catch {
      // Not JSON. Fall through to the weakest evidence tier.
    }
    return { values: [], evidence: 'unstructured text', text };
  }
  return { values: [], evidence: 'empty result' };
}

/** The closest few candidates, for a "did it move?" suggestion. */
export const nearest = (value, values, limit = 3) =>
  values
    .map((candidate) => ({ candidate, score: similarity(value, candidate) }))
    .filter((c) => c.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

/**
 * Resolve one declared identifier against a live connector.
 *
 * `callTool` is injected rather than imported so that the gates can be tested
 * against a spy that fails the suite if it is ever reached illegitimately.
 */
export async function resolveIdentifier(identifier, { allowlist, callTool, dryRun = false }) {
  const base = { id: identifier.id, connector: identifier.connector, probe: identifier.probe, value: identifier.value };

  if (!identifier.probe || !identifier.connector || identifier.value == null) {
    return { ...base, status: SKIPPED, reason: 'incomplete declaration; needs connector, probe and value' };
  }
  if (!isAllowed(allowlist, identifier.connector, identifier.probe)) {
    return {
      ...base,
      status: SKIPPED,
      reason: `\`${identifier.probe}\` is not on the probe allowlist. Review it and add it to .tether/allowlist.json.`
    };
  }
  if (dryRun) {
    return { ...base, status: DRY_RUN, intended: { tool: identifier.probe, arguments: identifier.args ?? {} } };
  }

  let result;
  try {
    result = await callTool(identifier.connector, identifier.probe, identifier.args ?? {});
  } catch (error) {
    return { ...base, status: ERROR, reason: error.message };
  }
  if (result?.isError) {
    const text = (result.content ?? []).map((c) => c.text).join(' ');
    return { ...base, status: ERROR, reason: text || 'probe returned an error' };
  }

  const { values, evidence, text } = candidatesFrom(result, identifier.match ?? 'name');

  if (!values.length) {
    // No structured field to compare. Say so rather than inventing a verdict.
    if (text && text.includes(String(identifier.value))) {
      return { ...base, status: RESOLVED, evidence: 'unstructured text match', confidence: 'low' };
    }
    return {
      ...base,
      status: SKIPPED,
      reason: `probe returned no \`${identifier.match ?? 'name'}\` field to compare (${evidence})`
    };
  }

  const target = String(identifier.value);
  if (values.includes(target)) {
    return { ...base, status: RESOLVED, evidence, confidence: 'high', candidates: values.length };
  }

  // Many real servers return one long prose or Markdown blob rather than a
  // clean list. Containment inside such a blob is genuine evidence, but much
  // weaker than an exact match against an enumerated value -- so it is reported
  // as low confidence rather than quietly treated the same.
  const blob = values.find((v) => v.length > 200 && v.includes(target));
  if (blob) {
    return { ...base, status: RESOLVED, evidence: `${evidence} (substring)`, confidence: 'low', candidates: values.length };
  }

  return { ...base, status: MISSING, evidence, candidates: values.length, suggestions: nearest(identifier.value, values) };
}
