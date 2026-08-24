#!/usr/bin/env node
// tether -- a lockfile and drift checker for MCP connectors.
//
//   tools/list is the lockfile.  tether check is npm outdated.

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { loadConnectors } from '../src/config.js';
import { snapshotConnector, withConnectors } from '../src/client.js';
import { buildLock, writeLock, readLock, listLocked } from '../src/lock.js';
import { diffLocks } from '../src/diff.js';
import {
  buildIndex, writeIndex, readIndex, vocabularyFrom, findSkillFiles, indexStaleness, SKILL_DIRS
} from '../src/skills.js';
import {
  loadAllowlist, isAllowed, proposeAllowlist, writeProposal, allowedCount, proposalPath, allowlistPath
} from '../src/allowlist.js';
import { resolveIdentifier } from '../src/probe.js';
import { VERSION } from '../src/version.js';
import { loadAcknowledged, applyAcknowledgements, expiredEntries, acknowledgedPath } from '../src/acknowledged.js';
import {
  renderMarkdown, renderJson, exitCode,
  renderResolveMarkdown, renderResolveJson, resolveExitCode
} from '../src/report.js';

const HELP = `
tether -- know when your MCP connectors drift out from under your skills.

Schema drift (tier 1)
  tether snapshot [connector...]   Capture the current tool surface into .tether/
  tether check    [connector...]   Diff live state against the lockfile
  tether list                      Show discovered connectors and lock status

Instance drift (tier 2)
  tether index                     Map which skills reference which tools
  tether allowlist                 Propose read-only probes for human review
  tether resolve                   Check that declared identifiers still exist

As an MCP server
  tether mcp                       Serve drift status to other agents over stdio

Options
  --json            Emit machine-readable output instead of Markdown
  --out <file>      Write the report to a file as well as stdout
  --config <path>   Read connectors from a specific MCP config file
  --dir <path>      Project directory (default: cwd)
  --skills <path>   Extra directory to scan for skills (repeatable)
  --dry-run         resolve: log intended probes without calling anything
  --timeout <ms>    Per-connector timeout (default: 30000)
  --help

Exit codes
  0  clean    1  breaking drift or unresolved identifier    2  could not check

With no arguments, tether reads the .mcp.json your project already has.
`;

const { values, positionals } = parseArgs({
  options: {
    json: { type: 'boolean', default: false },
    out: { type: 'string' },
    config: { type: 'string' },
    dir: { type: 'string' },
    skills: { type: 'string', multiple: true },
    'dry-run': { type: 'boolean', default: false },
    timeout: { type: 'string' },
    help: { type: 'boolean', default: false }
  },
  allowPositionals: true
});

const [command = 'check', ...selected] = positionals;
const dir = values.dir ?? process.cwd();
const timeoutMs = Number(values.timeout ?? 30000);

if (values.help || command === 'help') {
  process.stdout.write(HELP);
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`tether: ${message}\n`);
  process.exit(2);
}

function note(message) {
  process.stderr.write(`  ${message}\n`);
}

function emit(text) {
  process.stdout.write(text);
  if (values.out) writeFileSync(values.out, text);
}

/** Connectors to act on: those named on the command line, or all discovered. */
function targets() {
  const all = loadConnectors(dir, values.config);
  for (const { path, reason } of all.unreadable ?? []) {
    note(`warning: could not read ${path} — ${reason}`);
  }
  if (!selected.length) return all;
  const missing = selected.filter((id) => !all.some((c) => c.id === id));
  if (missing.length) fail(`unknown connector: ${missing.join(', ')}`);
  return all.filter((c) => selected.includes(c.id));
}

const skillRoots = () =>
  values.skills?.length ? values.skills : undefined;

// --- commands ------------------------------------------------------------

