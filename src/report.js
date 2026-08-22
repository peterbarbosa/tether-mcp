// Rendering and exit codes. Pure -- takes diff reports, returns strings.

import { BREAKING, WARNING } from './diff.js';

const ICON = { breaking: '🔴', warning: '🟡', info: '⚪' };

/** One change, as a sentence a human can act on without reading the lockfile. */
export function describe(c) {
  const t = c.tool ? '`' + c.tool + '`' : '';
  const p = c.param ? '`' + c.param + '`' : '';
  switch (c.type) {
    case 'tool_removed': return `Tool ${t} no longer exists. Any skill that calls it will fail.`;
    case 'tool_added': return `New tool ${t} is available.`;
    case 'param_removed': return `${t} no longer accepts ${p}. Calls passing it may be rejected.`;
    case 'param_now_required': return `${t} now requires ${p}. Agents that omitted it will start guessing a value.`;
    case 'param_added_required': return `${t} added a new required parameter ${p}. Existing calls are incomplete.`;
    case 'param_added_optional': return `${t} added an optional parameter ${p}.`;
    case 'param_now_optional': return `${t} no longer requires ${p}.`;
    case 'param_type_changed': return `${t} parameter ${p} changed type from \`${c.from}\` to \`${c.to}\`.`;
    case 'enum_narrowed': return `${t} parameter ${p} no longer accepts: ${c.removed.map((v) => '`' + v + '`').join(', ')}.`;
    case 'enum_widened': return `${t} parameter ${p} now also accepts: ${c.added.map((v) => '`' + v + '`').join(', ')}.`;
    case 'enum_removed': return `${t} parameter ${p} dropped its list of allowed values.`;
    case 'output_removed': return `${t} no longer returns ${p}. Skills reading that field will get nothing.`;
    case 'output_added': return `${t} now also returns ${p}.`;
    case 'readonly_revoked': return `${t} previously declared itself read-only and no longer does. Review before any automated use.`;
    case 'description_changed': return `${t} description changed. The agent's understanding of when to use it may shift.`;
    case 'title_changed': return `${t} display title changed.`;
    case 'resource_removed': return `Resource \`${c.resource}\` no longer exists.`;
    case 'resource_added': return `New resource \`${c.resource}\` is available.`;
    case 'protocol_version_changed': return `Server moved from MCP \`${c.from}\` to \`${c.to}\`.`;
    case 'server_version_changed': return `Server version changed from \`${c.from}\` to \`${c.to}\`.`;
    case 'snapshot_incomplete': return c.detail;
    default: return c.type;
  }
}

const count = (reports, severity) =>
  reports.reduce((n, r) => n + r.changes.filter((c) => c.severity === severity).length, 0);

export function renderMarkdown(reports) {
  const breaking = count(reports, BREAKING);
  const warnings = count(reports, WARNING);
  const lines = ['# Tether drift report', ''];

  if (!reports.length) {
    lines.push('No connectors have a lockfile yet. Run `tether snapshot` to create one.', '');
    return lines.join('\n');
  }

  const summary = breaking
    ? `**${breaking} breaking change${breaking === 1 ? '' : 's'}** across ${reports.length} connector${reports.length === 1 ? '' : 's'}.`
    : warnings
      ? `No breaking changes. ${warnings} warning${warnings === 1 ? '' : 's'} across ${reports.length} connector${reports.length === 1 ? '' : 's'}.`
      : `No drift. ${reports.length} connector${reports.length === 1 ? '' : 's'} match their lockfile.`;
  lines.push(summary, '');

  for (const report of reports) {
    if (report.error) {
      lines.push(`## ${report.connector} — unreachable`, '', report.error, '');
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
    const worst = report.breaking ? 'breaking' : report.severity;
    lines.push(`## ${report.connector} — ${worst}`, '');
    for (const severity of [BREAKING, WARNING, 'info']) {
      const group = report.changes.filter((c) => c.severity === severity);
      for (const c of group) lines.push(`- ${ICON[severity]} ${describe(c)}`);
    }
    lines.push('');
  }

  if (breaking) {
    lines.push('---', '', 'Review the affected skills, then run `tether snapshot` to accept the new state.', '');
  }
  return lines.join('\n');
}

export const renderJson = (reports) =>
  JSON.stringify(
    {
      breaking: count(reports, BREAKING),
      warnings: count(reports, WARNING),
      connectors: reports
    },
    null,
    2
  ) + '\n';

/**
 * 0 = clean or informational only. 1 = breaking drift. 2 = could not check.
 * A checker that cannot reach a connector must not report "all clear".
 */
export function exitCode(reports) {
  if (reports.some((r) => r.error)) return 2;
  if (reports.some((r) => r.breaking > 0)) return 1;
  return 0;
}
