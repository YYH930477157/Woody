import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitMergeStage } from '@/common/types/sourceControl/mergeTypes';
import type { GitExecutor } from '../executor';
import { inspectOperation, OperationBlocked } from '../operations/engine';
import { MAX_MERGE_BYTES, mergePathSchema } from './validation';

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Bound file reads before allocating their contents, including private Git indexes. */
export async function readBounded(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size > limit) throw new OperationBlocked('File exceeds size limit');
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) return buffer.subarray(0, length);
      length += bytesRead;
    }
    throw new OperationBlocked('File changed during bounded read');
  } finally {
    await handle.close();
  }
}
export const MAX_INDEX_BYTES = 16 * 1024 * 1024;
/** Reject links at every path component, including Windows directory junctions and the final file. */
export async function safeFile(root: string, file: string) {
  mergePathSchema.parse(file);
  const parts = file.split(/[\\/]/);
  let target = root;
  for (let i = 0; i < parts.length; i++) {
    target = path.join(target, parts[i]);
    try {
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()))
        throw new OperationBlocked('Merge path is a symlink, junction, or unsupported file type');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (path.relative(root, target).startsWith('..') || path.isAbsolute(path.relative(root, target)))
    throw new OperationBlocked('Merge path escapes repository');
  return target;
}
export async function workingBytes(root: string, file: string): Promise<Buffer | null> {
  const target = await safeFile(root, file);
  try {
    const handle = await open(target, 'r');
    try {
      if ((await handle.stat()).size > MAX_MERGE_BYTES) throw new OperationBlocked('Merge file exceeds size limit');
      const bytes = await handle.readFile();
      if (bytes.length > MAX_MERGE_BYTES) throw new OperationBlocked('Merge file exceeds size limit');
      await safeFile(root, file);
      return bytes;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export function decode(bytes: Buffer | null): { text: string | null; binary: boolean } {
  if (bytes === null) return { text: null, binary: false };
  if (bytes.includes(0)) return { text: null, binary: true };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), binary: false };
  } catch {
    return { text: null, binary: true };
  }
}
export async function repositoryState(root: string, git: GitExecutor) {
  const operation = await inspectOperation(root, git);
  const indexPath = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).stdout.trim());
  const indexBytes = await readBounded(indexPath, MAX_INDEX_BYTES);
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
  const branchResult = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
  if (branchResult.code !== 0 && branchResult.code !== 1) throw new Error('Unable to read current branch');
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;
  const index = (await git(root, ['ls-files', '--stage', '-z'])).stdout;
  const gitDir = path.resolve(root, (await git(root, ['rev-parse', '--git-dir'])).stdout.trim());
  const markers: Record<string, string> = {};
  for (const marker of [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'REBASE_HEAD',
    'rebase-merge/head-name',
    'rebase-merge/onto',
    'rebase-apply/head-name',
    'rebase-apply/onto',
  ]) {
    try {
      const value = await readFile(path.join(gitDir, marker));
      if (value.length > 4096) throw new OperationBlocked('Invalid operation marker');
      markers[marker] = value.toString('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!(await readBounded(indexPath, MAX_INDEX_BYTES)).equals(indexBytes))
    throw new OperationBlocked('Git index changed while reading snapshot');
  return {
    head,
    branch,
    index,
    operation,
    indexPath,
    indexBytes,
    identity: digest(JSON.stringify({ head, branch, index, operation, markers, indexDigest: digest(indexBytes) })),
  };
}
export type MergeRepositoryState = Awaited<ReturnType<typeof repositoryState>>;
export const fileVersion = (state: MergeRepositoryState, file: string, bytes: Buffer | null) =>
  digest(JSON.stringify([state.identity, file, bytes === null ? null : digest(bytes)]));
export async function stageFor(
  root: string,
  git: GitExecutor,
  state: MergeRepositoryState,
  file: string,
  stage: number
): Promise<{ view: GitMergeStage; bytes: Buffer | null }> {
  const record = state.index
    .split('\0')
    .find((line) => line.endsWith('\t' + file) && line.slice(0, line.indexOf('\t')).endsWith(' ' + stage));
  if (!record) return { view: { oid: null, mode: null, text: null, binary: false, deleted: true }, bytes: null };
  const [mode, oid] = record.split(' ');
  if (!['100644', '100755'].includes(mode))
    throw new OperationBlocked('Symlink and submodule conflicts are unsupported');
  const result = await git(root, ['cat-file', 'blob', oid], false, { binary: true, maxBuffer: MAX_MERGE_BYTES });
  if (!result.buffer) throw new Error('Git executor did not provide exact blob bytes');
  return { view: { oid, mode, ...decode(result.buffer), deleted: false }, bytes: result.buffer };
}
/** Atomic replacement does not follow a final symlink and retains executable-file mode. */
export async function replaceWorking(root: string, file: string, bytes: Buffer | null, mode: string | null) {
  const target = await safeFile(root, file);
  if (bytes === null) {
    try {
      await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return;
  }
  const temporary = path.join(path.dirname(target), '.woody-merge-' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
    await safeFile(root, file);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
