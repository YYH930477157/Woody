/* eslint-disable no-await-in-loop -- Locking, metadata snapshots and journal publication use a deliberate, deterministic order. */
import { chmod, copyFile, lstat, mkdir, open, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { GitExecutor } from '../executor';
import { flattenConfig, quoteConfig, readOptional } from '../commit/workspace';

const manifestName = 'woody-history-pending.json';
const prefix = 'woody-history-';
type Fingerprint = string | null;
type FileMap = Record<string, string>;
type RefMap = Record<string, string | null>;
type ResolveRef = (name: string) => Promise<string | null>;
export type HistoryJournal = {
  version: 1;
  phase: 'running' | 'ready';
  workspace: string;
  gitDir: string;
  indexPath: string;
  beforeHead: Fingerprint;
  beforeIndex: Fingerprint;
  before: FileMap;
  beforeRefs: RefMap;
  afterHead?: Fingerprint;
  afterIndex?: Fingerprint;
  after?: FileMap;
  afterRefs?: RefMap;
};
const digest = (data: Buffer | null): Fingerprint =>
  data === null ? null : createHash('sha256').update(data).digest('hex');
const fingerprint = async (file: string) => digest(await readOptional(file));
const privateGitDir = (journal: HistoryJournal) => path.join(journal.workspace, 'git');
export const resolveHistoryRef =
  (root: string, git: GitExecutor): ResolveRef =>
  async (name) => {
    const result = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', name], true);
    if (result.code === 0) return result.stdout.trim();
    if (result.code === 1 && !result.stderr) return null;
    throw new Error(result.stderr || `Unable to resolve ${name}`);
  };
export const pendingHistoryError = (journal: HistoryJournal, detail: string) =>
  new Error(
    detail.startsWith('History state publication is pending:')
      ? detail
      : `History state publication is pending: ${detail}. Recoverable Git state: ${privateGitDir(journal)}; index: ${path.join(privateGitDir(journal), 'index')}; journal: ${path.join(journal.gitDir, manifestName)}. ${journal.phase === 'ready' ? 'Restore access and retry Inspect' : 'Git execution was interrupted; inspect the retained Git state before manual recovery'}; further history operations are blocked until publication is recovered.`
  );
const commonFiles = new Set([
  'HEAD',
  'index',
  'config',
  'packed-refs',
  'shallow',
  'commondir',
  'gitdir',
  'description',
  'COMMIT_EDITMSG',
]);
const metadataDirectories = [
  'rebase-merge',
  'rebase-apply',
  'sequencer',
  'refs/worktree',
  'refs/bisect',
  'refs/rewritten',
  'logs/refs/worktree',
  'logs/refs/bisect',
  'logs/refs/rewritten',
];
const safeMetadataName = (name: string) =>
  name.length > 0 &&
  !name.includes('\\') &&
  !name.includes(':') &&
  !path.isAbsolute(name) &&
  !name.split('/').some((part) => part === '..' || part === '.' || !part || part.endsWith('.lock')) &&
  (name.includes('/')
    ? name === 'logs/HEAD' || metadataDirectories.some((directory) => name.startsWith(`${directory}/`))
    : !commonFiles.has(name) && !name.startsWith(prefix) && !name.includes(`.${prefix}`));
const hash = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const fileMap = (value: unknown) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.entries(value).every(([name, fingerprintValue]) => safeMetadataName(name) && hash(fingerprintValue));
const refMap = (value: unknown) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.entries(value).every(
    ([name, revision]) =>
      name.startsWith('refs/heads/') &&
      (revision === null || (typeof revision === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)))
  );
const noSymlinks = async (directory: string, relative = '') => {
  const parts = [directory, ...relative.split('/').filter(Boolean)];
  let current = '';
  for (const part of parts) {
    current = current ? path.join(current, part) : part;
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Symbolic links are not supported in recovery state: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
};

/** Shared refs, object stores and caches stay in the common Git directory. Copy worktree state and hook marker files. */
export async function metadataFiles(directory: string): Promise<FileMap> {
  const files: FileMap = {};
  const scan = async (relative: string) => {
    let entries;
    try {
      entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.endsWith('.lock')) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await scan(name);
      else if (entry.isFile()) files[name] = (await fingerprint(path.join(directory, name)))!;
      else throw new Error(`Unsupported symbolic link in Git operation metadata: ${name}`);
    }
  };
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!safeMetadataName(entry.name)) continue;
    if (entry.isFile()) files[entry.name] = (await fingerprint(path.join(directory, entry.name)))!;
  }
  for (const relative of metadataDirectories) {
    await noSymlinks(directory, relative);
    await scan(relative);
  }
  const log = await fingerprint(path.join(directory, 'logs', 'HEAD'));
  if (log) files['logs/HEAD'] = log;
  return files;
}

