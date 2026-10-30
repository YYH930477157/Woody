import type { ShelfFile } from '@/common/types/sourceControl/storageTypes';
import { MAX_PATCH, validatePath } from './core';

export type PatchSection = { file: ShelfFile; patch: string };

/** Decode Git's C-quoted UTF-8 paths, including octal bytes. */
function decode(value: string): string {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) throw new Error('Malformed quoted patch path');
  const bytes: number[] = [];
  for (let i = 1; i < value.length - 1; i++) {
    if (value[i] !== '\\') {
      const code = value.codePointAt(i)!;
      bytes.push(...Buffer.from(String.fromCodePoint(code)));
      if (code > 0xffff) i++;
      continue;
    }
    const escaped = value[++i];
    const octal = /^[0-7]{1,3}/.exec(value.slice(i));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += octal[0].length - 1;
    } else if (escaped === '\\' || escaped === '"') bytes.push(escaped.charCodeAt(0));
    else {
      const control: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
      if (!(escaped in control)) throw new Error('Unsupported quoted patch escape');
      bytes.push(control[escaped]);
    }
  }
  const buffer = Buffer.from(bytes);
  const decoded = buffer.toString('utf8');
  if (!Buffer.from(decoded).equals(buffer)) throw new Error('Patch path is not valid UTF-8');
  return decoded;
}

function candidates(header: string): [string, string][] {
  const body = header.slice('diff --git '.length);
  const result: [string, string][] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== ' ') continue;
    try {
      const left = decode(body.slice(0, i));
      const right = decode(body.slice(i + 1));
      if (left.startsWith('a/') && right.startsWith('b/')) result.push([left.slice(2), right.slice(2)]);
    } catch {
      /* Other split points are inside quoted names. */
    }
  }
  return result;
}

/** Parse complete Git patches without treating quoted names or rename headers as shell syntax. */
export function parsePatch(patch: string): PatchSection[] {
  if (!patch || Buffer.byteLength(patch) > MAX_PATCH || patch.includes('\0') || !patch.startsWith('diff --git ')) {
    throw new Error('Patch is empty, malformed, or exceeds size limit');
  }
  const seen = new Set<string>();
  return patch.split(/^(?=diff --git )/m).map((section) => {
    const lines = section.split('\n');
    if (lines.some((line) => /^(?:old mode|new mode|new file mode|deleted file mode) (?:120000|160000)/.test(line))) {
      throw new Error('Symlink and submodule patches are not supported');
    }
    const metadata = lines.slice(
      1,
      lines.findIndex((line) => line.startsWith('@@') || line === 'GIT binary patch') < 0
        ? undefined
        : lines.findIndex((line) => line.startsWith('@@') || line === 'GIT binary patch')
    );
    const single = (prefix: string) => {
      const matches = metadata.filter((line) => line.startsWith(prefix));
      if (matches.length > 1) throw new Error('Duplicate patch path header');
      return matches[0] === undefined ? undefined : decode(matches[0].slice(prefix.length));
    };
    const from = single('rename from ');
    const to = single('rename to ');
    if ((from === undefined) !== (to === undefined) || metadata.some((line) => /^copy (from|to) /.test(line)))
      throw new Error('Unsupported incomplete rename or copy patch');
    const old = single('--- ');
    const next = single('+++ ');
    if ((old === undefined) !== (next === undefined)) throw new Error('Incomplete patch file headers');
    const oldName = old?.startsWith('a/')
      ? old.slice(2)
      : old === '/dev/null' || old === undefined
        ? undefined
        : (() => {
            throw new Error('Invalid old patch path');
          })();
    const newName = next?.startsWith('b/')
      ? next.slice(2)
      : next === '/dev/null' || next === undefined
        ? undefined
        : (() => {
            throw new Error('Invalid new patch path');
          })();
    const headerPaths = candidates(lines[0]).filter(([a, b]) => {
      if (from !== undefined) return a === from && b === to;
      if (oldName !== undefined && newName !== undefined) return a === oldName && b === newName;
      const known = oldName ?? newName;
      return a === b && (known === undefined || a === known);
    });
    if (headerPaths.length !== 1) throw new Error('Ambiguous or inconsistent patch paths');
    const [a, b] = headerPaths[0];
    validatePath(a);
    validatePath(b);
    if ((from && oldName && from !== oldName) || (to && newName && to !== newName))
      throw new Error('Inconsistent rename paths');
    if (seen.has(b)) throw new Error('Duplicate patch file');
    seen.add(b);
    const status = from
      ? 'R'
      : metadata.some((line) => line.startsWith('new file mode '))
        ? 'A'
        : metadata.some((line) => line.startsWith('deleted file mode '))
          ? 'D'
          : 'M';
    return {
      file: { path: b, ...(a !== b ? { oldPath: a } : {}), status, binary: lines.includes('GIT binary patch') },
      patch: section,
    };
  });
}

export function selectSections(sections: PatchSection[], paths?: string[]): PatchSection[] {
  if (!paths) return sections;
  const selected = new Set(paths.map(validatePath));
  if (!selected.size || [...selected].some((file) => !sections.some((section) => section.file.path === file)))
    throw new Error('Selected file is not in this shelf');
  return sections.filter((section) => selected.has(section.file.path));
}
