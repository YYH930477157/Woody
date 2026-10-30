import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  GitBlameLine,
  GitCommitDetails,
  GitCommitDiff,
  GitDiffAnchor,
  GitDiffRequest,
  GitFileHistoryQuery,
  GitHistoryPage,
  GitHistoryQuery,
  GitRevisionContent,
  GitWorkbenchScope,
} from '@/common/types/sourceControl/workbenchTypes';
import { createGitExecutor, type GitExecutor } from './executor';
import { LOG_FORMAT, REF_FORMAT, parseBlame, parseFiles, parseHistory, parseRefs } from './parsers';
import {
  diffRequestSchema,
  fileHistoryQuerySchema,
  hashSchema,
  historyQuerySchema,
  relativePathSchema,
  scopeSchema,
} from './validation';

export type GitWorkbenchOptions = {
  resolveRoot: (scope: GitWorkbenchScope) => Promise<string>;
  gitPath?: string;
  /** Host-resolved executable shared with the other Git services. */
  git?: GitExecutor;
};

/** Resolve and verify the project-owned repository root before accessing Git. */
export const createWorkbenchRootResolver =
  (options: GitWorkbenchOptions, git: GitExecutor) =>
  async (scope: GitWorkbenchScope): Promise<string> => {
    scopeSchema.parse(scope);
    const root = await realpath(await options.resolveRoot(scope));
    const top = await git(root, ['rev-parse', '--show-toplevel']);
    const canonical = await realpath(top.stdout.trim());
    if (path.relative(root, canonical) !== '') throw new Error('Selected root is not a Git repository root');
    return root;
  };

