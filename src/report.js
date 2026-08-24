// Rendering and exit codes. Pure -- takes reports, returns strings.

import { BREAKING, WARNING } from './diff.js';
import { affectedSkills } from './skills.js';
import { RESOLVED, MISSING, SKIPPED, ERROR, DRY_RUN } from './probe.js';
import { entryFor } from './acknowledged.js';

const ICON = { breaking: '🔴', warning: '🟡', info: '⚪' };
const code = (v) => '`' + v + '`';

/** One change, as a sentence a human can act on without reading the lockfile. */
export function describe(c) {
  const t = c.tool ? code(c.tool) : '';
  const p = c.param ? code(c.param) : '';
  switch (c.type) {
    case 'tool_removed': return `Tool ${t} no longer exists. Any skill that calls it will fail.`;
    case 'tool_renamed': return `Tool ${t} appears to have been renamed to ${code(c.to)} (${c.confidence} confidence).`;
    case 'tool_added': return `New tool ${t} is available.`;
    case 'param_removed': return `${t} no longer accepts ${p}. Calls passing it may be rejected.`;
    case 'param_now_required': return `${t} now requires ${p}. Agents that omitted it will start guessing a value.`;
    case 'param_added_required': return `${t} added a new required parameter ${p}. Existing calls are incomplete.`;
    case 'param_added_optional': return `${t} added an optional parameter ${p}.`;
    case 'param_now_optional': return `${t} no longer requires ${p}.`;
    case 'param_type_changed': return `${t} parameter ${p} changed type from ${code(c.from)} to ${code(c.to)}.`;
    case 'enum_narrowed': return `${t} parameter ${p} no longer accepts: ${c.removed.map(code).join(', ')}.`;
    case 'enum_widened': return `${t} parameter ${p} now also accepts: ${c.added.map(code).join(', ')}.`;
    case 'enum_removed': return `${t} parameter ${p} dropped its list of allowed values.`;
    case 'output_removed': return `${t} no longer returns ${p}. Skills reading that field will get nothing.`;
    case 'output_added': return `${t} now also returns ${p}.`;
    case 'readonly_revoked': return `${t} previously declared itself read-only and no longer does. Review before any automated use.`;
    case 'description_changed': return `${t} description changed. The agent's understanding of when to use it may shift.`;
    case 'title_changed': return `${t} display title changed.`;
    case 'resource_removed': return `Resource ${code(c.resource)} no longer exists.`;
    case 'resource_added': return `New resource ${code(c.resource)} is available.`;
    case 'protocol_version_changed': return `Server moved from MCP ${code(c.from)} to ${code(c.to)}.`;
    case 'server_version_changed': return `Server version changed from ${code(c.from)} to ${code(c.to)}.`;
    case 'snapshot_incomplete': return c.detail;
    default: return c.type;
  }
}

/**
 * A concrete edit for one change, or null when Tether cannot propose one
 * honestly. Deterministic: it restates the change as an instruction and never
 * invents a value it has not been told.
 */
export function suggestPatch(change) {
  switch (change.type) {
    case 'tool_renamed':
      return `replace ${code(change.tool)} with ${code(change.to)}`;
    case 'tool_removed':
      return `remove or replace the call to ${code(change.tool)} — it has no successor`;
    case 'param_now_required':
    case 'param_added_required':
      return `pass ${code(change.param)} explicitly when calling ${code(change.tool)}; do not let the agent infer it`;
    case 'param_removed':
      return `stop passing ${code(change.param)} to ${code(change.tool)}`;
    case 'param_type_changed':
      return `${code(change.param)} must now be a ${code(change.to)}, not a ${code(change.from)}`;
    case 'enum_narrowed':
      return `stop using ${change.removed.map(code).join(', ')} for ${code(change.param)}`;
    case 'output_removed':
      return `stop reading ${code(change.param)} from the result of ${code(change.tool)}`;
    case 'readonly_revoked':
      return `re-review whether ${code(change.tool)} is still safe to call unattended`;
    default:
      return null;
  }
}

