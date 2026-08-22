// Canonical form + digests. Pure, no I/O.
//
// Everything Tether writes to a lockfile goes through here first, so that two
// snapshots of an unchanged server are byte-identical. That is the whole
// contract of the lock format: a clean `git diff` means nothing drifted.

import { createHash } from 'node:crypto';

// Fields that legitimately change on every response and MUST NOT reach the lock
// body. `ttlMs`/`cacheScope` are cache hints (MCP 2026-07-28); `nextCursor` is
// pagination state; `icons` are cosmetic and often CDN-versioned.
export const VOLATILE_FIELDS = ['ttlMs', 'cacheScope', 'resultType', 'nextCursor', '_meta', 'icons'];

/** Recursively drop volatile fields. */
export function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (VOLATILE_FIELDS.includes(key)) continue;
      out[key] = stripVolatile(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic JSON: object keys sorted, no insignificant whitespace.
 * Array order is preserved -- in JSON Schema, `enum` order can be semantic.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

/** Content address of any value, stable across runs and machines. */
export function digest(value) {
  return 'sha256:' + createHash('sha256').update(canonicalize(value)).digest('hex');
}

/** Human-readable type label for a JSON Schema node. */
function typeOf(schema) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) return [...schema.type].sort().join('|');
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(schema[key])) {
      return [...new Set(schema[key].map(typeOf))].sort().join('|');
    }
  }
  if (schema.enum) return 'enum';
  if (schema.$ref) return 'ref:' + schema.$ref;
  return 'unknown';
}

/**
 * The normalized projection the differ actually reads.
 *
 * Diffing raw JSON Schema produces phantom breaking changes, because the same
 * constraint can be written three equivalent ways. The surface reduces a tool
 * to the facts a skill can actually depend on: which parameters exist, their
 * type, whether they are required, and what values they accept.
 *
 * v0 walks top-level properties only. Nested object drift is v0.2.
 */
export function surfaceOf(tool) {
  const schema = tool.inputSchema ?? {};
  const required = [...(schema.required ?? [])].sort();
  const params = {};
  for (const name of Object.keys(schema.properties ?? {}).sort()) {
    const prop = schema.properties[name];
    params[name] = {
      type: typeOf(prop),
      required: required.includes(name),
      ...(prop?.enum ? { enum: prop.enum } : {})
    };
  }
  const outputs = Object.keys(tool.outputSchema?.properties ?? {}).sort();
  return {
    required,
    params,
    outputs,
    // How confident Tether is that this tool is safe to probe. `readOnlyHint`
    // is server-controlled and the spec says clients MUST treat annotations as
    // untrusted, so it is evidence -- never authority. The resolver (v0.2)
    // requires "asserted", which only a human-reviewed allowlist can grant.
    readOnly: tool.annotations?.readOnlyHint === true ? 'hinted'
      : tool.annotations?.readOnlyHint === false ? 'hinted-false'
      : 'unknown'
  };
}

/**
 * Normalized edit distance, 0..1. Used to pair a removed tool with an added
 * one, and to suggest what a missing identifier may have become.
 */
export function similarity(a, b) {
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  if (x === y) return 1;
  if (!x.length || !y.length) return 0;
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return 1 - previous[y.length] / Math.max(x.length, y.length);
}