/** Read repository data through the same Git CLI format used by IdeaGitTool. */
export function createGitWorkbenchService(options: GitWorkbenchOptions) {
  const git = options.git ?? createGitExecutor(options.gitPath);
  const rootFor = createWorkbenchRootResolver(options, git);
  const resolveCommit = async (root: string, anchor: GitDiffAnchor): Promise<string> => {
    const revision = anchor.kind === 'head' ? 'HEAD' : anchor.kind === 'revision' ? anchor.revision : undefined;
    if (!revision) throw new Error('The selected content anchor is not a commit');
    return (await git(root, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).stdout.trim();
  };
  return {
    async history(scope: GitWorkbenchScope, query: GitHistoryQuery): Promise<GitHistoryPage> {
      const filter = historyQuerySchema.parse(query);
      const root = await rootFor(scope);
      const skip = filter.skip ?? 0;
      const limit = filter.limit ?? 100;
      const readSnapshot = async () => {
        const refs = await git(root, ['show-ref', '--head'], true);
        if (refs.code !== 0 && !(refs.code === 1 && !refs.stderr))
          throw new Error(refs.stderr || 'Unable to read Git references');
        return { empty: !refs.stdout, hash: createHash('sha256').update(refs.stdout).digest('hex') };
      };
      const before = await readSnapshot();
      if (filter.snapshot && filter.snapshot !== before.hash)
        throw new Error('Git history changed; refresh before loading more commits');
      let revision: string | undefined;
      if (filter.ref) {
        revision = (
          await git(root, ['rev-parse', '--verify', '--end-of-options', `${filter.ref}^{commit}`])
        ).stdout.trim();
      } else if (before.empty) return { commits: [], hasMore: false, nextSkip: skip, snapshot: before.hash };
      const args = [
        'log',
        '--topo-order',
        '--decorate=full',
        `--format=${LOG_FORMAT}`,
        `--max-count=${limit + 1}`,
        `--skip=${skip}`,
      ];
      let hashMatch: string | undefined;
      if (filter.text && /^[a-f0-9]{7,64}$/i.test(filter.text)) {
        const resolved = await git(
          root,
          ['rev-parse', '--verify', '--end-of-options', `${filter.text}^{commit}`],
          true
        );
        if (resolved.code === 0) hashMatch = resolved.stdout.trim();
      }
      if (hashMatch) {
        if (revision && (await git(root, ['merge-base', '--is-ancestor', hashMatch, revision], true)).code !== 0) {
          return { commits: [], hasMore: false, nextSkip: skip, snapshot: before.hash };
        }
        args.push('--no-walk');
      } else if (filter.text) args.push('--fixed-strings', `--grep=${filter.text}`);
      if (filter.author) args.push('--fixed-strings', `--author=${filter.author}`);
      if (filter.since) args.push(`--since=${filter.since}T00:00:00`);
      if (filter.until) args.push(`--until=${filter.until}T23:59:59`);
      if (filter.firstParent) args.push('--first-parent');
      if (filter.noMerges) args.push('--no-merges');
      args.push(hashMatch ?? revision ?? '--all', '--');
      if (filter.path) args.push(filter.path);
      const rows = parseHistory((await git(root, args)).stdout);
      if ((await readSnapshot()).hash !== before.hash)
        throw new Error('Git history changed; refresh before loading more commits');
      return {
        commits: rows.slice(0, limit),
        hasMore: rows.length > limit,
        nextSkip: skip + Math.min(rows.length, limit),
        snapshot: before.hash,
      };
    },
    async refs(scope: GitWorkbenchScope) {
      const root = await rootFor(scope);
      return parseRefs(
        (await git(root, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'])).stdout
      );
    },
    async details(scope: GitWorkbenchScope, hash: string): Promise<GitCommitDetails> {
      hashSchema.parse(hash);
      const root = await rootFor(scope);
      const [message, changed] = await Promise.all([
        git(root, ['show', '-s', '--format=%B', hash, '--']),
        git(root, [
          'diff-tree',
          '--root',
          '--no-commit-id',
          '--name-status',
          '-z',
          '-r',
          '-M',
          '--first-parent',
          '-m',
          hash,
          '--',
        ]),
      ]);
      return { hash, body: message.stdout.replace(/\r?\n$/, ''), files: parseFiles(changed.stdout) };
    },
    async diff(scope: GitWorkbenchScope, hash: string, file: string): Promise<GitCommitDiff> {
      hashSchema.parse(hash);
      relativePathSchema.refine((value) => value.length > 0).parse(file);
      const root = await rootFor(scope);
      const result = await git(
        root,
        ['show', '--format=', '--no-ext-diff', '--no-textconv', '--first-parent', '--patch', hash, '--', file],
        false,
        { maxBuffer: 256 * 1024, truncate: true }
      );
      return {
        patch: result.stdout,
        binary: /^Binary files .+ differ$/m.test(result.stdout),
        truncated: result.truncated ?? false,
      };
    },
    async compare(scope: GitWorkbenchScope, request: GitDiffRequest): Promise<GitCommitDiff> {
      const input = diffRequestSchema.parse(request) as GitDiffRequest;
      const root = await rootFor(scope);
      if (input.from.kind === input.to.kind && ['worktree', 'index', 'head'].includes(input.from.kind))
        return { patch: '', binary: false };
      const args = ['diff', '--no-ext-diff', '--no-textconv'];
      const fromCommit =
        input.from.kind === 'head' || input.from.kind === 'revision'
          ? await resolveCommit(root, input.from)
          : undefined;
      const toCommit =
        input.to.kind === 'head' || input.to.kind === 'revision' ? await resolveCommit(root, input.to) : undefined;
      if (input.from.kind === 'worktree') {
        if (input.to.kind === 'index') args.push('-R');
        else args.push('-R', toCommit!);
      } else if (input.to.kind === 'worktree') {
        args.push(fromCommit ?? '--');
      } else if (input.from.kind === 'index') {
        args.push('--cached');
        if (input.to.kind === 'head' || input.to.kind === 'revision') args.push('-R', toCommit!);
      } else if (input.to.kind === 'index') {
        args.push('--cached', fromCommit!);
      } else {
        args.push(fromCommit!, toCommit!);
      }
      if (args.at(-1) !== '--') args.push('--');
      args.push(input.file);
      const result = await git(root, args, false, { maxBuffer: 256 * 1024, truncate: true });
      return {
        patch: result.stdout,
        binary: /^Binary files .+ differ$/m.test(result.stdout),
        truncated: result.truncated ?? false,
      };
    },
    async fileHistory(scope: GitWorkbenchScope, query: GitFileHistoryQuery): Promise<GitHistoryPage> {
      const input = fileHistoryQuerySchema.parse(query);
      const root = await rootFor(scope);
      const skip = input.skip ?? 0;
      const limit = input.limit ?? 100;
      const empty = (await git(root, ['show-ref', '--head'], true)).code === 1;
      if (empty) return { commits: [], hasMore: false, nextSkip: skip };
      const rows = parseHistory(
        (
          await git(root, [
            'log',
            '--follow',
            '--topo-order',
            '--decorate=full',
            `--format=${LOG_FORMAT}`,
            `--max-count=${limit + 1}`,
            `--skip=${skip}`,
            'HEAD',
            '--',
            input.path,
          ])
        ).stdout
      );
      return {
        commits: rows.slice(0, limit),
        hasMore: rows.length > limit,
        nextSkip: skip + Math.min(rows.length, limit),
      };
    },
    async readRevision(scope: GitWorkbenchScope, anchor: GitDiffAnchor, file: string): Promise<GitRevisionContent> {
      const path = relativePathSchema.refine((value) => value.length > 0).parse(file);
      const parsedAnchor = diffRequestSchema.shape.from.parse(anchor) as GitDiffAnchor;
      const root = await rootFor(scope);
      if (parsedAnchor.kind === 'worktree' || parsedAnchor.kind === 'index')
        throw new Error('A commit anchor is required to read a historical file');
      const revision = await resolveCommit(root, parsedAnchor);
      const object = `${revision}:${path}`;
      const exists = await git(root, ['cat-file', '-e', object], true);
      if (exists.code !== 0) return { revision, path, exists: false, binary: false, truncated: false, size: 0 };
      const size = Number((await git(root, ['cat-file', '-s', object])).stdout.trim());
      const result = await git(root, ['cat-file', 'blob', object], false, {
        binary: true,
        maxBuffer: 512 * 1024,
        truncate: true,
      });
      const buffer = result.buffer ?? Buffer.from(result.stdout);
      const binary = buffer.includes(0);
      return {
        revision,
        path,
        exists: true,
        binary,
        truncated: result.truncated ?? size > buffer.length,
        size,
        ...(binary ? { contentBase64: buffer.toString('base64') } : { content: buffer.toString('utf8') }),
      };
    },
    async blame(scope: GitWorkbenchScope, file: string): Promise<GitBlameLine[]> {
      const path = relativePathSchema.refine((value) => value.length > 0).parse(file);
      const root = await rootFor(scope);
      const result = await git(root, ['blame', '--line-porcelain', '--', path], false, {
        maxBuffer: 4 * 1024 * 1024,
        truncate: true,
        timeoutMs: 30_000,
      });
      return parseBlame(result.stdout);
    },
  };
}
