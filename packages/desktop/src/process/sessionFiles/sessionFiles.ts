/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  SessionFilesRef,
  SessionFolderNames,
  SessionFolderState,
  SessionFoldersTrashResult,
} from '@/common/adapter/ipcBridge';

/**
 * Each conversation started in a user's workspace gets
 * `<workspace>/.woody/<root>/<date>_<label>/{<work>,<output>}`; the agent is told to keep
 * the files it creates there. Only the root is created up front, with a `.gitignore` that
 * hides the whole tree from Git; the conversation folders are created by the agent on its
 * first write, so a chat that writes nothing leaves nothing behind.
 */

const LABEL_LENGTH = 20;
const NAME_LENGTH = 40;
const MAX_SUFFIX = 999;
const FILE_COUNT_CAP = 10_000;
const FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}_/;
const GITIGNORE = '# Woody keeps the files each chat creates here. None of them belong in Git.\n*\n';
const FALLBACK_NAMES: SessionFolderNames = { root: 'chat-files', work: 'work', output: 'output', untitled: 'untitled' };

/**
 * Letters, digits, `-`, `_` and `.` only, so a path can be pasted into PowerShell, cmd or a
 * POSIX shell unquoted, and is legal on every file system. Everything else becomes `_`.
 */
export function safeSegment(text: string, maxLength: number): string {
  const kept = Array.from(text.normalize('NFC'))
    .map((char) => (/[\p{L}\p{N}\p{M}._-]/u.test(char) ? char : '_'))
    .join('')
    .replace(/_+/g, '_')
    .replace(/^[._-]+/, '');
  return Array.from(kept)
    .slice(0, maxLength)
    .join('')
    .replace(/[._-]+$/, '');
}

/** The first sentence of the first non-empty line of a chat's opening message. */
export function firstSentence(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim()) ?? '';
  return (line.split(/[。！？；!?;]|\.(?=\s|$)/u)[0] ?? '').trim();
}

const pad = (value: number) => String(value).padStart(2, '0');

function localDate(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `<date>_<label>`, labelled by the first sentence or, when it has no usable text, by `untitled`. */
export function sessionFolderName(title: string, untitled: string, now: Date): string {
  const label =
    safeSegment(firstSentence(title), LABEL_LENGTH) || safeSegment(untitled, LABEL_LENGTH) || FALLBACK_NAMES.untitled;
  return `${localDate(now)}_${label}`;
}

/**
 * True only for an absolute `<anything>/.woody/<root>/<date>_<label>` path. Inspecting and
 * trashing refuse everything else, so a damaged `extra` can never point them at a project.
 */
export function isSessionFolder(dir: string): boolean {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
  if (dir.split(/[\\/]+/).some((segment) => segment === '..' || segment === '.')) return false;
  const folder = path.resolve(dir);
  const root = path.dirname(folder);
  return (
    path.basename(path.dirname(root)) === '.woody' && root !== folder && FOLDER_PATTERN.test(path.basename(folder))
  );
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureGitignore(root: string): Promise<void> {
  try {
    await fs.writeFile(path.join(root, '.gitignore'), GITIGNORE, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** Files under `dir`, not following links, stopping at the cap. */
async function countFiles(dir: string): Promise<number> {
  let count = 0;
  const pending = [dir];
  while (pending.length > 0 && count < FILE_COUNT_CAP) {
    const current = pending.pop() as string;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      else count += 1;
    }
  }
  return Math.min(count, FILE_COUNT_CAP);
}

/** A real folder, not a link that could lead outside the workspace. */
async function isPlainFolder(dir: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** A folder, reached through links if need be: a workspace may itself be a link. */
async function isFolder(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Windows paths differ only in case when they name the same folder. */
const pathKey = (dir: string) => (process.platform === 'win32' ? dir.toLowerCase() : dir);

const uniqueDirs = (dirs: unknown): string[] =>
  Array.isArray(dirs) ? [...new Set(dirs.filter((dir): dir is string => typeof dir === 'string'))] : [];

export type PrepareSessionFilesRequest = { workspace: string; title: string; names: SessionFolderNames };

export type SessionFilesServiceDeps = {
  now: () => Date;
  /** Move a folder to the system trash. */
  trash: (dir: string) => Promise<void>;
  warn?: (message: string, error: unknown) => void;
};

export function createSessionFilesService(deps: SessionFilesServiceDeps) {
  const warn = deps.warn ?? ((message: string, error: unknown) => console.warn(`[SessionFiles] ${message}`, error));
  // Folders handed out this run but not yet created by their agent; two chats with the same
  // first sentence on the same day must still get different folders.
  const handedOut = new Set<string>();

  return {
    /** Pick this chat's folders, or `null` when the workspace is unusable; never throws. */
    async prepare(request: PrepareSessionFilesRequest): Promise<SessionFilesRef | null> {
      try {
        const workspace = typeof request?.workspace === 'string' ? request.workspace.trim() : '';
        if (!workspace || !path.isAbsolute(workspace) || !(await isFolder(workspace))) return null;
        const names = request.names ?? FALLBACK_NAMES;
        const root = path.join(workspace, '.woody', safeSegment(names.root ?? '', NAME_LENGTH) || FALLBACK_NAMES.root);
        const work = safeSegment(names.work ?? '', NAME_LENGTH) || FALLBACK_NAMES.work;
        const outputName = safeSegment(names.output ?? '', NAME_LENGTH) || FALLBACK_NAMES.output;
        // A translation that gives both folders one name must not merge them.
        const output = outputName.toLowerCase() === work.toLowerCase() ? `${outputName}-2` : outputName;
        await fs.mkdir(root, { recursive: true });
        await ensureGitignore(root);
        const base = sessionFolderName(request.title ?? '', names.untitled ?? '', deps.now());
        for (let suffix = 1; suffix <= MAX_SUFFIX; suffix += 1) {
          const dir = path.join(root, suffix === 1 ? base : `${base}-${suffix}`);
          if (handedOut.has(pathKey(dir)) || (await pathExists(dir))) continue;
          handedOut.add(pathKey(dir));
          return { dir, work_dir: path.join(dir, work), output_dir: path.join(dir, output) };
        }
        return null;
      } catch (error) {
        warn('Could not prepare the chat folder', error);
        return null;
      }
    },

    /** The given chat folders that exist, with how many files each holds. */
    async inspect(dirs: string[]): Promise<SessionFolderState[]> {
      const states: SessionFolderState[] = [];
      for (const dir of uniqueDirs(dirs)) {
        if (!isSessionFolder(dir) || !(await isPlainFolder(dir))) continue;
        states.push({ dir, files: await countFiles(dir) });
      }
      return states;
    },

    /**
     * Move chat folders to the trash. A folder that is already gone needs nothing; anything
     * that is not a chat folder, or is a link, is refused.
     */
    async trash(dirs: string[]): Promise<SessionFoldersTrashResult> {
      const result: SessionFoldersTrashResult = { trashed: [], failed: [] };
      for (const dir of uniqueDirs(dirs)) {
        if (isSessionFolder(dir) && !(await pathExists(dir))) continue;
        if (!isSessionFolder(dir) || !(await isPlainFolder(dir))) {
          result.failed.push(dir);
          continue;
        }
        try {
          await deps.trash(dir);
          handedOut.delete(pathKey(dir));
          result.trashed.push(dir);
        } catch (error) {
          warn('Could not move a chat folder to the trash', error);
          result.failed.push(dir);
        }
      }
      return result;
    },
  };
}

export type SessionFilesService = ReturnType<typeof createSessionFilesService>;
