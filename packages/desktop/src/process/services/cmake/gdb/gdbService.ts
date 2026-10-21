import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { GdbFrame, GdbReply, GdbRequest, GdbSession } from '@/common/types/cmake/gdb';
import { fields, quoteMi, readPath, textField, type MiFields, type MiRecord } from './protocol';
import { GdbTransport, type GdbEvents, type GdbLaunch, type MiConnection } from './transport';
import { gdbRequestSchema } from './validation';
import { createInferiorOutput, type InferiorOutput } from './inferiorOutput';

export type DebugTarget = {
  projectPath: string;
  buildDirectory: string;
  executable: string;
  args: string[];
  gdbPath: string;
  env: NodeJS.ProcessEnv;
  release: () => void;
};
type State = {
  snapshot: GdbSession;
  connection?: MiConnection;
  target?: DebugTarget;
  outputChannel?: InferiorOutput;
  initialization: Promise<void>;
  finishing?: Promise<void>;
  stopping: boolean;
  busy: boolean;
};
type Factory = (launch: GdbLaunch, events: GdbEvents) => MiConnection;
const key = (root: string) => (process.platform === 'win32' ? root.toLowerCase() : root);
const terminal = (state: GdbSession['state']) => state === 'exited' || state === 'failed';
const frame = (value: MiFields): GdbFrame => ({
  level: textField(value.level) ?? '0',
  func: textField(value.func),
  file: textField(value.file),
  fullname: textField(value.fullname),
  line: textField(value.line),
  addr: textField(value.addr),
});

/** A single, lazily launched debugger shared by all panels and agent conversations. */
export class GdbService {
  private current?: State;
  private disposed = false;
  constructor(
    private readonly acquire: (projectPath: string) => Promise<DebugTarget>,
    private readonly connect: Factory = (launch, events) => new GdbTransport(launch, events),
    private readonly canonical: (root: string) => Promise<string> = realpath
  ) {}

  /** Dispatch validated operations. Session IDs prevent stale clients controlling a replacement. */
  async request(raw: unknown): Promise<GdbReply> {
    // Zod enforces required fields at runtime even when strictNullChecks is disabled.
    const input = gdbRequestSchema.parse(raw) as GdbRequest;
    const root = await this.canonical(input.projectPath);
    if (this.disposed) throw new Error('gdb.closed');
    if (input.operation === 'start') {
      if (this.current && !terminal(this.current.snapshot.state)) throw new Error('gdb.busy');
      const state: State = {
        snapshot: {
          id: randomUUID(),
          projectPath: root,
          buildDirectory: '',
          executable: '',
          gdbPath: '',
          state: 'starting',
          breakpoints: [],
          output: '',
          outputTruncated: false,
          revision: 0,
        },
        initialization: Promise.resolve(),
        stopping: false,
        busy: false,
      };
      this.current = state;
      state.initialization = this.initialize(state);
      return this.reply(state);
    }
    const state = this.current;
    if (input.operation === 'status')
      return state && key(state.snapshot.projectPath) === key(root) ? this.reply(state) : {};
    if (
      !state ||
      key(state.snapshot.projectPath) !== key(root) ||
      !('sessionId' in input) ||
      state.snapshot.id !== input.sessionId
    )
      throw new Error('gdb.sessionChanged');
    if (input.operation === 'stop') {
      await this.finish(state);
      return this.reply(state);
    }
    if (state.busy || state.stopping || state.snapshot.state === 'starting') throw new Error('gdb.busy');
    if (!state.connection || terminal(state.snapshot.state)) throw new Error('gdb.closed');
    if (input.operation === 'pause') {
      if (state.snapshot.state !== 'running') throw new Error('gdb.notRunning');
    } else if (state.snapshot.state !== 'stopped') throw new Error('gdb.notStopped');
    state.busy = true;
    try {
      return await this.execute(state, input);
    } finally {
      state.busy = false;
    }
  }

