import { randomUUID } from 'node:crypto';
import { open, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { GitExecutor } from '../executor';
import { OperationBlocked } from '../operations/engine';
import { MAX_INDEX_BYTES, readBounded, repositoryState, workingBytes, type MergeRepositoryState } from './repository';

/** Install one reviewed object through a private index while holding Git's actual index lock. */
export async function stageReviewed(
  root: string,
  file: string,
  bytes: Buffer | null,
  mode: string,
  oid: string | null,
  expected: MergeRepositoryState,
  git: GitExecutor
) {
  const object =
    bytes === null
      ? null
      : (oid ??
        (await git(root, ['hash-object', '-w', '--stdin', `--path=${file}`], false, { input: bytes })).stdout.trim());
  if (object !== null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(object))
    throw new Error('Invalid reviewed Git object');
  const lockPath = expected.indexPath + '.lock';
  let lock: FileHandle;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new OperationBlocked('Git index is locked; recovery retained');
    throw error;
  }
  const temporary = path.join(path.dirname(expected.indexPath), '.woody-merge-index-' + randomUUID());
  let installed = false;
  const verify = async () => {
    if ((await repositoryState(root, git)).identity !== expected.identity)
      throw new OperationBlocked('Repository changed before staging; recovery retained');
    const actual = await workingBytes(root, file);
    if (actual === null ? bytes !== null : bytes === null || !actual.equals(bytes))
      throw new OperationBlocked('Working file changed before staging; recovery retained');
  };
  try {
    await verify();
    await writeFile(temporary, expected.indexBytes, { flag: 'wx', mode: 0o600 });
    await git(
      root,
      object === null
        ? ['update-index', '--force-remove', '--', file]
        : ['update-index', '--add', '--cacheinfo', mode, object, file],
      false,
      { indexFile: temporary }
    );
    const prepared = await readBounded(temporary, MAX_INDEX_BYTES);
    // Git and external editors had time to run while the private index was prepared.
    // A changed working file is left unstaged and the original unmerged index remains intact.
    await verify();
    await lock.writeFile(prepared);
    await lock.sync();
    await lock.close();
    await rename(lockPath, expected.indexPath);
    installed = true;
  } finally {
    await lock.close();
    if (!installed) await rm(lockPath, { force: true });
    await rm(temporary, { force: true });
    await rm(temporary + '.lock', { force: true });
  }
}
