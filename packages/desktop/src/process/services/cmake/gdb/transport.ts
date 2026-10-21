import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseRecord, textField, type MiFields, type MiRecord } from './protocol';

export type GdbLaunch = { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
export type GdbEvents = { onRecord: (record: MiRecord) => void; onExit: (error?: string) => void };
export type MiConnection = { command: (command: string) => Promise<MiFields>; close: () => Promise<void> };
type Pending = {
  resolve: (data: MiFields) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Tokenized MI2 transport. One bounded line buffer and bounded pending command table. */
export class GdbTransport implements MiConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly completion: Promise<void>;
  private closing: Promise<void> | undefined;
  private sequence = 0;
  private ended = false;
  private failure: string | undefined;

  constructor(
    launch: GdbLaunch,
    events: GdbEvents,
    private readonly timeoutMs = 10000
  ) {
    this.child = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: 'pipe',
    });
    const decoder = new StringDecoder('utf8');
    const stderr = new StringDecoder('utf8');
    let buffer = '';
    this.child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      try {
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          const record = parseRecord(line);
          if (!record) {
            if (line !== '(gdb)' && line !== '(gdb) ' && line)
              events.onRecord({ kind: '@', class: 'target', data: {}, text: line + '\n' });
            continue;
          }
          if (record.kind === '^' && record.token !== undefined) {
            const request = this.pending.get(record.token);
            if (request) {
              clearTimeout(request.timer);
              this.pending.delete(record.token);
              if (record.class === 'error')
                request.reject(new Error(textField(record.data.msg) ?? 'gdb.commandFailed'));
              else request.resolve(record.data);
            }
          } else events.onRecord(record);
        }
        if (buffer.length > 262144) throw new Error('gdb.outputLimit');
      } catch (error) {
        this.fail(error instanceof Error ? error.message : 'gdb.protocolError');
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) =>
      events.onRecord({ kind: '&', class: 'log', data: {}, text: stderr.write(chunk).slice(-65536) })
    );
    this.child.stdin.on('error', (error) => this.fail(error.message));
    this.child.on('error', (error) => {
      this.failure = error.message;
    });
    this.completion = new Promise<void>((resolve) => {
      this.child.once('close', (code) => {
        this.ended = true;
        this.rejectPending(this.failure ?? 'gdb.closed');
        events.onExit(this.failure ?? (!this.closing && code !== 0 ? `gdb.processExit: ${code}` : undefined));
        resolve();
      });
    });
  }

  /** Send one complete MI command; errors retain the session, timeouts terminate it. */
  command(command: string): Promise<MiFields> {
    if (
      !/^-[a-z][a-z0-9-]*(?: |$)/.test(command) ||
      /[\r\n]/.test(command) ||
      command.includes('\0') ||
      command.length > 32768
    )
      return Promise.reject(new Error('gdb.invalidInput'));
    if (this.ended || this.closing) return Promise.reject(new Error('gdb.closed'));
    if (this.pending.size >= 16) return Promise.reject(new Error('gdb.busy'));
    return new Promise((resolve, reject) => {
      const token = ++this.sequence;
      const timer = setTimeout(() => this.fail('gdb.timeout'), this.timeoutMs);
      this.pending.set(token, { resolve, reject, timer });
      this.child.stdin.write(`${token}${command}\n`, (error) => {
        if (error) this.fail(error.message);
      });
    });
  }

  private rejectPending(reason: string): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private fail(reason: string): void {
    this.failure ??= reason;
    this.rejectPending(reason);
    void this.close();
  }

  /** Terminate the owned debugger tree and wait for pipe closure before releasing it. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.ended) return this.completion;
    this.closing = (async () => {
      this.rejectPending(this.failure ?? 'gdb.closed');
      if (this.child.pid) {
        if (process.platform === 'win32') {
          await new Promise<void>((resolve) => {
            const killer = spawn(
              path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
              ['/PID', String(this.child.pid), '/T', '/F'],
              { shell: false, windowsHide: true, stdio: 'ignore' }
            );
            killer.once('error', () => {
              this.child.kill();
              resolve();
            });
            killer.once('close', (code) => {
              if (code !== 0 && !this.ended) this.child.kill();
              resolve();
            });
          });
        } else {
          try {
            process.kill(-this.child.pid, 'SIGKILL');
          } catch {
            this.child.kill('SIGKILL');
          }
        }
      }
      await this.completion;
    })();
    return this.closing;
  }
}