  private reply(state: State, extra: Omit<GdbReply, 'session'> = {}): GdbReply {
    return { session: structuredClone(state.snapshot), ...extra };
  }

  private async initialize(state: State): Promise<void> {
    try {
      const target = await this.acquire(state.snapshot.projectPath);
      state.target = target;
      Object.assign(state.snapshot, {
        buildDirectory: target.buildDirectory,
        executable: target.executable,
        gdbPath: target.gdbPath,
      });
      if (state.stopping) return;
      if (process.platform === 'win32') {
        state.outputChannel = await createInferiorOutput((text) =>
          this.record(state, { kind: '@', class: 'target', data: {}, text })
        );
        if (state.stopping) return;
      }
      state.connection = this.connect(
        {
          executable: target.gdbPath,
          args: ['--nx', '--quiet', '--interpreter=mi2', '-iex', 'set auto-load off'],
          cwd: target.buildDirectory,
          env: target.env,
        },
        {
          onRecord: (record) => this.record(state, record),
          onExit: (error) => {
            if (!state.stopping) state.snapshot.error = error ?? 'gdb.closed';
            void this.finish(state);
          },
        }
      );
      const commands = [
        '-gdb-set mi-async on',
        '-gdb-set pagination off',
        '-gdb-set confirm off',
        ...(process.platform === 'win32' ? [] : ['-gdb-set startup-with-shell off']),
        '-gdb-set may-call-functions off',
        '-gdb-set print elements 100',
        '-gdb-set print repeats 10',
        '-gdb-set print max-depth 5',
        ...(state.outputChannel ? [`-inferior-tty-set ${quoteMi(state.outputChannel.terminal)}`] : []),
        `-file-exec-and-symbols ${quoteMi(target.executable)}`,
        `-exec-arguments ${target.args.map(quoteMi).join(' ')}`,
        '-break-insert -t main',
      ];
      for (const command of commands) {
        if (state.stopping) return;
        await state.connection.command(command);
      }
      if (state.stopping) return;
      state.snapshot.state = 'running';
      state.snapshot.revision++;
      await state.connection.command('-exec-run');
    } catch (error) {
      if (!state.stopping) state.snapshot.error = error instanceof Error ? error.message : 'gdb.commandFailed';
      void this.finish(state);
    }
  }

  private record(state: State, record: MiRecord): void {
    if (terminal(state.snapshot.state)) return;
    const snapshot = state.snapshot;
    if (record.text) {
      const text = snapshot.output + record.text;
      snapshot.outputTruncated ||= text.length > 65536;
      snapshot.output = text.slice(-65536);
    }
    if (state.stopping) return;
    if (record.kind === '*' && record.class === 'running') {
      snapshot.state = 'running';
      snapshot.frame = undefined;
      snapshot.reason = undefined;
      snapshot.revision++;
    } else if (record.kind === '*' && record.class === 'stopped') {
      snapshot.reason = textField(record.data.reason);
      snapshot.revision++;
      if (snapshot.reason?.startsWith('exited')) {
        void this.finish(state);
        return;
      }
      snapshot.state = 'stopped';
      snapshot.frame = frame(fields(record.data.frame));
    } else if (record.kind === '=' && record.class === 'thread-group-exited') {
      snapshot.reason ??= 'exited';
      void this.finish(state);
    }
  }

