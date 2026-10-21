import { spawn } from 'node:child_process';
import path from 'node:path';
import { decodeCommandOutput, readWindowsCodePage } from '../sourceControl/staticScanService';

export type ProcessRequest = {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput: (text: string) => void;
};
export type ProcessResult = { code: number; output: string };
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

/** Spawn a shell-free process and hold ownership until its entire pipe lifetime ends. */
export function createOutputDecoder(
  codePage: number | undefined,
  emit: (text: string) => void
): { write: (bytes: Buffer) => void; end: () => void } {
  let pending = Buffer.alloc(0);
  const flush = (count: number): void => {
    emit(decodeCommandOutput(pending.subarray(0, count), codePage));
    pending = pending.subarray(count);
  };
  return {
    write: (bytes) => {
      pending = Buffer.concat([pending, bytes]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) flush(newline + 1);
      // Compiler diagnostics are line based; bound a malformed unterminated line.
      if (pending.length > 65536) flush(pending.length - 4);
    },
    end: () => {
      if (pending.length) flush(pending.length);
    },
  };
}

export const runProcess: ProcessRunner = async (request) => {
  const codePage = await readWindowsCodePage();
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new Error('cmake.cancelled'));
      return;
    }
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let failure: Error | undefined;
    let output = '';
    let stopping = false;
    let termination = Promise.resolve();
    const emit = (text: string): void => {
      output = (output + text).slice(-262144);
      request.onOutput(text);
    };
    const stdout = createOutputDecoder(codePage, emit);
    const stderr = createOutputDecoder(codePage, emit);
    child.stdout.on('data', (chunk: Buffer) => stdout.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.write(chunk));
    const stop = (reason: string): void => {
      if (stopping) return;
      stopping = true;
      failure = new Error(reason);
      if (!child.pid) return;
      if (process.platform === 'win32') {
        termination = new Promise<void>((done) => {
          const killer = spawn(
            path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, shell: false, stdio: 'ignore' }
          );
          killer.on('error', () => {
            child.kill();
            done();
          });
          killer.on('close', (code) => {
            if (code !== 0) child.kill();
            done();
          });
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const abort = (): void => stop('cmake.cancelled');
    request.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('cmake.timeout'), request.timeoutMs);
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
      stdout.end();
      stderr.end();
      void termination.then(() => {
        if (failure) reject(failure);
        else resolve({ code: code ?? -1, output });
      });
    });
  });
};
