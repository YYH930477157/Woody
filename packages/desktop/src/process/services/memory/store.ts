import fs from 'node:fs/promises';
import path from 'node:path';
import type { MemoryEntry, MemoryInput, MemoryType } from '@/common/types/memory';

/**
 * Memory files in aionrs's format: YAML frontmatter with name, description and type,
 * then the body; MEMORY.md lists one line per memory. The agent edits the same files
 * with its ordinary tools, so parsing is lenient and writing keeps every line Woody
 * does not own.
 */

export const INDEX_FILE = 'MEMORY.md';
export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

type Parsed = { name?: string; description?: string; type?: MemoryType; body: string };

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/** Frontmatter keys at the top level, or `type` nested under `metadata:` as some agents write it. */
export function parseMemory(text: string): Parsed {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { body: normalized.trim() };
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const field = /^\s*(name|description|type):\s*(.*)$/.exec(line);
    if (field && !(field[1] in fields)) fields[field[1]] = unquote(field[2]);
  }
  const type = MEMORY_TYPES.find((item) => item === fields.type);
  return {
    name: fields.name || undefined,
    description: fields.description || undefined,
    type,
    body: normalized.slice(match[0].length).replace(/^\n+/, '').trimEnd(),
  };
}

/** A plain YAML scalar when it is safe, otherwise a double-quoted (JSON) one. */
function scalar(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim();
  const plain =
    /^[\p{L}\p{N}][^:#\n]*$/u.test(single) &&
    !/\s$/.test(single) &&
    !/^(true|false|yes|no|on|off|null|~|[\d.+-]+)$/i.test(single);
  return plain ? single : JSON.stringify(single);
}

export function serializeMemory(entry: { name: string; description: string; type?: MemoryType; body: string }): string {
  const lines = ['---', `name: ${scalar(entry.name)}`, `description: ${scalar(entry.description)}`];
  if (entry.type) lines.push(`type: ${entry.type}`);
  return `${lines.join('\n')}\n---\n\n${entry.body.trim()}\n`;
}

/** A file name the agent can also write: ASCII words joined by `-`. */
export function slugFor(name: string, fallback = `memory-${Date.now().toString(36)}`): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug.length >= 3 ? slug : fallback;
}

/** Only a plain `.md` file inside the folder, never MEMORY.md itself. */
export function checkFileName(file: string): string {
  if (
    typeof file !== 'string' ||
    file !== path.basename(file) ||
    !/^[^\\/:*?"<>|]+\.md$/i.test(file) ||
    file.toLowerCase() === INDEX_FILE.toLowerCase()
  )
    throw new Error(`Not a memory file: ${file}`);
  return file;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function listMemories(directory: string): Promise<MemoryEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const read = async (file: string): Promise<MemoryEntry | undefined> => {
    const full = path.join(directory, file);
    try {
      const [text, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
      if (!stat.isFile() || text.includes('�')) return undefined;
      const parsed = parseMemory(text);
      return {
        file,
        name: parsed.name || file.replace(/\.md$/i, ''),
        description: parsed.description || '',
        type: parsed.type,
        body: parsed.body,
        updatedAt: stat.mtimeMs,
      };
    } catch {
      // A file another program holds or deletes mid-scan is simply left out.
      return undefined;
    }
  };
  const files = names.filter((file) => /\.md$/i.test(file) && file.toLowerCase() !== INDEX_FILE.toLowerCase());
  const entries = (await Promise.all(files.map(read))).filter((entry): entry is MemoryEntry => entry !== undefined);
  return entries.toSorted((a, b) => b.updatedAt - a.updatedAt);
}

const indexLine = (entry: { name: string; description: string }, file: string) =>
  `- [${entry.name.replace(/[[\]\n]/g, ' ').trim()}](${file})${entry.description ? ` — ${entry.description.replace(/\n/g, ' ').trim()}` : ''}`;

/** Replace the line that links `file`, or append one; every other line stays as it was. */
async function updateIndex(directory: string, file: string, line: string | undefined): Promise<void> {
  const indexPath = path.join(directory, INDEX_FILE);
  const current = (await readText(indexPath)) ?? '';
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const lines = current ? current.split(/\r?\n/) : [];
  const link = `](${file})`;
  const at = lines.findIndex((item) => item.includes(link));
  if (at >= 0) {
    if (line) lines[at] = line;
    else lines.splice(at, 1);
  } else if (line) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(line);
  } else return;
  const text = lines.join(eol).replace(/\s+$/, '');
  await fs.writeFile(indexPath, text ? `${text}${eol}` : '', 'utf8');
}

/**
 * Create or update one memory and its MEMORY.md line. A new memory gets a file named
 * after `slug` (or its name); an existing name is never overwritten by a new memory.
 */
export async function saveMemory(directory: string, input: MemoryInput, slug?: string): Promise<MemoryEntry> {
  const name = input.name.trim();
  const body = input.body.trim();
  if (!name || !body) throw new Error('A memory needs a name and a body');
  if (input.type && !MEMORY_TYPES.includes(input.type)) throw new Error(`Unknown memory type: ${input.type}`);
  await fs.mkdir(directory, { recursive: true });
  let file: string;
  if (input.file) {
    file = checkFileName(input.file);
  } else {
    const base = slugFor(slug || name);
    file = `${base}.md`;
    // Each name is checked only after the previous one turned out to be taken.
    // eslint-disable-next-line no-await-in-loop
    for (let suffix = 2; (await readText(path.join(directory, file))) !== undefined; suffix++)
      file = `${base}-${suffix}.md`;
  }
  const entry = { name, description: input.description.trim(), type: input.type, body };
  await fs.writeFile(path.join(directory, file), serializeMemory(entry), 'utf8');
  await updateIndex(directory, file, indexLine(entry, file));
  const stat = await fs.stat(path.join(directory, file));
  return { file, ...entry, description: entry.description, updatedAt: stat.mtimeMs };
}

/** Remove a memory through `trash` (the recycle bin in the app) and drop its MEMORY.md line. */
export async function removeMemory(
  directory: string,
  file: string,
  trash: (target: string) => Promise<void>
): Promise<void> {
  const target = path.join(directory, checkFileName(file));
  if ((await readText(target)) !== undefined) await trash(target);
  await updateIndex(directory, file, undefined);
}
