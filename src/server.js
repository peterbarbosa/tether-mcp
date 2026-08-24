// The third surface: Tether as an MCP server, so another agent can ask about
// drift without shelling out.
//
// Every tool here is read-only with respect to the world: they read lockfiles,
// the index, and (for check) call `tools/list`. None of them can snapshot,
// probe, or write, because an agent that can accept drift on its own behalf
// defeats the point of a lockfile being reviewed.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConnectors } from './config.js';
import { snapshotConnector } from './client.js';
import { buildLock, readLock, listLocked } from './lock.js';
import { diffLocks } from './diff.js';
import { readIndex, affectedSkills } from './skills.js';
import { renderMarkdown, suggestPatch } from './report.js';
import { VERSION } from './version.js';

const TOOLS = [
  {
    name: 'tether_check_drift',
    title: 'Check MCP connector drift',
    description:
      'Compare every locked MCP connector against its live state and report what changed, ' +
      'which skills are affected, and the suggested edit for each. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        connector: { type: 'string', description: 'Check only this connector id. Omit to check all.' }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: 'tether_list_connectors',
    title: 'List connectors',
    description: 'List the MCP connectors Tether can see and whether each one has a committed lockfile.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'tether_affected_skills',
    title: 'Find skills affected by a tool',
    description:
      'Given a connector and tool name, list the indexed skills that reference it. ' +
      'Use before changing or retiring a tool. Read-only, offline.',
    inputSchema: {
      type: 'object',
      properties: {
        connector: { type: 'string' },
        tool: { type: 'string' }
      },
      required: ['connector', 'tool'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

const text = (value) => ({ content: [{ type: 'text', text: value }] });

export async function startServer(dir = process.cwd()) {
  const server = new Server({ name: 'tether', version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      if (name === 'tether_list_connectors') {
        const locked = new Set(listLocked(dir));
        const connectors = loadConnectors(dir).map((c) => ({
          id: c.id, transport: c.transport, target: c.target, locked: locked.has(c.id)
        }));
        return { ...text(JSON.stringify(connectors, null, 2)), structuredContent: { connectors } };
      }

      if (name === 'tether_affected_skills') {
        const index = readIndex(dir);
        if (!index) return { ...text('No skill index. Run `tether index` first.'), isError: true };
        const skills = index.skills
          .filter((s) => s.tools.some((t) => t.connector === args.connector && t.tool === args.tool))
          .map((s) => ({ path: s.path, name: s.name, declared: s.declared }));
        return { ...text(JSON.stringify(skills, null, 2)), structuredContent: { skills } };
      }

      if (name === 'tether_check_drift') {
        const connectors = loadConnectors(dir);
        const index = readIndex(dir);
        const reports = [];
        for (const id of listLocked(dir)) {
          if (args.connector && id !== args.connector) continue;
          const connector = connectors.find((c) => c.id === id);
          if (!connector) {
            reports.push({ connector: id, changes: [], breaking: 0, error: 'No longer defined in the MCP config.' });
            continue;
          }
          try {
            reports.push(diffLocks(readLock(dir, id), buildLock(await snapshotConnector(connector))));
          } catch (error) {
            reports.push({ connector: id, changes: [], breaking: 0, error: `Unreachable: ${error.message}` });
          }
        }
        const affected = [...affectedSkills(index, reports).entries()].map(([path, entry]) => ({
          path,
          changes: entry.changes.map((c) => ({ ...c, suggestedEdit: suggestPatch(c) }))
        }));
        return {
          ...text(renderMarkdown(reports, index)),
          structuredContent: {
            breaking: reports.reduce((n, r) => n + (r.breaking ?? 0), 0),
            connectors: reports,
            affected
          }
        };
      }

      return { ...text(`Unknown tool: ${name}`), isError: true };
    } catch (error) {
      return { ...text(error.message), isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  return server;
}
