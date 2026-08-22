import { buildLock } from '../src/lock.js';

/** Build a lock from a terse tool spec, for tests. */
export const lockOf = (tools, extra = {}) =>
  buildLock({ id: 'test', transport: 'stdio', target: 'x', tools, ...extra });

/** A tool with the given params: { paramName: { type, required, enum } } */
export const tool = (name, params = {}, extra = {}) => ({
  name,
  description: extra.description ?? 'a tool',
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(params).map(([k, v]) => [
        k,
        { type: v.type ?? 'string', ...(v.enum ? { enum: v.enum } : {}) }
      ])
    ),
    required: Object.entries(params)
      .filter(([, v]) => v.required)
      .map(([k]) => k)
  },
  ...extra
});
