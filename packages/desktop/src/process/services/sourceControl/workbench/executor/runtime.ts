import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const MINIMUM_GIT_VERSION = [2, 25, 0] as const;

export type GitRuntimeSource = 'configured' | 'system' | 'bundled';
export type GitRuntimeVersion = {
  major: number;
  minor: number;
  patch: number;
  raw: string;
};

export type GitRuntime = {
  executable: string;
  requestedPath: string;
  source: GitRuntimeSource;
  version: GitRuntimeVersion;
  capabilities: {
    /** Safe `rebase --no-update-refs` argument and update-refs UI. */
    updateRefs: boolean;
    /** In-memory history editing used only where the host supports it. */
    memoryHistoryEdit: boolean;
  };
};

export type GitResolutionAttempt = {
  source: GitRuntimeSource;
  path: string;
  reason: string;
};

export class GitResolutionError extends Error {
  constructor(
    message: string,
    readonly attempts: GitResolutionAttempt[]
  ) {
    super(message);
    this.name = 'GitResolutionError';
  }
}

export type GitResolverOptions = {
  /** An explicit host preference. A failure here is terminal and never falls back. */
  configuredPath?: string;
  /** Absolute path to the packaged fallback executable. */
  bundledExecutable?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Host/test port; the renderer cannot supply this. */
  systemCandidates?: string[];
  /** Returns a canonical regular-file path or throws. */
  inspectPath?: (candidate: string) => Promise<string>;
  /** Runs the executable with `--version` and returns stdout. */
  probe?: (executable: string) => Promise<string>;
};

const defaultInspectPath = async (candidate: string): Promise<string> => {
  if (!path.isAbsolute(candidate)) throw new Error('Git executable path must be absolute');
  const canonical = await realpath(candidate);
  if (!(await stat(canonical)).isFile()) throw new Error('Git executable path is not a file');
  return canonical;
};

const defaultProbe = (executable: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      ['--version'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      }
    );
  });

/** Find executable candidates in PATH without invoking a shell. */
export function systemGitCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  const names = platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat'] : ['git'];
  const directories = (env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  return [...new Set(directories.flatMap((directory) => names.map((name) => path.join(directory, name))))];
}

export const parseGitVersion = (output: string): GitRuntimeVersion | undefined => {
  const match = output.match(/\bgit version\s+(\d+)\.(\d+)(?:\.(\d+))?([^\s]*)/i);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    raw: `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}${match[4] ?? ''}`,
  };
};

const atLeast = (version: GitRuntimeVersion, minimum: readonly [number, number, number]): boolean =>
  version.major > minimum[0] ||
  (version.major === minimum[0] &&
    (version.minor > minimum[1] || (version.minor === minimum[1] && version.patch >= minimum[2])));

const reasonFor = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown Git resolution failure';

const inspectRuntime = async (
  source: GitRuntimeSource,
  requestedPath: string,
  inspectPath: (candidate: string) => Promise<string>,
  probe: (executable: string) => Promise<string>
): Promise<GitRuntime> => {
  const executable = await inspectPath(requestedPath);
  const version = parseGitVersion(await probe(executable));
  if (!version) throw new Error('Git did not report a recognizable version');
  if (!atLeast(version, MINIMUM_GIT_VERSION)) {
    throw new Error(`Git ${version.raw} is older than the supported minimum 2.25.0`);
  }
  return {
    executable,
    requestedPath,
    source,
    version,
    capabilities: {
      updateRefs: atLeast(version, [2, 38, 0]),
      memoryHistoryEdit: atLeast(version, [2, 40, 0]),
    },
  };
};

/** Detect configured, system and bundled Git in that order. Explicit failures are terminal. */
export async function resolveGitRuntime(options: GitResolverOptions = {}): Promise<GitRuntime> {
  const inspectPath = options.inspectPath ?? defaultInspectPath;
  const probe = options.probe ?? defaultProbe;
  const configured = options.configuredPath?.trim();
  if (configured) {
    try {
      return await inspectRuntime('configured', configured, inspectPath, probe);
    } catch (error) {
      const reason = reasonFor(error);
      throw new GitResolutionError(`Configured Git is unavailable: ${reason}`, [
        { source: 'configured', path: configured, reason },
      ]);
    }
  }

  const attempts: GitResolutionAttempt[] = [];
  const candidates = options.systemCandidates ?? systemGitCandidates(options.env, options.platform ?? process.platform);
  for (const candidate of new Set(candidates.filter(Boolean))) {
    try {
      return await inspectRuntime('system', candidate, inspectPath, probe);
    } catch (error) {
      attempts.push({ source: 'system', path: candidate, reason: reasonFor(error) });
    }
  }

  if (options.bundledExecutable) {
    try {
      return await inspectRuntime('bundled', options.bundledExecutable, inspectPath, probe);
    } catch (error) {
      attempts.push({ source: 'bundled', path: options.bundledExecutable, reason: reasonFor(error) });
    }
  } else {
    attempts.push({ source: 'bundled', path: '(not configured)', reason: 'No packaged Git fallback is available' });
  }

  throw new GitResolutionError(
    attempts.length
      ? `No supported Git executable is available: ${attempts.at(-1)!.reason}`
      : 'No Git executable was found',
    attempts
  );
}

/** Resolve once at host startup and share the verified executable across all Git services. */
export function createGitRuntimeResolver(options: GitResolverOptions) {
  let pending: Promise<GitRuntime> | undefined;
  return {
    get(): Promise<GitRuntime> {
      pending ??= resolveGitRuntime(options);
      return pending;
    },
  };
}