export async function writeJournal(journal: HistoryJournal) {
  const file = path.join(journal.gitDir, manifestName);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(journal));
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function createHistoryWorkspace(root: string, git: GitExecutor, gitDir: string, indexPath: string) {
  const workspace = path.join(gitDir, `${prefix}${randomUUID()}`);
  const privateDir = path.join(workspace, 'git');
  await mkdir(privateDir, { recursive: true });
  let retained = false;
  try {
    const commonDir = path.resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).stdout.trim());
    const before = await metadataFiles(gitDir);
    const beforeRefs: RefMap = {};
    for (const name of ['HEAD', 'rebase-merge/head-name', 'rebase-apply/head-name']) {
      const contents = (await readOptional(path.join(gitDir, name)))
        ?.toString('utf8')
        .trim()
        .replace(/^ref: /, '');
      if (contents?.startsWith('refs/heads/')) beforeRefs[contents] = await resolveHistoryRef(root, git)(contents);
    }
    const journal: HistoryJournal = {
      version: 1,
      phase: 'running',
      workspace,
      gitDir,
      indexPath,
      beforeHead: await fingerprint(path.join(gitDir, 'HEAD')),
      beforeIndex: await fingerprint(indexPath),
      before,
      beforeRefs,
    };
    for (const name of Object.keys(before)) {
      await mkdir(path.dirname(path.join(privateDir, name)), { recursive: true });
      await copyFile(path.join(gitDir, name), path.join(privateDir, name));
    }
    await copyFile(path.join(gitDir, 'HEAD'), path.join(privateDir, 'HEAD'));
    if (journal.beforeIndex) {
      await copyFile(indexPath, path.join(privateDir, 'index'));
      await chmod(path.join(privateDir, 'index'), 0o600);
    }
    await chmod(path.join(privateDir, 'HEAD'), 0o600);
    await writeFile(path.join(privateDir, 'commondir'), `${commonDir}\n`);
    const [config, hooks] = await Promise.all([
      git(root, ['config', '--null', '--list', '--includes']),
      git(root, ['rev-parse', '--git-path', 'hooks']),
    ]);
    const configFile = path.join(workspace, 'effective.config');
    await writeFile(
      configFile,
      `${flattenConfig(config.stdout)}\n[core]\n\thooksPath = ${quoteConfig(path.resolve(root, hooks.stdout.trim()).replaceAll('\\', '/'))}\n`
    );
    const isolated: GitExecutor = (cwd, args, allowed, options) =>
      git(cwd, args, allowed, {
        ...options,
        gitDirectory: privateDir,
        commonDirectory: commonDir,
        workTree: root,
        indexFile: path.join(privateDir, 'index'),
        configFile,
      });
    // Once journal installation starts, retain the directory even if that installation is interrupted.
    retained = true;
    await writeJournal(journal);
    return { journal, isolated };
  } finally {
    if (!retained) await rm(workspace, { recursive: true, force: true });
  }
}

export async function preparePublication(journal: HistoryJournal, resolveRef: ResolveRef) {
  journal.after = await metadataFiles(privateGitDir(journal));
  journal.afterHead = await fingerprint(path.join(privateGitDir(journal), 'HEAD'));
  journal.afterIndex = await fingerprint(path.join(privateGitDir(journal), 'index'));
  journal.afterRefs = {};
  for (const name of Object.keys(journal.beforeRefs)) journal.afterRefs[name] = await resolveRef(name);
  journal.phase = 'ready';
  await writeJournal(journal);
}

