import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { GitCommitSnapshot } from '@/common/types/sourceControl/gitWorkflowTypes';

export type GitRunnerOptions = { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };
export type GitCommandOutput = { stdout: string; stderr: string; exitCode: number };
export type GitCommandRunner = (args: string[], options: GitRunnerOptions) => Promise<GitCommandOutput>;
export type CommitRepository = { gitDir: string; commonDir: string; indexPath: string; index: Buffer | null };

export const readOptional = async (file: string): Promise<Buffer | null> => {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

export const hasActiveHistoryOperation = async (gitDir: string): Promise<boolean> => {
  const markers = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
    'woody-history-pending.json',
  ];
  const exists = await Promise.all(
    markers.map(async (marker) => {
      try {
        await stat(join(gitDir, marker));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    })
  );
  return exists.some(Boolean);
};

export const runRequired = async (runner: GitCommandRunner, args: string[], options: GitRunnerOptions) => {
  const result = await runner(args, options);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Git command failed');
  return result.stdout;
};

export const inspectCommitRepository = async (runner: GitCommandRunner, cwd: string): Promise<CommitRepository> => {
  const location = async (args: string[]) => resolve(cwd, (await runRequired(runner, args, { cwd })).trim());
  const [gitDir, commonDir, indexPath] = await Promise.all([
    location(['rev-parse', '--absolute-git-dir']),
    location(['rev-parse', '--git-common-dir']),
    location(['rev-parse', '--git-path', 'index']),
  ]);
  return { gitDir, commonDir, indexPath, index: await readOptional(indexPath) };
};

export const quoteConfig = (value: string) =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replaceAll('\b', '\\b')}"`;

/** Freeze effective config, including conditional includes evaluated against the original repository. */
export const flattenConfig = (output: string): string =>
  output
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('\n');
      const key = separator < 0 ? entry : entry.slice(0, separator);
      if (/^include(?:if\..*)?\.path$/i.test(key)) return '';
      const first = key.indexOf('.');
      const last = key.lastIndexOf('.');
      const section = key.slice(0, first);
      const subsection = first === last ? '' : ` ${quoteConfig(key.slice(first + 1, last))}`;
      const value = separator < 0 ? 'true' : quoteConfig(entry.slice(separator + 1));
      return `[${section}${subsection}]\n\t${key.slice(last + 1)} = ${value}\n`;
    })
    .join('');

/** An isolated branch context keeps hooks/signing and Amend authorship without touching live refs. */
export const createCommitWorkspace = async (
  runner: GitCommandRunner,
  cwd: string,
  indexPath: string,
  repository: CommitRepository,
  snapshot: GitCommitSnapshot
) => {
  const gitDir = join(dirname(indexPath), 'candidate.git');
  await mkdir(join(gitDir, 'refs'), { recursive: true });
  await mkdir(join(gitDir, 'objects'));
  const shallow = await readOptional(join(repository.commonDir, 'shallow'));
  if (shallow) await writeFile(join(gitDir, 'shallow'), shallow);
  const [config, refs, hooks] = await Promise.all([
    runRequired(runner, ['config', '--null', '--list', '--includes'], { cwd }),
    runRequired(runner, ['for-each-ref', '--format=%(objectname) %(refname)'], { cwd }),
    runRequired(runner, ['rev-parse', '--git-path', 'hooks'], { cwd }),
  ]);
  const headRef = snapshot.branch ? `refs/heads/${snapshot.branch}` : '';
  await writeFile(
    join(gitDir, 'config'),
    `${flattenConfig(config)}\n[core]\n\thooksPath = ${quoteConfig(resolve(cwd, hooks.trim()).replace(/\\/g, '/'))}\n`
  );
  await writeFile(join(gitDir, 'empty.config'), '');
  // Remove the target from packed refs before seeding its reviewed value (including an unborn branch).
  const packed = refs
    .split(/\r?\n/)
    .filter((line) => line && !line.endsWith(` ${headRef}`))
    .join('\n');
  await writeFile(join(gitDir, 'packed-refs'), `# pack-refs with: sorted\n${packed}${packed ? '\n' : ''}`);
  await writeFile(join(gitDir, 'HEAD'), headRef ? `ref: ${headRef}\n` : `${snapshot.head}\n`);
  if (headRef && snapshot.head) {
    await mkdir(dirname(join(gitDir, headRef)), { recursive: true });
    await writeFile(join(gitDir, headRef), `${snapshot.head}\n`);
  }
  if (await readOptional(join(repository.gitDir, 'logs', 'HEAD'))) {
    await mkdir(join(gitDir, 'logs'), { recursive: true });
    await writeFile(join(gitDir, 'logs', 'HEAD'), '');
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: cwd,
    GIT_INDEX_FILE: indexPath,
    GIT_OBJECT_DIRECTORY: join(repository.commonDir, 'objects'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(gitDir, 'empty.config'),
  };
  // Their effective values are already frozen in config; do not evaluate them against the private gitdir again.
  for (const name of Object.keys(env)) {
    if (
      name === 'GIT_COMMON_DIR' ||
      name === 'GIT_CONFIG' ||
      name === 'GIT_CONFIG_PARAMETERS' ||
      /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name)
    )
      delete env[name];
  }
  return { gitDir, env, headRef };
};
