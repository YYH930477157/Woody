import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GitCommitMode, GitCommitResult, GitCommitSnapshot } from '@/common/types/sourceControl/gitWorkflowTypes';
import {
  createCommitWorkspace,
  hasActiveHistoryOperation,
  readOptional,
  runRequired,
  type CommitRepository,
  type GitCommandRunner,
} from './workspace';

const changed = (
  stderr = 'Git HEAD, branch, or the reviewed commit tree changed during commit creation'
): GitCommitResult => ({ ok: false, kind: 'snapshot-changed', stdout: '', stderr });
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const commitHeaders = (raw: string) => raw.split('\n\n', 1)[0].split('\n');
const commitParents = (headers: string[]) =>
  headers
    .filter((line) => line.startsWith('parent '))
    .map((line) => line.slice(7))
    .join(' ');

export const publishCheckedCommit = async (
  runner: GitCommandRunner,
  cwd: string,
  paths: string[],
  message: string,
  snapshot: GitCommitSnapshot,
  indexPath: string,
  repository: CommitRepository,
  mode?: GitCommitMode
): Promise<GitCommitResult> => {
  const busy: GitCommitResult = {
    ok: false,
    kind: 'command-failed',
    stdout: '',
    stderr:
      'A history operation or pending history publication is in progress. Inspect the repository to recover pending publication, then finish or abort the operation before preparing a checked commit.',
  };
  if (await hasActiveHistoryOperation(repository.gitDir)) return busy;
  const workspace = await createCommitWorkspace(runner, cwd, indexPath, repository, snapshot);
  const options = { cwd, env: workspace.env };
  const originalHeaders = mode
    ? commitHeaders(await runRequired(runner, ['cat-file', 'commit', snapshot.head!], options))
    : [];
  const expectedParents = mode ? commitParents(originalHeaders) : (snapshot.head ?? '');
  const shallow = await readOptional(join(workspace.gitDir, 'shallow'));
  if (mode && expectedParents && shallow?.toString('utf8').split(/\r?\n/).includes(snapshot.head!)) {
    return {
      ok: false,
      kind: 'command-failed',
      stdout: '',
      stderr:
        'Cannot amend the shallow history boundary without removing its original parents. Deepen the clone to include the parent commits, then prepare Amend again.',
    };
  }
  const commit = await runner(['commit', ...(mode ? ['--amend'] : []), '-m', message], options);
  if (commit.exitCode !== 0) return { ok: false, kind: 'command-failed', stdout: commit.stdout, stderr: commit.stderr };
  const candidate = (await runRequired(runner, ['rev-parse', '--verify', 'HEAD'], options)).trim();
  const tree = (await runRequired(runner, ['rev-parse', `${candidate}^{tree}`], options)).trim();
  const candidateHeaders = commitHeaders(await runRequired(runner, ['cat-file', 'commit', candidate], options));
  if (
    tree !== snapshot.tree ||
    commitParents(candidateHeaders) !== expectedParents ||
    (mode &&
      candidateHeaders.find((line) => line.startsWith('author ')) !==
        originalHeaders.find((line) => line.startsWith('author ')))
  )
    return changed();

  const headLock = join(repository.gitDir, 'HEAD.lock');
  const indexLock = `${repository.indexPath}.lock`;
  let ownsHeadLock = false;
  let ownsIndexLock = false;
  let published = false;
  const warnings: string[] = [];
  try {
    const lock = await open(headLock, 'wx');
    ownsHeadLock = true;
    await lock.close();
    const actualHead = (await readFile(join(repository.gitDir, 'HEAD'), 'utf8')).trim();
    const expectedHead = workspace.headRef ? `ref: ${workspace.headRef}` : snapshot.head;
    if (actualHead !== expectedHead) return changed();
    if (await hasActiveHistoryOperation(repository.gitDir)) return busy;

    let refreshedIndex: Buffer | undefined;
    try {
      const indexHandle = await open(indexLock, 'wx');
      ownsIndexLock = true;
      await indexHandle.close();
      const currentIndex = await readOptional(repository.indexPath);
      if (repository.index === null ? currentIndex !== null : !currentIndex?.equals(repository.index)) {
        warnings.push('Commit created; the index changed during creation and was preserved.');
      } else {
        const refreshPath = join(dirname(indexPath), 'refresh-index');
        const refreshOptions = { cwd, env: { ...workspace.env, GIT_INDEX_FILE: refreshPath } };
        if (repository.index) await writeFile(refreshPath, repository.index);
        else await runRequired(runner, ['read-tree', '--empty'], refreshOptions);
        // Never read mutable live HEAD here, including after publication.
        const refresh = await runner(['reset', candidate, '--', ...paths], refreshOptions);
        if (refresh.exitCode !== 0)
          warnings.push(refresh.stderr || 'Commit created, but selected index refresh failed');
        else refreshedIndex = await readFile(refreshPath);
      }
    } catch (error) {
      warnings.push(`Commit created, but the index was preserved: ${messageOf(error)}`);
    }

    if (workspace.headRef) {
      // HEAD.lock guards checkout. A private HEAD prevents update-ref from trying to acquire it twice.
      // Use a separate linked context: the candidate's own refs must never shadow common refs.
      const publisher = join(dirname(indexPath), 'publisher.git');
      await mkdir(publisher);
      await writeFile(join(publisher, 'HEAD'), `ref: ${workspace.headRef}\n`);
      await writeFile(join(publisher, 'commondir'), `${repository.commonDir}\n`);
      const installed = await runner(
        [
          'update-ref',
          '-m',
          `${mode ? 'commit (amend)' : 'commit'}: ${message.split(/\r?\n/)[0]}`,
          workspace.headRef,
          candidate,
          snapshot.head ?? '0'.repeat(candidate.length),
        ],
        {
          cwd,
          env: { ...workspace.env, GIT_DIR: publisher, GIT_COMMON_DIR: repository.commonDir },
        }
      );
      if (installed.exitCode !== 0)
        return changed(installed.stderr || 'Reviewed branch changed before commit publication');
      published = true;
    } else {
      await writeFile(headLock, `${candidate}\n`);
      await rename(headLock, join(repository.gitDir, 'HEAD'));
      ownsHeadLock = false;
      published = true;
    }
    if (refreshedIndex) {
      await writeFile(indexLock, refreshedIndex);
      await rename(indexLock, repository.indexPath);
      ownsIndexLock = false;
    }
    const privateLog = await readOptional(join(workspace.gitDir, 'logs', 'HEAD'));
    const entry = privateLog
      ?.toString('utf8')
      .trimEnd()
      .split('\n')
      .findLast((line) => line.startsWith(`${snapshot.head ?? '0'.repeat(candidate.length)} ${candidate} `));
    if (entry) {
      await mkdir(join(repository.gitDir, 'logs'), { recursive: true });
      await appendFile(join(repository.gitDir, 'logs', 'HEAD'), `${entry}\n`);
    }
    return { ok: true, commit: candidate, ...(warnings.length ? { warning: warnings.join('\n') } : {}) };
  } catch (error) {
    if (published)
      return {
        ok: true,
        commit: candidate,
        warning: [...warnings, `Commit created, but repository refresh failed: ${messageOf(error)}`].join('\n'),
      };
    return changed(messageOf(error));
  } finally {
    // Renamed locks are no longer ours; never remove a subsequent writer's lock.
    if (ownsIndexLock) await rm(indexLock, { force: true }).catch((): undefined => undefined);
    if (ownsHeadLock) await rm(headLock, { force: true }).catch((): undefined => undefined);
  }
};