const count = (reports, severity) =>
  reports.reduce((n, r) => n + r.changes.filter((c) => c.severity === severity).length, 0);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function renderMarkdown(reports, index = null) {
  const breaking = count(reports, BREAKING);
  const warnings = count(reports, WARNING);
  const uncheckable = reports.filter((r) => r.error || r.scopeMismatch || r.lockfileOutdated).length;
  const lines = ['# Tether drift report', ''];

  if (!reports.length) {
    lines.push('No connectors have a lockfile yet. Run `tether snapshot` to create one.', '');
    return lines.join('\n');
  }

  const compared = reports.length - uncheckable;
  const signedOff = reports.reduce((n, r) => n + (r.acknowledged?.length ?? 0), 0);
  // "No drift" would be a lie while an acknowledged change is sitting in the
  // report below it. Say what was set aside, and by whose decision.
  const suffix =
    (uncheckable ? ` ${plural(uncheckable, 'connector')} could not be checked.` : '') +
    (signedOff ? ` ${plural(signedOff, 'change')} previously acknowledged.` : '');
  lines.push(
    breaking
      ? `**${plural(breaking, 'breaking change')}** across ${plural(compared, 'connector')}.${suffix}`
      : warnings
        ? `No breaking changes. ${plural(warnings, 'warning')} across ${plural(compared, 'connector')}.${suffix}`
        : compared === 0
          ? `**Nothing could be checked.**${suffix}`
          : compared === 1
            ? `No drift. 1 connector matches its lockfile.${suffix}`
            : `No drift. All ${compared} connectors match their lockfiles.${suffix}`,
    ''
  );

  for (const report of reports) {
    if (report.error) {
      lines.push(`## ${report.connector} — unreachable`, '', report.error, '');
      continue;
    }
    if (report.lockfileOutdated) {
      lines.push(
        `## ${report.connector} — lockfile out of date`, '',
        `This lockfile is v${report.lockfileOutdated.from}; Tether now writes v${report.lockfileOutdated.to}.`,
        'The newer format sees inside nested objects, `$ref` indirection and array outputs, so the',
        'two cannot be compared without reporting every newly-visible field as an addition.',
        '',
        'Run `tether snapshot` to re-capture, then review that diff on its own before trusting',
        'the next check — it will contain drift that was previously invisible.', ''
      );
      continue;
    }
    if (report.scopeMismatch) {
      lines.push(
        `## ${report.connector} — scope mismatch`, '',
        'This snapshot was taken under different credentials than the lockfile, so the two are not',
        'comparable. Re-snapshot with the same principal, or commit a separate lockfile for this one.', ''
      );
      continue;
    }
    if (!report.changes.length) {
      lines.push(`## ${report.connector} — up to date`, '');
      continue;
    }
    lines.push(`## ${report.connector} — ${report.breaking ? 'breaking' : report.severity}`, '');
    for (const severity of [BREAKING, WARNING, 'info']) {
      for (const c of report.changes.filter((x) => x.severity === severity)) {
        lines.push(`- ${ICON[severity]} ${describe(c)}`);
      }
    }
    lines.push('');
  }

  lines.push(...acknowledgedSection(reports));
  lines.push(...affectedSection(reports, index));

  if (breaking) {
    lines.push(
      '---', '',
      'Review the affected skills, then run `tether snapshot` to accept the new state.',
      '',
      'If a change is fine as it stands, record that decision instead of re-snapshotting —',
      '`tether snapshot` accepts everything, including drift nobody has looked at. Add to',
      '`.tether/acknowledged.json`:', '',
      '```json',
      JSON.stringify(
        {
          acknowledgedVersion: 1,
          entries: reports.flatMap((r) =>
            r.changes.filter((c) => c.severity === BREAKING).map((c) => entryFor(c, r.connector))
          )
        },
        null,
        2
      ),
      '```', ''
    );
  }
  return lines.join('\n');
}

/**
 * Changes a human has already signed off.
 *
 * These are still shown. An acknowledgement is a decision on the record, not a
 * delete key -- if signing off made drift disappear from the report, the file
 * would rot into a list of things nobody remembers agreeing to.
 */
function acknowledgedSection(reports) {
  const signed = reports.flatMap((r) => (r.acknowledged ?? []).map((c) => ({ ...c, connector: r.connector })));
  if (!signed.length) return [];

  const lines = ['## Acknowledged', '', `${plural(signed.length, 'change')} previously reviewed and accepted.`, ''];
  for (const change of signed) {
    lines.push(`- ${describe(change)}`);
    const who = change.acknowledgedBy ? ` — ${change.acknowledgedBy}` : '';
    lines.push(`  - ${change.reason ?? 'no reason recorded'}${who}`);
  }
  lines.push('');
  return lines;
}

/** "Which skills does this break, and what should change in each?" */
function affectedSection(reports, index) {
  if (!index) return [];
  const affected = [...affectedSkills(index, reports).entries()]
    .map(([path, entry]) => [path, entry.changes.filter((c) => c.severity === BREAKING)])
    .filter(([, changes]) => changes.length);

  if (!affected.length) {
    const total = index.skills?.length ?? 0;
    return total ? ['## Affected skills', '', `None. ${plural(total, 'indexed skill')} unaffected.`, ''] : [];
  }

  const lines = ['## Affected skills', ''];
  for (const [path, changes] of affected) {
    lines.push(`### ${code(path)}`, '');
    for (const change of changes) {
      lines.push(`- ${describe(change)}`);
      const patch = suggestPatch(change);
      if (patch) lines.push(`  - **Suggested edit:** ${patch}`);
    }
    lines.push('');
  }
  return lines;
}

export const renderJson = (reports, index = null) =>
  JSON.stringify(
    {
      breaking: count(reports, BREAKING),
      warnings: count(reports, WARNING),
      acknowledged: reports.reduce((n, r) => n + (r.acknowledged?.length ?? 0), 0),
      connectors: reports,
      affected: index
        ? [...affectedSkills(index, reports).entries()].map(([path, entry]) => ({
            path,
            changes: entry.changes.map((c) => ({ ...c, suggestedEdit: suggestPatch(c) }))
          }))
        : undefined
    },
    null,
    2
  ) + '\n';

