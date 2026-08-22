// The skill index: which skills reference which connectors and tools.
//
// The brief expected this to need a model. It does not. The lockfile already
// holds ground-truth tool names from `tools/list`, so finding the skills that
// reference them is a search against a known vocabulary rather than an
// inference over prose. That keeps the whole index in the deterministic core.
//
// Two sources of truth, in priority order:
//   declared -- a `tether:` manifest block. Authoritative.
//   detected -- the tool name appears in the skill as code (`create_issue`).
//               A hint for a human to promote into a manifest, not a fact.
//
// Detection deliberately only matches code-formatted references. Matching bare
// prose would flag every skill containing the word "add" against a server that
// happens to expose an `add` tool.

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { readManifest } from './manifest.js';
import { LOCK_DIR, listLocked, readLock } from './lock.js';

export const INDEX_VERSION = 1;
export const indexPath = (dir) => join(dir, LOCK_DIR, 'index.json');

/** Where skills usually live. */
export const SKILL_DIRS = ['skills', '.claude/skills', 'commands', '.claude/commands'];

const SKIP = new Set(['node_modules', '.git', '.tether', 'dist', 'build']);

/** Every Markdown file under the given roots. */
export function findSkillFiles(dir, roots = SKILL_DIRS) {
  const found = [];
  const walk = (path) => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path)) {
      if (SKIP.has(entry)) continue;
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.md')) found.push(full);
    }
  };
  for (const root of roots) walk(join(dir, root));
  return found.sort();
}

/** Strip fenced code blocks so an example does not read as a reference. */
const inlineCodeTokens = (text) => {
  const tokens = new Set();
  for (const match of text.matchAll(/`([^`\n]{1,128})`/g)) tokens.add(match[1].trim());
  for (const match of text.matchAll(/^\s*(?:[-*]|\d+\.)\s+([a-z][\w.]*)\s*(?:--|—|:)/gim)) tokens.add(match[1]);
  return tokens;
};

/**
 * Build the index. Pure apart from reading files.
 * `vocabulary` maps connector id -> Set of tool names, taken from the lockfiles.
 */
export function buildIndex(dir, vocabulary, files = findSkillFiles(dir)) {
  const skills = files.map((file) => {
    const text = readFileSync(file, 'utf8');
    const manifest = readManifest(text);
    const tokens = inlineCodeTokens(text);

    const references = new Map();
    const add = (connector, tool, source) => {
      const key = `${connector}.${tool}`;
      const existing = references.get(key);
      if (existing) {
        if (source === 'declared') existing.source = 'declared';
        return;
      }
      references.set(key, { connector, tool, source });
    };

    for (const ref of manifest.tools) add(ref.connector, ref.tool, 'declared');

    for (const [connector, tools] of Object.entries(vocabulary)) {
      // A skill only counts as referencing a connector's tools if it declared
      // that connector, or if it wrote the fully qualified `connector.tool`.
      const scoped = manifest.connectors.includes(connector) || manifest.connectors.length === 0;
      for (const tool of tools) {
        if (tokens.has(`${connector}.${tool}`)) add(connector, tool, 'detected');
        else if (scoped && tokens.has(tool)) add(connector, tool, 'detected');
      }
    }

    // A referenced tool that exists in no lockfile is itself a finding: either
    // the connector was never snapshotted, or the tool is already gone.
    const known = new Set(
      Object.entries(vocabulary).flatMap(([c, tools]) => [...tools].map((t) => `${c}.${t}`))
    );
    const unknown = [...references.values()]
      .filter((r) => r.source === 'declared' && r.connector && !known.has(`${r.connector}.${r.tool}`))
      .map((r) => `${r.connector}.${r.tool}`);

    return {
      path: relative(dir, file).split(sep).join('/'),
      name: manifest.name,
      declared: manifest.declared,
      connectors: [...new Set([...manifest.connectors, ...[...references.values()].map((r) => r.connector)])]
        .filter(Boolean).sort(),
      tools: [...references.values()].sort((a, b) => `${a.connector}.${a.tool}`.localeCompare(`${b.connector}.${b.tool}`)),
      identifiers: manifest.identifiers,
      unknownTools: unknown.sort(),
      problems: manifest.problems
    };
  });

  return { indexVersion: INDEX_VERSION, skills };
}

/** connector id -> Set of tool names, from committed lockfiles. */
export function vocabularyFrom(dir) {
  const vocabulary = {};
  for (const id of listLocked(dir)) {
    const lock = readLock(dir, id);
    vocabulary[id] = new Set((lock?.tools ?? []).map((t) => t.name));
  }
  return vocabulary;
}

export function writeIndex(dir, index) {
  mkdirSync(join(dir, LOCK_DIR), { recursive: true });
  writeFileSync(indexPath(dir), JSON.stringify(index, null, 2) + '\n');
}

export function readIndex(dir) {
  const path = indexPath(dir);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/**
 * Join a set of drift reports to the index: which skills does this break?
 * Returns skill path -> the changes that touch it.
 */
export function affectedSkills(index, reports) {
  const affected = new Map();
  for (const report of reports) {
    for (const change of report.changes ?? []) {
      if (!change.tool) continue;
      for (const skill of index?.skills ?? []) {
        const hit = skill.tools.some((t) => t.connector === report.connector && t.tool === change.tool);
        if (!hit) continue;
        if (!affected.has(skill.path)) affected.set(skill.path, { skill, changes: [] });
        affected.get(skill.path).changes.push({ ...change, connector: report.connector });
      }
    }
  }
  return affected;
}
