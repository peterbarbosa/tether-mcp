// The manifest spec: what a skill declares about the world it depends on.
//
// A skill can name its connectors, the tools it calls, and the *instances* it
// assumes exist -- a project key, a wiki path, a channel. Once declared, drift
// checking is a lookup rather than an inference, and no model is involved.
//
//   ---
//   name: file-a-bug
//   tether:
//     connectors: [linear]
//     tools:
//       - linear.create_issue
//     identifiers:
//       - id: platform-team
//         connector: linear
//         probe: list_teams        # a read-only tool that enumerates
//         match: name              # the field in each result to compare
//         value: Platform          # what this skill assumes exists
//   ---
//
// Everything under `tether:` is optional. A skill with no manifest still gets
// tool-reference checking via the index; the manifest is what unlocks
// instance-level resolution.

/** Split a Markdown file into [frontmatterText, body]. */
export function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return match ? [match[1], text.slice(match[0].length)] : [null, text];
}

/**
 * A deliberately small YAML subset: nested maps, sequences of scalars,
 * sequences of maps, inline `[a, b]` flow sequences, quoted scalars.
 *
 * Tether parses only its own `tether:` block, so anything it cannot represent
 * is a manifest that should be simplified rather than a parser to extend.
 */
export function parseYamlSubset(text) {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s*#/.test(line));
  const [value] = parseBlock(lines, 0, indentOf(lines[0] ?? ''));
  return value;
}

const indentOf = (line) => line.length - line.trimStart().length;

function parseBlock(lines, start, indent) {
  const isSequence = lines[start]?.trim().startsWith('- ');
  return isSequence ? parseSequence(lines, start, indent) : parseMap(lines, start, indent);
}

function parseMap(lines, start, indent) {
  const map = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (indentOf(line) < indent) break;
    if (indentOf(line) > indent) { i++; continue; } // defensive: skip stray deeper lines
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!match) break;
    const key = match[1].trim();
    const inline = match[2].trim();
    if (inline) {
      map[key] = parseScalar(inline);
      i++;
    } else {
      const nextIndent = indentOf(lines[i + 1] ?? '');
      if (i + 1 >= lines.length || nextIndent <= indent) {
        // A sequence may sit at the same indentation as its key.
        if (lines[i + 1]?.trim().startsWith('- ') && nextIndent === indent) {
          const [value, next] = parseSequence(lines, i + 1, indent);
          map[key] = value;
          i = next;
          continue;
        }
        map[key] = null;
        i++;
      } else {
        const [value, next] = parseBlock(lines, i + 1, nextIndent);
        map[key] = value;
        i = next;
      }
    }
  }
  return [map, i];
}

function parseSequence(lines, start, indent) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (indentOf(line) !== indent || !line.trim().startsWith('- ')) break;
    const rest = line.trim().slice(2).trim();
    if (/^[^:\s]+:/.test(rest)) {
      // A sequence of maps: re-indent the first key so it parses as a block.
      const itemIndent = line.indexOf('- ') + 2;
      const block = [' '.repeat(itemIndent) + rest];
      let j = i + 1;
      while (j < lines.length && indentOf(lines[j]) >= itemIndent && !lines[j].trim().startsWith('- ')) {
        block.push(lines[j]);
        j++;
      }
      const [value] = parseMap(block, 0, itemIndent);
      items.push(value);
      i = j;
    } else {
      items.push(parseScalar(rest));
      i++;
    }
  }
  return [items, i];
}

function parseScalar(raw) {
  const text = raw.trim();
  if (/^\[.*\]$/.test(text)) {
    const inner = text.slice(1, -1).trim();
    return inner ? inner.split(',').map((v) => parseScalar(v)) : [];
  }
  if (/^["'].*["']$/.test(text)) return text.slice(1, -1);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/** A tool reference is written `connector.tool_name`. */
export function parseToolRef(ref, fallbackConnector = null) {
  const dot = String(ref).indexOf('.');
  if (dot === -1) return { connector: fallbackConnector, tool: String(ref) };
  return { connector: ref.slice(0, dot), tool: ref.slice(dot + 1) };
}

/**
 * Read the `tether:` block out of a skill's frontmatter.
 * Returns a normalized manifest, plus any problems worth telling a human about.
 */
export function readManifest(text) {
  const [frontmatter] = splitFrontmatter(text);
  const empty = { name: null, connectors: [], tools: [], identifiers: [], declared: false, problems: [] };
  if (!frontmatter) return empty;

  let parsed;
  try {
    parsed = parseYamlSubset(frontmatter);
  } catch {
    return { ...empty, problems: ['frontmatter could not be parsed'] };
  }

  const name = typeof parsed?.name === 'string' ? parsed.name : null;
  const block = parsed?.tether;
  if (!block || typeof block !== 'object') return { ...empty, name };

  const problems = [];
  const connectors = asArray(block.connectors).map(String);
  const tools = asArray(block.tools).map((ref) => parseToolRef(ref, connectors[0] ?? null));

  const identifiers = asArray(block.identifiers).map((raw, index) => {
    const id = raw?.id ?? `identifier-${index + 1}`;
    const identifier = {
      id: String(id),
      connector: raw?.connector ?? connectors[0] ?? null,
      probe: raw?.probe ?? null,
      match: raw?.match ?? 'name',
      value: raw?.value ?? null,
      args: raw?.args && typeof raw.args === 'object' ? raw.args : {}
    };
    for (const field of ['connector', 'probe', 'value']) {
      if (identifier[field] === null || identifier[field] === undefined) {
        problems.push(`identifier "${identifier.id}" is missing \`${field}\` and cannot be resolved`);
      }
    }
    return identifier;
  });

  for (const ref of tools) {
    if (!ref.connector) problems.push(`tool "${ref.tool}" has no connector; write it as \`connector.tool\``);
  }

  return { name, connectors, tools, identifiers, declared: true, problems };
}

const asArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