async function snapshot() {
  const connectors = targets();
  if (!connectors.length) fail('no MCP connectors found. Looked for .mcp.json and friends.');
  let failures = 0;
  for (const connector of connectors) {
    try {
      const lock = buildLock(await snapshotConnector(connector, { timeoutMs }));
      writeLock(dir, lock, {
        capturedAt: new Date().toISOString(),
        tetherVersion: VERSION,
        source: connector.source
      });
      note(`snapshot ${connector.id}: ${lock.tools.length} tools, ${lock.resources.length} resources`);
    } catch (error) {
      failures++;
      note(`snapshot ${connector.id}: FAILED -- ${error.message}`);
    }
  }
  process.exit(failures ? 2 : 0);
}

async function check() {
  const connectors = targets();
  const locked = listLocked(dir);
  if (!locked.length) fail('no lockfiles in .tether/. Run `tether snapshot` first.');

  // A named connector with no lockfile must not pass silently. Checking
  // nothing and exiting 0 is exactly how a typo, or a connector someone forgot
  // to snapshot, turns into a green build.
  const unlocked = selected.filter((id) => !locked.includes(id));
  if (unlocked.length) {
    fail(`no lockfile for: ${unlocked.join(', ')}. Run \`tether snapshot ${unlocked.join(' ')}\` first.`);
  }

  const acknowledged = loadAcknowledged(dir);
  if (acknowledged.malformed) {
    note(`warning: ${acknowledgedPath(dir)} could not be parsed (${acknowledged.malformed}); acknowledging nothing`);
  }
  for (const entry of expiredEntries(acknowledged)) {
    note(`warning: acknowledgement for ${entry.tool ?? entry.type} expired on ${entry.expires}; it no longer applies`);
  }

  const reports = [];
  for (const id of locked) {
    if (selected.length && !selected.includes(id)) continue;
    const previous = readLock(dir, id);
    const connector = connectors.find((c) => c.id === id);
    if (!connector) {
      reports.push({ connector: id, changes: [], breaking: 0, error: 'Connector is no longer defined in your MCP config.' });
      continue;
    }
    try {
      const current = buildLock(await snapshotConnector(connector, { timeoutMs }));
      reports.push(applyAcknowledgements(diffLocks(previous, current), acknowledged));
    } catch (error) {
      reports.push({ connector: id, changes: [], breaking: 0, error: `Could not reach connector: ${error.message}` });
    }
  }

  const index = readIndex(dir);
  for (const reason of indexStaleness(index, vocabularyFrom(dir))) {
    note(`warning: skill index is stale — ${reason}. Run \`tether index\`.`);
  }
  emit(values.json ? renderJson(reports, index) : renderMarkdown(reports, index));
  process.exit(exitCode(reports));
}

function index() {
  const vocabulary = vocabularyFrom(dir);
  if (!Object.keys(vocabulary).length) fail('no lockfiles in .tether/. Run `tether snapshot` first.');

  // Roots come from the flag, else from the existing index, else the defaults.
  // Reusing the recorded roots is what makes `tether index` reproducible: a
  // plain re-run must not silently drop skills a previous run was told about.
  const previous = readIndex(dir);
  const roots = skillRoots() ?? previous?.roots ?? SKILL_DIRS;
  const built = buildIndex(dir, vocabulary, findSkillFiles(dir, roots), roots);
  writeIndex(dir, built);

  const declared = built.skills.filter((s) => s.declared).length;
  const withTools = built.skills.filter((s) => s.tools.length).length;
  const identifiers = built.skills.reduce((n, s) => n + s.identifiers.length, 0);
  const problems = built.skills.flatMap((s) => s.problems.map((p) => `${s.path}: ${p}`));
  const unknown = built.skills.flatMap((s) => s.unknownTools.map((t) => `${s.path}: references unknown tool ${t}`));

  if (values.json) {
    emit(JSON.stringify(built, null, 2) + '\n');
  } else {
    emit(
      `Indexed ${built.skills.length} skill file(s).\n` +
      `  ${withTools} reference a known tool\n` +
      `  ${declared} declare a tether manifest\n` +
      `  ${identifiers} identifier(s) available to \`tether resolve\`\n` +
      (problems.length ? `\nProblems:\n${problems.map((p) => '  ' + p).join('\n')}\n` : '') +
      (unknown.length ? `\nUnresolved references:\n${unknown.map((p) => '  ' + p).join('\n')}\n` : '')
    );
  }
  process.exit(unknown.length ? 1 : 0);
}

