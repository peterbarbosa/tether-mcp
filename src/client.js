// Talking to a live MCP server. The only module that touches the network.
//
// SAFETY INVARIANT: this module calls `tools/list` and `resources/list` and
// nothing else. `tools/call` is never imported, referenced, or reachable from
// any code path here. A drift auditor that files a ticket while checking for
// drift is worse than no auditor, and that guarantee has to hold by
// construction rather than by care. test/safety.test.js asserts it.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { authModeOf, principalHint } from './config.js';

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
