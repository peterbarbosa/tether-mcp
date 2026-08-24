// Talking to a live MCP server. The only module that touches the network.
//
// SAFETY INVARIANT: snapshotting calls `tools/list` and `resources/list` and
// nothing else. Tool invocation exists in exactly one function here --
// `createToolCaller` -- and it refuses any tool that is not on the
// human-reviewed allowlist, independently of the resolver's own check. Two
// gates that do not share code, because a drift auditor that files a ticket
// while auditing is worse than no auditor. test/safety.test.js asserts both.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { authModeOf, principalHint } from './config.js';
import { isAllowed } from './allowlist.js';

const MAX_PAGES = 100;

function transportFor(connector) {
  if (connector.transport === 'stdio') {
    return new StdioClientTransport({
      command: connector.command,
      args: connector.args ?? [],
      env: { ...process.env, ...(connector.env ?? {}) }
    });
  }
  const url = new URL(connector.url);
  const options = Object.keys(connector.headers ?? {}).length
    ? { requestInit: { headers: connector.headers } }
    : undefined;
  return connector.transport === 'sse'
    ? new SSEClientTransport(url, options)
    : new StreamableHTTPClientTransport(url, options);
}

/** Follow `nextCursor` to exhaustion. A partial list would read as mass removal. */
async function listAll(fetchPage, key) {
  const items = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(cursor);
    items.push(...(result?.[key] ?? []));
    cursor = result?.nextCursor;
    if (!cursor) return { items, complete: true };
  }
  return { items, complete: false };
}

/**
 * Connect, read the connector's full surface, disconnect.
 * Returns the snapshot shape that `buildLock` consumes.
 */
export async function snapshotConnector(connector, { timeoutMs = 30000 } = {}) {
  const client = new Client({ name: 'tether', version: '0.1.0' }, { capabilities: {} });
  const transport = transportFor(connector);
  const timer = setTimeout(() => transport.close?.(), timeoutMs);

  try {
    await client.connect(transport);

    const capabilities = client.getServerCapabilities() ?? {};
    const serverInfo = client.getServerVersion() ?? {};

    const tools = capabilities.tools
      ? await listAll((cursor) => client.listTools({ cursor }), 'tools')
      : { items: [], complete: true };

    // resources/list is optional; a server may advertise it and still refuse.
    let resources = { items: [], complete: true };
    if (capabilities.resources) {
      try {
        resources = await listAll((cursor) => client.listResources({ cursor }), 'resources');
      } catch {
        resources = { items: [], complete: true };
      }
    }

    return {
      id: connector.id,
      transport: connector.transport,
      target: connector.target,
      protocolVersion: transport.protocolVersion ?? serverInfo.protocolVersion,
      serverInfo: { name: serverInfo.name, version: serverInfo.version },
      capabilities,
      authMode: authModeOf(connector),
      principalHint: principalHint(connector),
      complete: tools.complete && resources.complete,
      tools: tools.items,
      resources: resources.items
    };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

/**
 * Open connections to several connectors at once and hand back a bounded
 * `callTool`. Used only by `tether resolve`.
 */
export async function withConnectors(connectors, allowlist, fn) {
  const open = new Map();
  const failed = new Map();
  try {
    for (const connector of connectors) {
      try {
        const client = new Client({ name: 'tether', version: '0.1.0' }, { capabilities: {} });
        await client.connect(transportFor(connector));
        open.set(connector.id, client);
      } catch (error) {
        // One unreachable connector must not erase the findings for the others.
        // It is recorded and surfaces per identifier as a probe error.
        failed.set(connector.id, error.message);
      }
    }
    return await fn(createToolCaller(open, allowlist, failed));
  } finally {
    for (const client of open.values()) await client.close().catch(() => {});
  }
}

/**
 * The single point in Tether where a tool is invoked.
 *
 * This gate is deliberately duplicated from the resolver's own check. They do
 * not share code, so a mistake in one does not open the other.
 */
export function createToolCaller(clients, allowlist, failed = new Map()) {
  return async function callTool(connectorId, tool, args) {
    if (!isAllowed(allowlist, connectorId, tool)) {
      throw new Error(`refusing to call ${connectorId}.${tool}: not on the probe allowlist`);
    }
    if (failed.has(connectorId)) throw new Error(`connector unreachable: ${failed.get(connectorId)}`);
    const client = clients.get(connectorId);
    if (!client) throw new Error(`no open connection for ${connectorId}`);
    return client.callTool({ name: tool, arguments: args ?? {} });
  };
}