function allowlist() {
  const current = loadAllowlist(dir);
  const proposal = proposeAllowlist(dir);
  writeProposal(dir, proposal);
  const proposed = Object.values(proposal.connectors).reduce((n, tools) => n + Object.keys(tools).length, 0);

  emit(
    `Probe allowlist\n` +
    `  ${allowedCount(current)} tool(s) currently authorized in ${allowlistPath(dir)}\n` +
    `  ${proposed} candidate(s) written to ${proposalPath(dir)}\n\n` +
    `Nothing in the proposal is active. Tether will not probe a tool until you\n` +
    `review it and move it into allowlist.json yourself.\n`
  );
}

async function resolve() {
  const idx = readIndex(dir);
  if (!idx) fail('no skill index. Run `tether index` first.');

  const allow = loadAllowlist(dir);
  if (allow.malformed) fail('.tether/allowlist.json could not be parsed. Refusing to probe anything.');

  const identifiers = idx.skills.flatMap((skill) =>
    skill.identifiers.map((identifier) => ({ ...identifier, skill: skill.path }))
  );
  if (!identifiers.length) {
    emit(renderResolveMarkdown([]));
    process.exit(0);
  }

  const dryRun = values['dry-run'];

  // Open only the connectors that have at least one identifier which will
  // actually be probed. An identifier that is incomplete or unallowlisted is
  // decided offline, so there is no reason to open a connection for it.
  const actionable = identifiers.filter(
    (i) => i.probe && i.connector && i.value != null && isAllowed(allow, i.connector, i.probe)
  );
  const needed = [...new Set(actionable.map((i) => i.connector))];
  const connectors = loadConnectors(dir, values.config).filter((c) => needed.includes(c.id));

  // In a dry run nothing is opened at all -- the safest possible path.
  const run = async (callTool) => {
    const results = [];
    for (const identifier of identifiers) {
      results.push({ ...(await resolveIdentifier(identifier, { allowlist: allow, callTool, dryRun })), skill: identifier.skill });
    }
    return results;
  };

  let results;
  if (dryRun || !needed.length) {
    results = await run(() => {
      throw new Error('unreachable: dry run must not call a tool');
    });
  } else {
    try {
      results = await withConnectors(connectors, allow, run);
    } catch (error) {
      fail(`could not open connectors: ${error.message}`);
    }
  }

  emit(values.json ? renderResolveJson(results) : renderResolveMarkdown(results));
  process.exit(resolveExitCode(results));
}

function list() {
  const connectors = targets();
  const locked = new Set(listLocked(dir));
  if (values.json) {
    emit(JSON.stringify(connectors.map((c) => ({ ...c, locked: locked.has(c.id) })), null, 2) + '\n');
    return;
  }
  if (!connectors.length) {
    emit('No MCP connectors found. Tether reads .mcp.json, .vscode/mcp.json, .cursor/mcp.json,\n' +
         'your Claude Code user config, and Claude Desktop config.\n');
    return;
  }
  const lines = connectors.map(
    (c) => `  ${locked.has(c.id) ? '[locked]' : '[      ]'}  ${c.id.padEnd(20)} ${c.transport.padEnd(6)} ${c.target}`
  );
  emit(`${connectors.length} connector(s):\n${lines.join('\n')}\n`);
}

async function mcp() {
  const { startServer } = await import('../src/server.js');
  await startServer(dir);
  // stdio transport keeps the process alive; nothing further to do here.
}

const commands = { snapshot, check, list, index, allowlist, resolve, mcp };
if (!commands[command]) fail(`unknown command "${command}". Try --help.`);
await commands[command]();
