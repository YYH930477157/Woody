import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Read every tracked and non-ignored untracked file, including clean files. */
export const captureWorktree = async (repoPath: string): Promise<Map<string, string>> => {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const snapshot = new Map<string, string>();
  const gitValue = async (args: string[]): Promise<string> => {
    try {
      return (await execFileAsync('git', args, { cwd: repoPath, encoding: 'utf8', windowsHide: true })).stdout;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return '';
      throw error;
    }
  };
  const [head, branch, index] = await Promise.all([
    gitValue(['rev-parse', '--verify', '--quiet', 'HEAD']),
    gitValue(['symbolic-ref', '--quiet', 'HEAD']),
    gitValue(['ls-files', '--stage', '-z']),
  ]);
  snapshot.set(
    '\0git-state',
    createHash('sha256')
      .update(JSON.stringify([head, branch, index]))
      .digest('hex')
  );
  // Bound open file handles on large repositories.
  const paths = [...new Set(stdout.split('\0').filter(Boolean))];
  for (let offset = 0; offset < paths.length; offset += 32) {
    await Promise.all(
      paths.slice(offset, offset + 32).map(async (file) => {
        const absolute = resolve(repoPath, file);
        const rel = relative(repoPath, absolute);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
          throw new Error('Invalid repository file path');
        }
        try {
          const stat = await lstat(absolute);
          const content = stat.isSymbolicLink()
            ? await readlink(absolute)
            : stat.isFile()
              ? await readFile(absolute)
              : '';
          snapshot.set(file, `${stat.mode}:${createHash('sha256').update(content).digest('hex')}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          snapshot.set(file, 'deleted');
        }
      })
    );
  }
  return snapshot;
};

/** Compare content rather than trusting an agent's declared changed paths. */
export const changedWorktreePaths = (before: Map<string, string>, after: Map<string, string>): string[] =>
  [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file));
