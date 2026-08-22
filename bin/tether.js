#!/usr/bin/env node
// tether -- a lockfile and drift checker for MCP connectors.
//
//   tools/list is the lockfile.  tether check is npm outdated.

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { loadConnectors } from '../src/config.js';
import { snapshotConnector } from '../src/client.js';
import { buildLock, writeLock, readLock, listLocked } from '../src/lock.js';
import { diffLocks } from '../src/diff.js';
import { renderMarkdown, renderJson, exitCode } from '../src/report.js';

const HELP = `
tether -- know when your MCP connectors drift out from under your skills.

  tether snapshot [connector...]   Capture the current tool surface into .tether/
  tether check    [connector...]   Diff live state against the lockfile
  tether list                      Show discovered connectors and lock status

Options
  --json            Emit machine-readable output instead of Markdown
  --out <file>      Write the report to a file as well as stdout
  --config <path>   Read connectors from a specific MCP config file
  --dir <path>      Project directory (default: cwd)
  --timeout <ms>    Per-connector timeout (default: 30000)
  --help

Exit codes
  0  no breaking changes    1  breaking drift found    2  a connector could not be reached

With no arguments, tether reads the .mcp.json your project already has.
`;

const options = {
  json: { type: 'boolean', default: false },
  out: { type: 'string' },
  config: { type: 'string' },
  dir: { type: 'string' },
  timeout: { type: 'string' },
  help: { type: 'boolean', default: false }
};

const { values, positionals } = parseArgs({ options, allowPositionals: true });
const [command = 'check', ...selected] = positionals;
const dir = values.dir ?? process.cwd();
const timeoutMs = Number(values.timeout ?? 30000);

if (values.help || command === 'help') {
  process.stdout.write(HELP);
  process.exit(0);
}

/** Connectors to act on: those named on the command line, or all discovered. */
function targets() {
  const all = loadConnectors(dir, values.config);
  if (!selected.length) return all;
  const missing = selected.filter((id) => !all.some((c) => c.id === id));
  if (missing.length) fail(`unknown connector: ${missing.join(', ')}`);
  return all.filter((c) => selected.includes(c.id));
}

function fail(message) {
  process.stderr.write(`tether: ${message}\n`);
  process.exit(2);
}

function emit(text) {
  process.stdout.write(text);
  if (values.out) writeFileSync(values.out, text);
}

async function snapshot() {
  const connectors = targets();
  if (!connectors.length) fail('no MCP connectors found. Looked for .mcp.json and friends.');
  let failures = 0;
  for (const connector of connectors) {
    try {
      const raw = await snapshotConnector(connector, { timeoutMs });
      const lock = buildLock(raw);
      writeLock(dir, lock, {
        capturedAt: new Date().toISOString(),
        tetherVersion: '0.1.0',
        source: connector.source
      });
      process.stderr.write(
        `  snapshot ${connector.id}: ${lock.tools.length} tools, ${lock.resources.length} resources\n`
      );
    } catch (error) {
      failures++;
      process.stderr.write(`  snapshot ${connector.id}: FAILED -- ${error.message}\n`);
    }
  }
  process.exit(failures ? 2 : 0);
}

async function check() {
  const connectors = targets();
  const locked = listLocked(dir);
  if (!locked.length) fail('no lockfiles in .tether/. Run `tether snapshot` first.');

  const reports = [];
  for (const id of locked) {
    const previous = readLock(dir, id);
    const connector = connectors.find((c) => c.id === id);
    if (selected.length && !selected.includes(id)) continue;
    if (!connector) {
      reports.push({ connector: id, changes: [], breaking: 0, error: 'Connector is no longer defined in your MCP config.' });
      continue;
    }
    try {
      const current = buildLock(await snapshotConnector(connector, { timeoutMs }));
      reports.push(diffLocks(previous, current));
    } catch (error) {
      reports.push({ connector: id, changes: [], breaking: 0, error: `Could not reach connector: ${error.message}` });
    }
  }

  emit(values.json ? renderJson(reports) : renderMarkdown(reports));
  process.exit(exitCode(reports));
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

const commands = { snapshot, check, list };
if (!commands[command]) fail(`unknown command "${command}". Try --help.`);
await commands[command]();
