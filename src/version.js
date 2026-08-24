// One source of truth for the version.
//
// It was hardcoded in five places -- the client handshake, the server
// handshake, and the snapshot sidecar -- which is exactly the drift Tether
// exists to complain about. Read it from the manifest instead.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
).version;
