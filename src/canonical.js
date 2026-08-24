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

/** How deep the walker descends before giving up and saying so. */
export const MAX_SCHEMA_DEPTH = 6;

/** Decode one JSON Pointer token (RFC 6901). */
const decodeToken = (token) => token.replace(/~1/g, '/').replace(/~0/g, '~');

/**
 * Follow a local `$ref` to the node it names.
 *
 * Only same-document refs are followed. A remote or unresolvable ref is
 * reported rather than silently treated as an empty schema, because "we could
 * not see inside this" and "there is nothing inside this" are very different
 * claims for a drift checker to make.
 */
function deref(node, root, seen) {
  let current = node;
  for (let hop = 0; current && typeof current === 'object' && typeof current.$ref === 'string'; hop++) {
    const ref = current.$ref;
    if (seen.has(ref)) return { schema: current, cyclic: ref };
    if (!ref.startsWith('#/') || hop > 10) return { schema: current, unresolved: ref };
    seen.add(ref);
    const target = ref
      .slice(2)
      .split('/')
      .reduce((node, token) => (node == null ? node : node[decodeToken(token)]), root);
    if (target == null || typeof target !== 'object') return { schema: current, unresolved: ref };
    current = target;
  }
  return { schema: current };
}

/**
 * Flatten a JSON Schema into dotted parameter paths.
 *
 *   { fields: { type: object, properties: { teamId, title }, required: [teamId] } }
 *     ->  fields          (object, required per its own parent)
 *         fields.teamId   (string, required)
 *         fields.title    (string, optional)
 *
 * Array element schemas get a `[]` segment, so an array of objects reads as
 * `items[].id`. `required` on an entry means "required within its parent
 * object" -- whether the parent itself is required is that parent's own entry.
 * The two compose, and each is separately checkable.
 */
export function flattenSchema(schema, root = schema, maxDepth = MAX_SCHEMA_DEPTH) {
  const params = {};
  let truncated = false;

  const visit = (node, prefix, depth, seen) => {
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    const { schema: resolved } = deref(node, root, new Set(seen));
    if (!resolved || typeof resolved !== 'object') return;

    const required = new Set(resolved.required ?? []);
    for (const name of Object.keys(resolved.properties ?? {}).sort()) {
      const child = resolved.properties[name];
      const path = prefix ? `${prefix}.${name}` : name;
      const branch = new Set(seen);
      const { schema: target, unresolved, cyclic } = deref(child, root, branch);
      params[path] = {
        type: typeOf(target ?? child),
        required: required.has(name),
        ...(target?.enum ? { enum: target.enum } : {}),
        ...(unresolved ? { unresolvedRef: unresolved } : {}),
        ...(cyclic ? { cyclicRef: cyclic } : {})
      };
      // Descend into the *resolved* node. Passing the raw `$ref` node would
      // make visit dereference it a second time against a branch that already
      // contains that ref, tripping the cycle guard one level too early and
      // hiding the contents of every recursive type.
      if (!unresolved && !cyclic) visit(target ?? child, path, depth + 1, branch);
    }

    if (resolved.items) visit(resolved.items, `${prefix}[]`, depth + 1, new Set(seen));
  };

  visit(schema, '', 0, new Set());
  return { params, truncated };
}

/**
 * The normalized projection the differ actually reads.
 *
 * Diffing raw JSON Schema produces phantom breaking changes, because the same
 * constraint can be written three equivalent ways. The surface reduces a tool
 * to the facts a skill can actually depend on: which parameters exist, their
 * type, whether they are required, and what values they accept.
 */
export function surfaceOf(tool) {
  const schema = tool.inputSchema ?? {};
  const required = [...(schema.required ?? [])].sort();
  const input = flattenSchema(schema, schema);
  // Output fields are flattened the same way, so an array-returning tool --
  // the MCP spec's own `list_users` example -- yields `users[].id` rather than
  // the empty list that made output drift invisible. The spec requires
  // `outputSchema.type` to be `object`, so the array always arrives one level
  // in; a bare `[].id` is handled but no conforming server can produce it.
  const output = tool.outputSchema ? flattenSchema(tool.outputSchema, tool.outputSchema) : { params: {} };
  const outputs = Object.keys(output.params).sort();
  return {
    required,
    params: input.params,
    ...(input.truncated || output.truncated ? { truncated: true } : {}),
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
