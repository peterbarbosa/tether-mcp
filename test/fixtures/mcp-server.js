#!/usr/bin/env node
// A synthetic MCP server that misbehaves on request.
//
// Every lockfile in this repo is a toy: a handful of flat tools, one page, no
// credentials. So the branches that matter most when a connector is large --
// pagination, `complete: false`, a credential-scoped tool set, a server that
// never answers -- have unit tests around their inputs and no execution
// coverage of the path that actually produces them. This server exists to give
// `src/client.js` something real to talk to.
//
// It refuses to be a mock. Tests point a normal stdio connector spec at it and
// go through `snapshotConnector` exactly as production does; the scenario is
// selected by environment variables, the same channel a real `.mcp.json` uses
// to pass credentials. Nothing here reaches into Tether, and Tether has no
// branch that knows this file exists -- a fixture the code under test could
// detect would prove nothing.
//
// Scenarios (all optional, all env vars):
//
//   TETHER_FIXTURE_TOOLS=<n>       how many tools to expose            (default 3)
//   TETHER_FIXTURE_PAGE_SIZE=<n>   paginate tools/list into pages      (default: one page)
//   TETHER_FIXTURE_ENDLESS=1       always return a nextCursor, so the page
//                                  walk hits its ceiling and the snapshot is
//                                  reported incomplete rather than complete
//                                  and wrong
//   TETHER_FIXTURE_MUTE=1          accept the connection, answer nothing
//   TETHER_FIXTURE_TOKEN=<s>       vary the tool set by credential; any
//                                  non-empty value sees one extra tool
//   TETHER_FIXTURE_SHAPE=flat|nested|deep|ref|cyclic|broken-ref|array-output
//   TETHER_FIXTURE_RESOURCES=none|list|refuse
//
// stdout belongs to the protocol. Anything this file needs to say goes to
// stderr, or it corrupts the stream it is pretending to serve.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const env = process.env;

// `node --test` discovers every .js file under test/, this one included, and
// would then sit forever waiting for a client that is never coming. The marker
// is what separates "a test spawned me" from "the runner swept me up": tests
// set it through the connector spec, the runner does not.
if (env.TETHER_FIXTURE !== '1') {
  process.stderr.write(
    'test/fixtures/mcp-server.js is an MCP fixture server, not a test.\n' +
      'It is spawned by test/client.test.js with TETHER_FIXTURE=1.\n'
  );
  process.exit(0);
}
const num = (name, fallback) => {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const TOOL_COUNT = num('TETHER_FIXTURE_TOOLS', 3);
const PAGE_SIZE = num('TETHER_FIXTURE_PAGE_SIZE', 0); // 0 = single page
const ENDLESS = env.TETHER_FIXTURE_ENDLESS === '1';
const MUTE = env.TETHER_FIXTURE_MUTE === '1';
const TOKEN = env.TETHER_FIXTURE_TOKEN ?? '';
const SHAPE = env.TETHER_FIXTURE_SHAPE ?? 'flat';
const RESOURCES = env.TETHER_FIXTURE_RESOURCES ?? 'none';

// --- schema shapes -------------------------------------------------------
//
// Each shape targets one thing the canonical walker claims to do. They are
// written as literal JSON Schema rather than generated from Tether's own
// helpers, because the point is to feed the walker input Tether did not author.

/** An object nested `depth` levels, with a required leaf at the bottom. */
function nest(depth) {
  let schema = { type: 'object', properties: { leaf: { type: 'string' } }, required: ['leaf'] };
  for (let i = depth; i > 0; i--) {
    schema = { type: 'object', properties: { ['level' + i]: schema }, required: ['level' + i] };
  }
  return schema;
}

const SHAPES = {
  flat: () => ({
    type: 'object',
    properties: { id: { type: 'string' }, limit: { type: 'integer' } },
    required: ['id']
  }),

  // Two levels down, so `fields.teamId` has to appear as its own dotted path.
  nested: () => ({
    type: 'object',
    properties: {
      fields: {
        type: 'object',
        properties: { teamId: { type: 'string' }, title: { type: 'string' } },
        required: ['teamId']
      }
    },
    required: ['fields']
  }),

  // Deeper than MAX_SCHEMA_DEPTH (6). The walk must stop and say `truncated`.
  deep: () => nest(9),

  // A same-document $ref the walker is expected to follow.
  ref: () => ({
    type: 'object',
    $defs: { Team: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    properties: { team: { $ref: '#/$defs/Team' } },
    required: ['team']
  }),

  // A type that refers to itself. Must terminate and record `cyclicRef`,
  // not recurse until the stack gives out.
  cyclic: () => ({
    type: 'object',
    $defs: {
      Node: {
        type: 'object',
        properties: { name: { type: 'string' }, child: { $ref: '#/$defs/Node' } }
      }
    },
    properties: { root: { $ref: '#/$defs/Node' } }
  }),

  // A ref into another document. Must be recorded as unresolved -- "could not
  // see inside" is a different claim from "there is nothing inside".
  'broken-ref': () => ({
    type: 'object',
    properties: { team: { $ref: 'https://example.invalid/schemas/team.json' } }
  }),

  'array-output': () => SHAPES.flat()
};

// MCP requires `outputSchema.type` to be `object` -- the SDK rejects anything
// else -- so a real server cannot return a bare top-level array. The array
// arrives one level in, which is the shape the walker actually has to handle:
// `users[].id`, not `[].id`.
const outputSchemaFor = (shape) =>
  shape === 'array-output'
    ? {
        type: 'object',
        properties: {
          users: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, email: { type: 'string' } },
              required: ['id']
            }
          }
        },
        required: ['users']
      }
    : undefined;

