import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import type { GitOperationRequest, GitOperationOutcome, GitRemote } from '@/common/types/sourceControl/operationTypes';
import { createGitExecutor, type GitExecutor } from '../executor';
import { createWorkbenchRootResolver, type GitWorkbenchOptions } from '../service';
import { repositoryCoordinator } from '../coordinator';
import { scopeSchema } from '../validation';
import { operationIdSchema, operationSchema, remoteUrlSchema } from './validation';
import { createHistoryRewrite } from './rewrite';
import {
  OperationBlocked,
  conflictedFiles,
  inspectOperation,
  parseWorktrees,
  runConflictAware,
  safeOutput,
} from './engine';

export type RepositoryRun = <T>(root: string, operation: () => Promise<T>) => Promise<T>;
/** Execute typed operations through explicit Git/root/coordination ports. */
export function createGitOperationService(
  options: GitWorkbenchOptions & {
    run?: RepositoryRun;
    git?: GitExecutor;
    storeDir?: string;
    /** Git 2.38 added the explicit `--no-update-refs` spelling. Older Git defaults to the same behavior. */
    capabilities?: { updateRefs: boolean; memoryHistoryEdit?: boolean };
  }
) {
  // Operations pass no user pathspecs. The global literal flag breaks stash's internal :/ cleanup.
  const git = options.git ?? createGitExecutor(options.gitPath, false);
  const rootFor = createWorkbenchRootResolver(options, git);
  const run = options.run ?? repositoryCoordinator.run;
  const rewrite = createHistoryRewrite(git, options.storeDir, options.gitPath);
  const active = new Map<string, { root: Promise<string>; controller: AbortController }>();
  const rootKey = (root: string) => (process.platform === 'win32' ? root.toLowerCase() : root);
  const resolve = async (root: string, ref: string, commit = true): Promise<string> =>
    (
      await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}${commit ? '^{commit}' : ''}`])
    ).stdout.trim();
  const matches = async (root: string, ref: string, expected: string, commit = true) => {
    if ((await resolve(root, ref, commit)) !== expected)
      throw new OperationBlocked('Reference changed; refresh before retrying');
  };
  const validateName = async (root: string, name: string, tag = false) => {
    if ((await git(root, ['check-ref-format', tag ? `refs/tags/${name}` : `refs/heads/${name}`], true)).code !== 0)
      throw new OperationBlocked('Invalid reference name');
  };
  const remoteUrls = async (root: string, name: string, push = false): Promise<string[]> =>
    (await git(root, ['remote', 'get-url', ...(push ? ['--push'] : []), '--all', name])).stdout.trim().split(/\r?\n/);
  const verifyRemote = async (root: string, name: string, push = false) => {
    for (const url of await remoteUrls(root, name, push)) {
      if (!remoteUrlSchema.safeParse(url).success)
        throw new OperationBlocked('Remote uses unsupported transport or embedded credentials');
    }
  };
  return {
    async cancel(scope: GitWorkbenchScope, operationId: string): Promise<{ cancelled: boolean }> {
      if (!operationIdSchema.safeParse(operationId).success || !scopeSchema.safeParse(scope).success)
        return { cancelled: false };
      const entry = active.get(operationId);
      if (!entry) return { cancelled: false };
      try {
        if (rootKey(await rootFor(scope)) !== rootKey(await entry.root) || active.get(operationId) !== entry)
          return { cancelled: false };
        entry.controller.abort();
        return { cancelled: true };
      } catch {
        return { cancelled: false };
      }
    },
    async operate(
      scope: GitWorkbenchScope,
      request: GitOperationRequest,
      operationId?: string
    ): Promise<GitOperationOutcome> {
      const parsed = operationSchema.safeParse(request);
      if (
        !parsed.success ||
        !scopeSchema.safeParse(scope).success ||
        (operationId !== undefined && !operationIdSchema.safeParse(operationId).success)
      )
        return { state: 'blocked', reason: 'invalidInput', output: 'Invalid operation request' };
      const req = parsed.data as GitOperationRequest;
      if (
        options.capabilities?.memoryHistoryEdit === false &&
        ['history.reword', 'history.squash', 'history.fixup', 'history.drop'].includes(req.kind)
      )
        return {
          state: 'blocked',
          output: 'History editing requires Git 2.40 or newer; configure a supported Git executable.',
        };
      const cancellable = operationId !== undefined && ['fetch', 'pull', 'push'].includes(req.kind);
      if (operationId && active.has(operationId)) return { state: 'blocked', output: 'Operation ID is already active' };
      const controller = new AbortController();
      const checkCancelled = () => {
        if (controller.signal.aborted) throw new Error('Operation cancelled');
      };
      try {
        const pendingRoot = rootFor(scope);
        if (cancellable) active.set(operationId, { root: pendingRoot, controller });
        const root = await pendingRoot;
        return await run(root, async () => {
          checkCancelled();
          const complete = (data: NonNullable<GitOperationOutcome['data']>): GitOperationOutcome => ({
            state: 'complete',
            output: '',
            data,
          });
          const execute = (args: string[]) => {
            checkCancelled();
            return runConflictAware(
              root,
              (cwd, command, allowFailure, commandOptions) =>
                git(cwd, command, allowFailure, { ...commandOptions, signal: controller.signal }),
              args
            );
          };
          if (req.kind === 'inspect') {
            const operation = await inspectOperation(root, git);
            const head = await git(root, ['rev-parse', '--verify', 'HEAD'], true);
            const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
            return {
              ...complete({
                head: head.code === 0 ? head.stdout.trim() : null,
                branch: branch.code === 0 ? branch.stdout.trim() : null,
                operation,
              }),
              files: await conflictedFiles(root, git),
            };
          }
          if (req.kind === 'remote.list') {
            const remotes: GitRemote[] = [];
            for (const name of (await git(root, ['remote'])).stdout.trim().split(/\r?\n/).filter(Boolean)) {
              remotes.push({
                name,
                fetchUrl: safeOutput((await remoteUrls(root, name))[0]),
                pushUrl: safeOutput((await remoteUrls(root, name, true))[0]),
              });
            }
            return complete({ remotes });
          }
          if (req.kind === 'worktree.list')
            return complete({
              worktrees: parseWorktrees((await git(root, ['worktree', 'list', '--porcelain', '-z'])).stdout),
            });
          if (req.kind === 'stash.list') {
            const output = (await git(root, ['stash', 'list', '--format=%gd%x00%H%x00%ct%x00%s%x00'])).stdout;
            const fields = output.split('\0');
            const stashes = [];
            for (let i = 0; i + 3 < fields.length; i += 4)
              stashes.push({
                ref: fields[i].trim(),
                hash: fields[i + 1],
                date: Number(fields[i + 2]),
                subject: fields[i + 3],
              });
            return complete({ stashes });
          }
          if (req.kind === 'stash.show') {
            await matches(root, req.ref, req.expectedRef);
            const preview = await git(
              root,
              ['stash', 'show', '--patch', '--include-untracked', '--no-ext-diff', '--no-textconv', req.expectedRef],
              false,
              { maxBuffer: 256 * 1024, truncate: true }
            );
            return complete({ patch: safeOutput(preview.stdout), truncated: preview.truncated ?? false });
          }
          const checkHistoryIdentity = async (expectedHead: string, expectedBranch: string | null) => {
            await matches(root, 'HEAD', expectedHead);
            const currentBranch = await git(root, ['symbolic-ref', '--quiet', 'HEAD'], true);
            const branch = currentBranch.code === 0 ? currentBranch.stdout.trim().replace(/^refs\/heads\//, '') : null;
            if (![0, 1].includes(currentBranch.code) || branch !== expectedBranch)
              throw new OperationBlocked('Current branch changed; refresh before retrying');
          };
          if ('expectedBranch' in req) await checkHistoryIdentity(req.expectedHead, req.expectedBranch);
          if (req.kind === 'history.continue' || req.kind === 'history.abort') {
            if ((await inspectOperation(root, git)) !== req.operation)
              throw new OperationBlocked('The selected operation is no longer in progress');
            if (req.kind === 'history.continue' && (await conflictedFiles(root, git)).length)
              throw new OperationBlocked('Resolve all conflicts before continuing');
            await checkHistoryIdentity(req.expectedHead, req.expectedBranch);
            if (req.operation === 'rebase')
              return rewrite.resume(root, req.kind === 'history.continue' ? 'continue' : 'abort', () =>
                checkHistoryIdentity(req.expectedHead, req.expectedBranch)
              );
            return execute([req.operation, req.kind === 'history.continue' ? '--continue' : '--abort']);
          }
          if ((await inspectOperation(root, git)) || (await conflictedFiles(root, git)).length)
            throw new OperationBlocked('An operation or unresolved conflict is already in progress');
          if ('expectedHead' in req) await matches(root, 'HEAD', req.expectedHead);
          await rewrite.cleanupInactive(root);
          switch (req.kind) {
            case 'history.reword':
            case 'history.squash':
            case 'history.fixup':
            case 'history.drop': {
              const preflight = async () => {
                if ((await inspectOperation(root, git)) || (await conflictedFiles(root, git)).length)
                  throw new OperationBlocked('An operation or unresolved conflict is already in progress');
                if ((await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout)
                  throw new OperationBlocked('A clean working tree and index are required before rewriting history');
                await checkHistoryIdentity(req.expectedHead, req.expectedBranch);
              };
              await preflight();
              return rewrite.start(root, req, preflight);
            }
            case 'merge':
            case 'cherry-pick':
            case 'revert':
            case 'rebase': {
              if ((await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout)
                throw new OperationBlocked('A clean working tree and index are required before history operations');
              await matches(root, req.target, req.target);
              await checkHistoryIdentity(req.expectedHead, req.expectedBranch);
              // Operate only on the reviewed immutable commit, with interactive editors disabled by the executor.
              if (req.kind === 'merge') return execute(['merge', '--no-edit', '--no-autostash', req.target]);
              if (req.kind === 'rebase')
                return execute([
                  'rebase',
                  '--no-autostash',
                  ...(options.capabilities?.updateRefs !== false ? ['--no-update-refs'] : []),
                  req.target,
                ]);
              return execute([req.kind, '--no-edit', req.target]);
            }
            case 'branch.create':
              await validateName(root, req.name);
              return execute(['branch', '--no-track', req.name, await resolve(root, req.startPoint)]);
            case 'branch.switch':
              await validateName(root, req.name);
              await resolve(root, `refs/heads/${req.name}`);
              return execute(['switch', '--no-guess', '--', req.name]);
            case 'branch.rename':
              await validateName(root, req.name);
              await validateName(root, req.newName);
              await matches(root, `refs/heads/${req.name}`, req.expectedRef);
              return execute(['branch', '-m', req.name, req.newName]);
            case 'branch.delete':
              await validateName(root, req.name);
              await matches(root, `refs/heads/${req.name}`, req.expectedRef);
              return execute(['branch', '-d', req.name]);
            case 'tag.create':
              await validateName(root, req.name, true);
              return execute(['tag', '--no-sign', req.name, await resolve(root, req.target)]);
            case 'tag.delete':
              await validateName(root, req.name, true);
              await matches(root, `refs/tags/${req.name}`, req.expectedRef, false);
              return execute(['update-ref', '-d', `refs/tags/${req.name}`, req.expectedRef]);
            case 'fetch':
              await verifyRemote(root, req.remote);
              return execute(['fetch', '--no-recurse-submodules', '--', req.remote]);
            case 'pull': {
              const checkBranch = async () => {
                if (
                  (await git(root, ['symbolic-ref', '--quiet', 'HEAD'], true)).stdout.trim() !==
                  `refs/heads/${req.branch}`
                )
                  throw new OperationBlocked('Current branch changed; refresh before pulling');
              };
              await checkBranch();
              await validateName(root, req.branch);
              await verifyRemote(root, req.remote);
              const fetched = await execute([
                'fetch',
                '--no-recurse-submodules',
                req.remote,
                `refs/heads/${req.branch}`,
              ]);
              if (fetched.state !== 'complete') return fetched;
              // Fetch may be slow; revalidate immediately before mutating the working tree.
              await checkBranch();
              await matches(root, 'HEAD', req.expectedHead);
              return execute(['merge', '--ff-only', '--no-edit', '--no-autostash', await resolve(root, 'FETCH_HEAD')]);
            }
            case 'push':
              await validateName(root, req.branch);
              await verifyRemote(root, req.remote, true);
              await matches(root, `refs/heads/${req.branch}`, req.expectedHead);
              return execute([
                '-c',
                `remote.${req.remote}.mirror=false`,
                'push',
                '--no-force',
                '--no-follow-tags',
                '--recurse-submodules=no',
                req.remote,
                `refs/heads/${req.branch}:refs/heads/${req.branch}`,
              ]);
            case 'remote.add':
              return execute(['remote', 'add', req.name, req.url]);
            case 'remote.setUrl':
            case 'remote.remove': {
              const urls = await remoteUrls(root, req.name);
              if (urls.length !== 1 || urls[0] !== req.expectedUrl)
                throw new OperationBlocked('Remote URL changed or is ambiguous; refresh before retrying');
              return execute(
                req.kind === 'remote.remove' ? ['remote', 'remove', req.name] : ['remote', 'set-url', req.name, req.url]
              );
            }
            case 'stash.save':
              return execute([
                'stash',
                'push',
                ...(req.includeUntracked ? ['--include-untracked'] : []),
                '-m',
                req.message,
              ]);
            case 'stash.apply':
              await matches(root, req.ref, req.expectedRef);
              return execute(['stash', 'apply', req.expectedRef]);
            case 'stash.pop': {
              await matches(root, req.ref, req.expectedRef);
              const applied = await execute(['stash', 'apply', req.expectedRef]);
              if (applied.state !== 'complete') return applied;
              // An external Git process may shift reflog selectors during apply. Keep both entries then.
              await matches(root, req.ref, req.expectedRef);
              const dropped = await execute(['stash', 'drop', req.ref]);
              return { ...dropped, output: [applied.output, dropped.output].filter(Boolean).join('\n') };
            }
            case 'stash.drop':
              await matches(root, req.ref, req.expectedRef);
              return execute(['stash', req.kind.slice(6), req.ref]);
          }
        });
      } catch (error) {
        if (controller.signal.aborted)
          return {
            state: 'cancelled',
            output:
              'Git command cancelled. Refresh repository and remote state before retrying; completed changes are not undone.',
          };
        return {
          state: error instanceof OperationBlocked ? 'blocked' : 'error',
          output: safeOutput(error instanceof Error ? error.message : 'Git operation failed'),
        };
      } finally {
        if (cancellable && active.get(operationId)?.controller === controller) active.delete(operationId);
      }
    },
  };
}