/** Use a distinct temporary file so real HEAD.lock/index.lock remain held throughout publication. */
const installFile = async (source: string, destination: string) => {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${prefix}${randomUUID()}`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
};

export async function publishHistory(journal: HistoryJournal, resolveRef: ResolveRef) {
  if (journal.phase !== 'ready' || !journal.after)
    throw pendingHistoryError(
      journal,
      'the previous Git process was interrupted; inspect its retained state before recovering'
    );
  const privateDir = privateGitDir(journal);
  try {
    await noSymlinks(privateDir, 'HEAD');
    await noSymlinks(privateDir, 'index');
    for (const [name, expected] of Object.entries(journal.afterRefs ?? {})) {
      if ((await resolveRef(name)) !== expected) throw new Error(`External reference changed: ${name}`);
    }
    // A retry may observe a partly published result. Accept only its recorded before/after bytes.
    for (const [destination, before, after] of [
      [path.join(journal.gitDir, 'HEAD'), journal.beforeHead, journal.afterHead],
      [journal.indexPath, journal.beforeIndex, journal.afterIndex],
    ] as const) {
      const actual = await fingerprint(destination);
      if (actual !== before && actual !== after) throw new Error(`External changes prevent recovery of ${destination}`);
    }
    const names = new Set([...Object.keys(journal.before), ...Object.keys(journal.after)]);
    const changed = [...names].filter((name) => journal.before[name] !== journal.after![name]);
    for (const name of changed) {
      await noSymlinks(privateDir, name);
      await noSymlinks(journal.gitDir, name);
      const target = journal.after[name] ?? null;
      if ((await fingerprint(path.join(privateDir, name))) !== target)
        throw new Error(`Retained state changed: ${name}`);
      const actual = await fingerprint(path.join(journal.gitDir, name));
      if (actual !== (journal.before[name] ?? null) && actual !== target)
        throw new Error(`External metadata changed: ${name}`);
    }
    if (
      (await fingerprint(path.join(privateDir, 'HEAD'))) !== journal.afterHead ||
      (await fingerprint(path.join(privateDir, 'index'))) !== journal.afterIndex
    )
      throw new Error('Retained HEAD or index changed');
    for (const name of changed) {
      if (journal.after[name]) await installFile(path.join(privateDir, name), path.join(journal.gitDir, name));
      else await rm(path.join(journal.gitDir, name), { force: true });
    }
    // Git detects these operations by directory existence, including empty directories.
    for (const name of ['rebase-merge', 'rebase-apply', 'sequencer']) {
      if (!Object.keys(journal.after).some((file) => file.startsWith(`${name}/`))) {
        await rmdir(path.join(journal.gitDir, name)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
    if (journal.afterIndex) await installFile(path.join(privateDir, 'index'), journal.indexPath);
    else await rm(journal.indexPath, { force: true });
    await installFile(path.join(privateDir, 'HEAD'), path.join(journal.gitDir, 'HEAD'));
    await rm(path.join(journal.gitDir, manifestName));
    // Publication is complete after removing the journal; scratch cleanup cannot make it retryable.
    await rm(journal.workspace, { recursive: true, force: true }).catch((): undefined => undefined);
  } catch (error) {
    throw pendingHistoryError(journal, error instanceof Error ? error.message : String(error));
  }
}

export async function acquireHistoryLocks(gitDir: string, indexPath: string) {
  const owned: string[] = [];
  const release = async () => {
    for (const file of owned.toReversed()) await rm(file, { force: true });
  };
  try {
    for (const file of [path.join(gitDir, 'HEAD.lock'), `${indexPath}.lock`]) {
      const handle = await open(file, 'wx');
      owned.push(file);
      await handle.close();
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

/** Inspect can retry a completed publication; it never trusts a stale index after a failed publish. */
export async function recoverPendingHistory(
  gitDir: string,
  actualIndexPath: () => Promise<string>,
  resolveRef: ResolveRef
) {
  const raw = await readOptional(path.join(gitDir, manifestName));
  if (!raw) return;
  const journal = JSON.parse(raw.toString('utf8')) as HistoryJournal;
  if (
    !journal ||
    journal.version !== 1 ||
    !['running', 'ready'].includes(journal.phase) ||
    journal.gitDir !== gitDir ||
    typeof journal.workspace !== 'string' ||
    path.dirname(journal.workspace) !== gitDir ||
    !/^woody-history-[0-9a-f-]{36}$/.test(path.basename(journal.workspace)) ||
    journal.indexPath !== (await actualIndexPath()) ||
    !hash(journal.beforeHead) ||
    !(journal.beforeIndex === null || hash(journal.beforeIndex)) ||
    !fileMap(journal.before) ||
    !refMap(journal.beforeRefs) ||
    (journal.phase === 'ready' &&
      (!fileMap(journal.after) ||
        !refMap(journal.afterRefs) ||
        Object.keys(journal.beforeRefs).some((name) => !(name in journal.afterRefs!)) ||
        !hash(journal.afterHead) ||
        !(journal.afterIndex === null || hash(journal.afterIndex))))
  )
    throw new Error(`Invalid history recovery journal: ${path.join(gitDir, manifestName)}`);
  await noSymlinks(gitDir);
  await noSymlinks(journal.workspace, 'git');
  await noSymlinks(gitDir, 'HEAD');
  await noSymlinks(path.dirname(journal.indexPath), path.basename(journal.indexPath));
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireHistoryLocks(gitDir, journal.indexPath);
    await publishHistory(journal, resolveRef);
  } catch (error) {
    throw pendingHistoryError(journal, error instanceof Error ? error.message : String(error));
  } finally {
    await release?.();
  }
}