// --- the tool set --------------------------------------------------------

function buildTools() {
  const shape = SHAPES[SHAPE] ?? SHAPES.flat;
  const tools = Array.from({ length: TOOL_COUNT }, (_, i) => ({
    name: 'list_things_' + i,
    title: 'List things ' + i,
    description: 'Fixture tool ' + i + '.',
    inputSchema: shape(),
    outputSchema: outputSchemaFor(SHAPE),
    annotations: { readOnlyHint: true }
  }));

  // The credential-scoped tool. A snapshot taken with a token and a check run
  // without one differ by exactly this one entry -- which, absent scope
  // comparison, reads as a tool removal rather than as a different identity.
  if (TOKEN) {
    tools.push({
      name: 'privileged_audit',
      description: 'Visible only when a credential is presented.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true }
    });
  }
  return tools;
}

const ALL_TOOLS = buildTools();

const RESOURCE_LIST = [
  { uri: 'fixture://docs/readme', name: 'readme', mimeType: 'text/markdown' },
  { uri: 'fixture://docs/changelog', name: 'changelog', mimeType: 'text/markdown' }
];

// --- pagination ----------------------------------------------------------
//
// Cursors are opaque to the client by spec, so they are opaque here too: an
// offset, stringified. `ENDLESS` never stops handing one back, which is the
// only way to reach the page ceiling without generating thousands of tools.

function page(items, cursor) {
  const offset = Number.parseInt(cursor ?? '0', 10) || 0;
  if (ENDLESS) {
    return { items: [items[offset % items.length]], nextCursor: String(offset + 1) };
  }
  if (!PAGE_SIZE) return { items, nextCursor: undefined };
  const next = offset + PAGE_SIZE;
  return {
    items: items.slice(offset, next),
    nextCursor: next < items.length ? String(next) : undefined
  };
}

// --- wiring --------------------------------------------------------------

const capabilities = { tools: {} };
if (RESOURCES !== 'none') capabilities.resources = {};

const server = new Server({ name: 'tether-fixture', version: '1.0.0' }, { capabilities });

/** A promise that never settles: a server that accepts the call and stalls. */
const forever = () => new Promise(() => {});

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  if (MUTE) return forever();
  const { items, nextCursor } = page(ALL_TOOLS, request.params?.cursor);
  return { tools: items, ...(nextCursor ? { nextCursor } : {}) };
});

// Registered only when the capability is declared: the SDK refuses a handler
// for a capability the server did not advertise, which is the correct
// behaviour and also exactly the `capabilities.resources` falsy branch that
// `snapshotConnector` takes.
if (RESOURCES !== 'none') {
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    if (MUTE) return forever();
    // `refuse` is the server that advertises resources and then denies them --
    // common in the wild, and it must not fail the whole snapshot.
    if (RESOURCES === 'refuse') throw new Error('resources are not available to this principal');
    const { items, nextCursor } = page(RESOURCE_LIST, request.params?.cursor);
    return { resources: items, ...(nextCursor ? { nextCursor } : {}) };
  });
}

// Present so the fixture is a well-formed server. If Tether ever calls it
// during a snapshot that is a safety-invariant failure, and the test asserting
// so needs the call to be capable of succeeding -- otherwise the assertion
// could pass because the method was missing rather than because Tether refused.
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: JSON.stringify({ called: request.params.name }) }],
  structuredContent: { called: request.params.name }
}));

await server.connect(new StdioServerTransport());
