import { execFile, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export type GitCommandOutput = { stdout: string; stderr: string; code: number; truncated?: boolean; buffer?: Buffer };
type StopReason = 'abort' | 'timeout' | 'stdout' | 'stderr';

/** Terminate only the tracked process tree, while its parent still identifies the owned descendants. */
const terminateTree = async (child: ChildProcess): Promise<void> => {
  if (!child.pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    return Promise.resolve();
  }
  // Do not pass AbortSignal to spawn: it would kill Git before taskkill can find its helpers.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    execFile(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 5000 },
      (error) => {
        if (error && child.exitCode === null && child.signalCode === null)
          reject(new Error('Unable to terminate owned Git process tree', { cause: error }));
        else resolve();
      }
    );
  });
};

/** Run bounded Git commands without a shell, retaining ownership until forced tree termination finishes. */
export const createGitExecutor =
  (executable = 'git', literalPathspecs = true) =>
  async (
    root: string,
    args: string[],
    allowFailure = false,
    options: {
      maxBuffer?: number;
      truncate?: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
      binary?: boolean;
      input?: Buffer;
      indexFile?: string;
      /** Internal isolated operation context; never accepted from IPC. */
      gitDirectory?: string;
      commonDirectory?: string;
      workTree?: string;
      configFile?: string;
      /** Main-process generated script only; never accepted from IPC. */
      sequenceEditorFile?: string;
      /** Internal child environment. Safety and non-interactive variables are applied after it. */
      env?: NodeJS.ProcessEnv;
    } = {}
  ): Promise<GitCommandOutput> => {
    if (options.signal?.aborted) throw new Error('The operation was aborted');
    if (options.input && options.input.length > 8 * 1024 * 1024) throw new Error('Git input exceeds size limit');
    return new Promise<GitCommandOutput>((resolve, reject) => {
      const child = spawn(
        executable,
        [
          '--no-pager',
          ...(literalPathspecs ? ['--literal-pathspecs'] : []),
          '-c',
          'core.quotepath=false',
          '-c',
          'color.ui=false',
          '-c',
          'log.showSignature=false',
          '-c',
          'i18n.logOutputEncoding=UTF-8',
          ...(options.configFile ? ['-c', `include.path=${options.configFile}`] : []),
          ...args,
        ],
        {
          cwd: root,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...(options.env ?? process.env),
            GIT_TERMINAL_PROMPT: '0',
            GIT_NO_LAZY_FETCH: '1',
            GIT_OPTIONAL_LOCKS: '0',
            LC_ALL: 'C',
            GIT_EDITOR: ':',
            GIT_SEQUENCE_EDITOR: options.sequenceEditorFile
              ? [process.execPath, options.sequenceEditorFile]
                  .map((value) => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`)
                  .join(' ')
              : ':',
            ...(options.sequenceEditorFile ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
            GIT_MERGE_AUTOEDIT: 'no',
            ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
            ...(options.gitDirectory ? { GIT_DIR: options.gitDirectory } : {}),
            ...(options.commonDirectory ? { GIT_COMMON_DIR: options.commonDirectory } : {}),
            ...(options.workTree ? { GIT_WORK_TREE: options.workTree } : {}),
          },
        }
      );
      const buffers = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      const lengths = { stdout: 0, stderr: 0 };
      const limit = options.maxBuffer ?? 8 * 1024 * 1024;
      let reason: StopReason | undefined;
      let termination: Promise<void> | undefined;
      let cleanupError: Error | undefined;
      let finished = false;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (code: number | null, error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        clearTimeout(closeTimer);
        options.signal?.removeEventListener('abort', abort);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        const buffer = Buffer.concat(buffers.stdout);
        const stdout = buffer.toString('utf8');
        const stderr = Buffer.concat(buffers.stderr).toString('utf8');
        if (cleanupError) {
          reject(cleanupError);
          return;
        }
        if (reason === 'stdout' && options.truncate) {
          resolve({ stdout, stderr: '', code: 0, truncated: true });
          return;
        }
        if (reason) {
          const message =
            reason === 'abort'
              ? 'The operation was aborted'
              : reason === 'timeout'
                ? 'Git command timed out'
                : `${reason} exceeded maxBuffer length`;
          reject(new Error(message));
          return;
        }
        if (error) {
          reject(error);
          return;
        }
        if (code === 0 || (allowFailure && code !== null)) {
          resolve({ stdout, stderr, code: code ?? 0, ...(options.binary ? { buffer } : {}) });
          return;
        }
        reject(new Error(stderr.trim() || 'Git command failed'));
      };
      const stop = (requested: StopReason) => {
        if (reason || finished) return;
        reason = requested;
        clearTimeout(timeout);
        // Buffer capture stops immediately; termination itself also has a fixed time budget.
        termination = terminateTree(child).catch((error: unknown) => {
          cleanupError = error instanceof Error ? error : new Error('Git process tree termination failed');
        });
        void termination.then(() => {
          if (!finished) closeTimer = setTimeout(() => finish(child.exitCode), 1000);
        });
      };
      const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        if (reason || finished) return;
        const available = Math.max(0, limit - lengths[stream]);
        if (available) buffers[stream].push(chunk.subarray(0, available));
        lengths[stream] += Math.min(available, chunk.length);
        if (chunk.length > available) stop(stream);
      };
      const abort = () => stop('abort');
      const timeout = setTimeout(() => stop('timeout'), options.timeoutMs ?? 30_000);
      child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk));
      child.once('error', (error) => finish(null, error));
      child.once('close', (code) => {
        void (termination ?? Promise.resolve()).then(() => finish(code));
      });
      // An early-exiting Git command may close stdin before all reviewed bytes have been consumed.
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE' && error.code !== 'EOF') child.emit('error', error);
      });
      if (options.input !== undefined) child.stdin.end(options.input);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  };
export type GitExecutor = ReturnType<typeof createGitExecutor>;
