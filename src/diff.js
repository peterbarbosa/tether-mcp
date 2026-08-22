// The schema differ. Pure code -- no model calls, no network, no I/O.
//
// Severity answers one question: would a skill written against the old
// snapshot still do the right thing against the new one?
//   breaking -- no. A call that used to work now fails or silently misbehaves.
//   warning  -- maybe. New capability or loosened constraint; review it.
//   info     -- yes. Cosmetic or additive.

export const BREAKING = 'breaking';
export const WARNING = 'warning';
export const INFO = 'info';

const RANK = { [INFO]: 0, [WARNING]: 1, [BREAKING]: 2 };
const byName = (list) => new Map((list ?? []).map((t) => [t.name ?? t.uri, t]));

/** Compare two lockfile bodies. Returns a report structure, never throws. */
export function diffLocks(before, after) {
  const changes = [];
  const add = (severity, type, fields) => changes.push({ severity, type, ...fields });

  // Scope is checked first. Snapshots taken under different credentials are not
  // comparable -- reporting 200 phantom removals because CI used a service
  // account is exactly how a checker gets switched off.
  const scopeMismatch =
    before.scope?.principalHint !== after.scope?.principalHint ||
    before.scope?.authMode !== after.scope?.authMode;

  if (before.connector?.protocolVersion !== after.connector?.protocolVersion) {
    add(INFO, 'protocol_version_changed', {
      from: before.connector?.protocolVersion, to: after.connector?.protocolVersion
    });
  }
  if (before.connector?.serverInfo?.version !== after.connector?.serverInfo?.version) {
    add(INFO, 'server_version_changed', {
      from: before.connector?.serverInfo?.version, to: after.connector?.serverInfo?.version
    });
  }
  if (after.scope?.complete === false) {
    add(WARNING, 'snapshot_incomplete', {
      detail: 'pagination did not complete; missing tools cannot be distinguished from removed ones'
    });
  }

  const oldTools = byName(before.tools);
  const newTools = byName(after.tools);

  for (const [name, oldTool] of oldTools) {
    const newTool = newTools.get(name);
    if (!newTool) {
      add(BREAKING, 'tool_removed', { tool: name });
      continue;
    }
    // Deliberately no digest fast path. Lockfiles are meant to be reviewed and
    // hand-edited, so a digest Tether did not compute cannot be trusted to mean
    // "nothing moved". Comparing content directly costs microseconds.
    diffTool(name, oldTool, newTool, add);
  }
  for (const name of newTools.keys()) {
    if (!oldTools.has(name)) add(INFO, 'tool_added', { tool: name });
  }

  const oldRes = byName(before.resources);
  const newRes = byName(after.resources);
  for (const uri of oldRes.keys()) if (!newRes.has(uri)) add(BREAKING, 'resource_removed', { resource: uri });
  for (const uri of newRes.keys()) if (!oldRes.has(uri)) add(INFO, 'resource_added', { resource: uri });

  const severity = changes.reduce((worst, c) => (RANK[c.severity] > RANK[worst] ? c.severity : worst), INFO);
  return {
    connector: after.connector?.id ?? before.connector?.id,
    scopeMismatch,
    severity: changes.length ? severity : null,
    breaking: changes.filter((c) => c.severity === BREAKING).length,
    changes
  };
}

function diffTool(name, oldTool, newTool, add) {
  const a = oldTool.surface ?? {};
  const b = newTool.surface ?? {};
  const oldParams = a.params ?? {};
  const newParams = b.params ?? {};

  for (const param of Object.keys(oldParams)) {
    const before = oldParams[param];
    const after = newParams[param];
    if (!after) {
      // A skill that passes this argument now sends an unrecognized field.
      add(BREAKING, 'param_removed', { tool: name, param });
      continue;
    }
    if (before.type !== after.type) {
      add(BREAKING, 'param_type_changed', { tool: name, param, from: before.type, to: after.type });
    }
    if (!before.required && after.required) {
      // The silent one: the agent starts inventing a value for it.
      add(BREAKING, 'param_now_required', { tool: name, param });
    }
    if (before.required && !after.required) {
      add(INFO, 'param_now_optional', { tool: name, param });
    }
    const dropped = (before.enum ?? []).filter((v) => !(after.enum ?? []).includes(v));
    const gained = (after.enum ?? []).filter((v) => !(before.enum ?? []).includes(v));
    if (before.enum && after.enum && dropped.length) {
      add(BREAKING, 'enum_narrowed', { tool: name, param, removed: dropped });
    }
    if (before.enum && after.enum && gained.length) {
      add(WARNING, 'enum_widened', { tool: name, param, added: gained });
    }
    if (before.enum && !after.enum) add(WARNING, 'enum_removed', { tool: name, param });
  }

  for (const param of Object.keys(newParams)) {
    if (oldParams[param]) continue;
    if (newParams[param].required) {
      add(BREAKING, 'param_added_required', { tool: name, param });
    } else {
      add(WARNING, 'param_added_optional', { tool: name, param });
    }
  }

  for (const field of a.outputs ?? []) {
    if (!(b.outputs ?? []).includes(field)) {
      add(BREAKING, 'output_removed', { tool: name, param: field });
    }
  }
  for (const field of b.outputs ?? []) {
    if (!(a.outputs ?? []).includes(field)) add(INFO, 'output_added', { tool: name, param: field });
  }

  // A tool that previously declared itself read-only and no longer does is the
  // "rug pull" shape. Tether never trusts the hint as authority, but a change
  // in what a server claims about itself is always worth a human's attention.
  if (a.readOnly === 'hinted' && b.readOnly !== 'hinted') {
    add(BREAKING, 'readonly_revoked', { tool: name, from: a.readOnly, to: b.readOnly });
  }

  if (oldTool.description !== newTool.description) {
    add(INFO, 'description_changed', { tool: name });
  }
  if (oldTool.title !== newTool.title) {
    add(INFO, 'title_changed', { tool: name, from: oldTool.title, to: newTool.title });
  }
}
