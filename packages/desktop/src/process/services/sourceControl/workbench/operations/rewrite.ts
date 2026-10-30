/**
 * Interactive todo/message-file approach adapted from vs-idea-gittool src/features/ops/engine.ts,
 * pinned at 8bd81d26dbb2997d021465f16fec6fc3656c3f38. See resources/third-party/ideagittool/PROVENANCE.md.
 * Only reviewed linear history is supported; helper files survive conflicts and process restart.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { GitOperationRequest, GitOperationOutcome } from '@/common/types/sourceControl/operationTypes';
import type { GitExecutor } from '../executor';
import { inspectOperation, OperationBlocked, runConflictAware } from './engine';
import { withIsolatedHistory } from './lockedHistory';

type RewriteRequest = Extract<
  GitOperationRequest,
  { kind: 'history.reword' | 'history.squash' | 'history.fixup' | 'history.drop' }
>;
type Recovery = { expectedHead: string; expectedBranch: string; onto: string; token: string; pausedHead?: string };
const shellQuote = (value: string) => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;

/** Own helpers by worktree Git directory so linked worktrees retain independent recovery. */
export function createHistoryRewrite(git: GitExecutor, storeDir?: string, gitPath = 'git') {
  const gitDirectoryFor = async (root: string, executor = git) =>
    path.resolve(root, (await executor(root, ['rev-parse', '--git-dir'])).stdout.trim());
  const directoryFor = async (root: string): Promise<string | undefined> => {
    if (!storeDir) return undefined;
    const gitDir = await gitDirectoryFor(root);
    const identity = process.platform === 'win32' ? gitDir.toLowerCase() : gitDir;
    return path.join(storeDir, createHash('sha256').update(identity).digest('hex'));
  };
  const terminalCleanup = async (root: string, directory: string | undefined) => {
    if (directory && !(await inspectOperation(root, git))) await rm(directory, { recursive: true, force: true });
  };
  const ownsActiveRebase = async (root: string, recovery: Recovery, executor = git): Promise<boolean> => {
    const activeDirectory = path.join(await gitDirectoryFor(root, executor), 'rebase-merge');
    let token: string;
    try {
      token = await readFile(path.join(activeDirectory, 'woody-rewrite-token'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (token !== recovery.token) return false;
    const [originalHead, branch, onto] = await Promise.all(
      ['orig-head', 'head-name', 'onto'].map((name) => readFile(path.join(activeDirectory, name), 'utf8'))
    );
    if (
      originalHead.trim() !== recovery.expectedHead ||
      branch.trim() !== `refs/heads/${recovery.expectedBranch}` ||
      onto.trim() !== recovery.onto
    )
      throw new OperationBlocked('Active rewrite identity changed; inspect the rebase before continuing or aborting');
    return true;
  };
  /** Pin the stopped position before returning control to the user or another application. */
  const settleOperation = async (root: string, directory: string | undefined, executor = git) => {
    if (!directory) return;
    const operation = await inspectOperation(root, executor);
    if (!operation) {
      await rm(directory, { recursive: true, force: true });
      return;
    }
    if (operation !== 'rebase') return;
    const file = path.join(directory, 'recovery.json');
    let recovery: Recovery;
    try {
      recovery = JSON.parse(await readFile(file, 'utf8')) as Recovery;
    } catch (error) {
      // Ordinary rebases use Git's own recovery and have no application helper directory.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!(await ownsActiveRebase(root, recovery, executor))) return;
    const branch = await executor(root, ['symbolic-ref', '--quiet', 'HEAD'], true);
    recovery.pausedHead =
      branch.code === 1 && !branch.stderr
        ? (await executor(root, ['rev-parse', '--verify', 'HEAD'])).stdout.trim()
        : undefined;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(recovery), 'utf8');
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  return {
    async cleanupInactive(root: string): Promise<void> {
      await terminalCleanup(root, await directoryFor(root));
    },
    async resume(
      root: string,
      action: 'continue' | 'abort',
      preflight: () => Promise<void>
    ): Promise<GitOperationOutcome> {
      const directory = await directoryFor(root);
      let recovery: Recovery | undefined;
      if (directory) {
        try {
          recovery = JSON.parse(await readFile(path.join(directory, 'recovery.json'), 'utf8')) as Recovery;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (directory && recovery && !(await ownsActiveRebase(root, recovery))) {
        // External abort removes the token with Git's rebase directory. A later rebase owns no old helpers.
        await rm(directory, { recursive: true, force: true });
        recovery = undefined;
      }
      const validateRecovery = async () => {
        if (recovery) {
          const branch = (
            await git(root, ['rev-parse', '--verify', `refs/heads/${recovery.expectedBranch}`])
          ).stdout.trim();
          if (branch !== recovery.expectedHead)
            throw new OperationBlocked('Original rewrite branch changed; inspect it before continuing or aborting');
          const currentBranch = await git(root, ['symbolic-ref', '--quiet', 'HEAD'], true);
          const currentHead = (await git(root, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
          if (
            currentBranch.code !== 1 ||
            currentBranch.stderr ||
            !recovery.pausedHead ||
            currentHead !== recovery.pausedHead
          )
            throw new OperationBlocked(
              recovery.pausedHead
                ? `Paused rewrite HEAD changed; restore detached HEAD at ${recovery.pausedHead} before continuing or aborting`
                : 'Paused rewrite position was not saved; inspect the operation with Git before continuing or aborting'
            );
        }
      };
      await validateRecovery();
      return withIsolatedHistory(
        root,
        git,
        async () => {
          await validateRecovery();
          await preflight();
        },
        async (lockedGit) => {
          try {
            return await runConflictAware(root, lockedGit, ['rebase', `--${action}`]);
          } finally {
            await settleOperation(root, directory, lockedGit);
          }
        }
      );
    },
    async start(root: string, request: RewriteRequest, preflight: () => Promise<void>): Promise<GitOperationOutcome> {
      const directory = await directoryFor(root);
      if (!directory) throw new OperationBlocked('Persistent history recovery storage is not configured');
      const selected = request.kind === 'history.reword' ? [request.commit] : request.commits;
      for (const hash of selected) {
        if ((await git(root, ['merge-base', '--is-ancestor', hash, request.expectedHead], true)).code !== 0)
          throw new OperationBlocked('Every selected commit must be an ancestor of the reviewed HEAD');
      }
      let oldest = selected[0];
      for (const hash of selected.slice(1)) {
        if ((await git(root, ['merge-base', '--is-ancestor', hash, oldest], true)).code === 0) oldest = hash;
      }
      const parent = await git(root, ['rev-parse', '--verify', `${oldest}^`], true);
      if (parent.code !== 0) throw new OperationBlocked('Rewriting root commits is not supported');
      const base = parent.stdout.trim();
      const rows = (
        await git(root, [
          'rev-list',
          '--reverse',
          '--topo-order',
          '--parents',
          '--max-count=2001',
          `${base}..${request.expectedHead}`,
        ])
      ).stdout
        .trim()
        .split('\n')
        .map((line) => line.trim().split(' '));
      if (rows.length > 2000) throw new OperationBlocked('Rewrite range exceeds 2000 commits');
      let previous = base;
      for (const [hash, ...parents] of rows) {
        if (parents.length !== 1 || parents[0] !== previous)
          throw new OperationBlocked('Rewriting merge commits or non-linear history is not supported');
        previous = hash;
      }
      const hashes = rows.map((row) => row[0]);
      if (selected.some((hash) => !hashes.includes(hash)))
        throw new OperationBlocked('Selected commits are outside the linear rewrite range');
      const selectedSet = new Set(selected);
      const combine = request.kind === 'history.squash' || request.kind === 'history.fixup';
      if (combine && hashes.slice(0, selected.length).some((hash) => !selectedSet.has(hash)))
        throw new OperationBlocked('Squash and fixup require a contiguous linear selection');
      // All message bytes are data files. Todo shell lines contain only internally quoted paths.
      let message: string | undefined;
      if (request.kind === 'history.reword') message = request.message;
      if (request.kind === 'history.squash') {
        if (request.message !== undefined) message = request.message;
        else {
          const bodies: string[] = [];
          for (const hash of hashes.filter((candidate) => selectedSet.has(candidate))) {
            const raw = (await git(root, ['cat-file', 'commit', hash])).stdout;
            bodies.push(raw.slice(raw.indexOf('\n\n') + 2).replace(/\n+$/, ''));
          }
          message = `${bodies.join('\n\n')}\n`;
        }
      }
      await mkdir(directory, { recursive: true });
      try {
        const token = randomUUID();
        const messageFile = path.join(directory, 'message.txt');
        if (message !== undefined) await writeFile(messageFile, message, 'utf8');
        const lines: string[] = [];
        for (let index = 0; index < hashes.length; index++) {
          const hash = hashes[index];
          const action =
            request.kind === 'history.drop' && selectedSet.has(hash)
              ? 'drop'
              : combine && index > 0 && selectedSet.has(hash)
                ? 'fixup'
                : 'pick';
          lines.push(`${action} ${hash}`);
          if (
            message !== undefined &&
            (request.kind === 'history.reword' ? hash === request.commit : index === selected.length - 1)
          )
            lines.push(
              `exec ${shellQuote(gitPath)} commit --amend --allow-empty --cleanup=verbatim --file ${shellQuote(messageFile)}`
            );
        }
        const todo = path.join(directory, 'todo');
        await writeFile(todo, `${lines.join('\n')}\n`, 'utf8');
        const editor = path.join(directory, 'sequence-editor.cjs');
        await writeFile(
          editor,
          `const fs = require('node:fs');
const path = require('node:path');
const target = process.argv[process.argv.length - 1];
const directory = path.dirname(target);
const expected = ${JSON.stringify({ 'orig-head': request.expectedHead, 'head-name': `refs/heads/${request.expectedBranch}`, onto: base })};
for (const [name, value] of Object.entries(expected)) {
  if (fs.readFileSync(path.join(directory, name), 'utf8').trim() !== value)
    throw new Error('Reviewed rewrite target changed before Git started; no history was rewritten');
}
fs.copyFileSync(${JSON.stringify(todo)}, target);
fs.writeFileSync(path.join(directory, 'woody-rewrite-token'), ${JSON.stringify(token)});
`,
          'utf8'
        );
        await writeFile(
          path.join(directory, 'recovery.json'),
          JSON.stringify({
            expectedHead: request.expectedHead,
            expectedBranch: request.expectedBranch,
            onto: base,
            token,
          } satisfies Recovery),
          'utf8'
        );
        return await withIsolatedHistory(root, git, preflight, async (lockedGit) => {
          try {
            return await runConflictAware(
              root,
              (cwd, args, allowed, options) =>
                lockedGit(cwd, args, allowed, { ...options, sequenceEditorFile: editor }),
              [
                'rebase',
                '--interactive',
                '--no-autosquash',
                '--no-autostash',
                '--no-update-refs',
                '--no-rebase-merges',
                '--force-rebase',
                '--keep-empty',
                '--empty=keep',
                '--reapply-cherry-picks',
                '--reschedule-failed-exec',
                base,
              ]
            );
          } finally {
            await settleOperation(root, directory, lockedGit);
          }
        });
      } finally {
        await terminalCleanup(root, directory);
      }
    },
  };
}