/**
 * 0 = clean or informational only. 1 = breaking drift. 2 = could not check.
 * A checker that cannot reach a connector must not report "all clear".
 */
export function exitCode(reports) {
  // 2 covers everything Tether could not actually check. A scope mismatch
  // belongs here: comparing snapshots taken under different credentials is not
  // a clean result, it is no result.
  if (reports.some((r) => r.error || r.scopeMismatch || r.lockfileOutdated)) return 2;
  if (reports.some((r) => r.breaking > 0)) return 1;
  return 0;
}

// --- instance drift (the resolver) ---------------------------------------

const RESOLVE_ICON = {
  [RESOLVED]: '✅', [MISSING]: '🔴', [SKIPPED]: '⏭️', [ERROR]: '⚠️', [DRY_RUN]: '🔍'
};

export function renderResolveMarkdown(results) {
  const lines = ['# Tether instance drift report', ''];
  if (!results.length) {
    lines.push('No skills declare identifiers yet. Add a `tether:` block to a skill to enable this check.', '');
    return lines.join('\n');
  }

  const missing = results.filter((r) => r.status === MISSING);
  const skipped = results.filter((r) => r.status === SKIPPED);
  const dry = results.filter((r) => r.status === DRY_RUN);

  if (dry.length) {
    lines.push(`**Dry run.** ${plural(dry.length, 'probe')} would be called. Nothing was invoked.`, '');
    for (const r of dry) {
      lines.push(
        `- 🔍 ${code(r.connector + '.' + r.intended.tool)} with ${code(JSON.stringify(r.intended.arguments))} ` +
        `— to check ${code(r.value)}`
      );
    }
    lines.push('');
    return lines.join('\n');
  }

  // An identifier whose probe errored was NOT confirmed. Counting it as
  // resolved is the same false-green that `check` refuses to emit.
  const errors = results.filter((r) => r.status === ERROR);
  const confirmed = results.filter((r) => r.status === RESOLVED).length;
  const unchecked = skipped.length + errors.length;

  lines.push(
    missing.length
      ? `**${plural(missing.length, 'identifier')} no longer resolve${missing.length === 1 ? 's' : ''}.** ` +
        'This is the silent tier: nothing errors, the skill just does the wrong thing.'
      : confirmed
        ? `${plural(confirmed, 'identifier')} still resolve${confirmed === 1 ? 's' : ''}.`
        : '**Nothing could be confirmed.**',
    ''
  );
  if (unchecked) {
    lines.push(
      `${plural(unchecked, 'identifier')} could not be checked ` +
      `(${skipped.length} skipped, ${errors.length} errored).`,
      ''
    );
  }

  for (const r of results) {
    const where = `${code(r.value)} via ${code(r.connector + '.' + (r.probe ?? '?'))}`;
    if (r.status === MISSING) {
      // "among 1 candidates" reads as a bug when the probe returned one prose
      // blob rather than an enumeration. Say which situation this actually is.
      const among = r.candidates === 1
        ? 'was not found in what the probe returned'
        : `was not found among ${r.candidates} candidates`;
      lines.push(`- ${RESOLVE_ICON[r.status]} **${r.id}** — ${where} ${among}.`);
      for (const s of r.suggestions ?? []) {
        lines.push(`  - Did it become ${code(s.candidate)}? (${Math.round(s.score * 100)}% similar)`);
      }
    } else if (r.status === SKIPPED) {
      lines.push(`- ${RESOLVE_ICON[r.status]} **${r.id}** — skipped: ${r.reason}`);
    } else if (r.status === ERROR) {
      lines.push(`- ${RESOLVE_ICON[r.status]} **${r.id}** — probe failed: ${r.reason}`);
    } else {
      const confidence = r.confidence === 'low' ? ' (low confidence: unstructured match)' : '';
      lines.push(`- ${RESOLVE_ICON[r.status]} **${r.id}** — ${where} still resolves${confidence}.`);
    }
  }
  lines.push('');

  if (skipped.length) {
    lines.push(
      `${plural(skipped.length, 'identifier')} skipped rather than guessed. Tether will not probe a tool a ` +
      'human has not put on the allowlist.',
      ''
    );
  }
  return lines.join('\n');
}

const tally = (results, status) => results.filter((r) => r.status === status).length;

export const renderResolveJson = (results) =>
  JSON.stringify(
    {
      missing: tally(results, MISSING),
      resolved: tally(results, RESOLVED),
      skipped: tally(results, SKIPPED),
      errors: tally(results, ERROR),
      identifiers: results
    },
    null,
    2
  ) + '\n';

/**
 * 1 = an identifier is genuinely gone. 2 = Tether could not find out.
 *
 * Mirrors `exitCode` for schema drift: not being able to check is never a pass.
 * A skipped identifier is a deliberate, reported refusal rather than a failure,
 * so it does not fail the build on its own.
 */
export function resolveExitCode(results) {
  if (results.some((r) => r.status === MISSING)) return 1;
  if (results.some((r) => r.status === ERROR)) return 2;
  return 0;
}