  private async execute(state: State, input: GdbRequest): Promise<GdbReply> {
    const connection = state.connection!;
    const commands = {
      pause: '-exec-interrupt --all',
      continue: '-exec-continue',
      next: '-exec-next',
      step: '-exec-step',
      finish: '-exec-finish',
    };
    if (input.operation in commands) {
      const operation = input.operation as keyof typeof commands;
      const previous = structuredClone(state.snapshot);
      if (operation !== 'pause') {
        state.snapshot.state = 'running';
        state.snapshot.frame = undefined;
        state.snapshot.reason = undefined;
        state.snapshot.revision++;
      }
      const revision = state.snapshot.revision;
      try {
        await connection.command(commands[operation]);
      } catch (error) {
        if (!state.stopping && state.snapshot.revision === revision) {
          state.snapshot.state = previous.state;
          state.snapshot.frame = previous.frame;
          state.snapshot.reason = previous.reason;
          state.snapshot.revision++;
        }
        throw error;
      }
      return this.reply(state);
    }
    const revision = state.snapshot.revision;
    const inspect = async (command: string): Promise<MiFields> => {
      const result = await connection.command(command);
      if (state.stopping || state.snapshot.state !== 'stopped' || state.snapshot.revision !== revision)
        throw new Error('gdb.stateChanged');
      return result;
    };
    switch (input.operation) {
      case 'breakpointAdd': {
        const location = input.location.trim();
        if (
          !location ||
          location.startsWith('-') ||
          !(
            /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/.test(location) ||
            /^[\p{L}\p{N}_./\\: -]+:[1-9][0-9]{0,8}$/u.test(location)
          ) ||
          state.snapshot.breakpoints.length >= 64
        )
          throw new Error('gdb.invalidInput');
        const result = fields((await inspect(`-break-insert ${quoteMi(location)}`)).bkpt);
        const number = textField(result.number);
        if (!number) throw new Error('gdb.protocolError');
        state.snapshot.breakpoints.push({
          number,
          location,
          file: textField(result.fullname) ?? textField(result.file),
          line: textField(result.line),
        });
        return this.reply(state);
      }
      case 'breakpointRemove':
        if (!state.snapshot.breakpoints.some((entry) => entry.number === input.number))
          throw new Error('gdb.invalidInput');
        await inspect(`-break-delete ${input.number}`);
        state.snapshot.breakpoints = state.snapshot.breakpoints.filter((entry) => entry.number !== input.number);
        return this.reply(state);
      case 'evaluate': {
        const result = await inspect(`-data-evaluate-expression ${quoteMi(readPath(input.expression))}`);
        return this.reply(state, { value: textField(result.value) ?? '' });
      }
      case 'memory': {
        const result = await inspect(`-data-read-memory-bytes ${input.address} ${input.count}`);
        const memory = Array.isArray(result.memory)
          ? result.memory.map((entry) => {
              const data = fields(entry);
              return { begin: textField(data.begin) ?? '', contents: textField(data.contents) ?? '' };
            })
          : [];
        return this.reply(state, { memory });
      }
      case 'stack': {
        const result = await inspect('-stack-list-frames 0 19');
        return this.reply(state, {
          stack: Array.isArray(result.stack) ? result.stack.map((entry) => frame(fields(entry))) : [],
        });
      }
      case 'locals': {
        const result = await inspect('-stack-list-variables --simple-values');
        const variables = Array.isArray(result.variables)
          ? result.variables.slice(0, 100).map((entry) => {
              const data = fields(entry);
              return { name: textField(data.name) ?? '', value: textField(data.value), type: textField(data.type) };
            })
          : [];
        return this.reply(state, { variables });
      }
      default:
        throw new Error('gdb.invalidInput');
    }
  }

  private finish(state: State): Promise<void> {
    if (state.finishing) return state.finishing;
    state.stopping = true;
    state.snapshot.state = 'stopping';
    state.snapshot.revision++;
    // Defer until initialization is assigned; close first to unblock pending MI setup.
    state.finishing = Promise.resolve().then(async () => {
      await state.connection?.close();
      await state.initialization;
      await state.connection?.close();
      await state.outputChannel?.close();
      state.target?.release();
      state.target = undefined;
      state.snapshot.state = state.snapshot.error ? 'failed' : 'exited';
      state.snapshot.frame = undefined;
      state.snapshot.revision++;
    });
    return state.finishing;
  }

  /** Application shutdown stops the owned process before the build service is disposed. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.current && !terminal(this.current.snapshot.state)) await this.finish(this.current);
  }
}
