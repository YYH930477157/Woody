import { afterEach, describe, expect, it, vi } from 'vitest';
import { GdbService, type DebugTarget } from '@/process/services/cmake/gdb/gdbService';
import type { GdbEvents, MiConnection } from '@/process/services/cmake/gdb/transport';
import type { MiFields } from '@/process/services/cmake/gdb/protocol';

describe('shared GDB session', () => {
  let service: GdbService;
  afterEach(async () => {
    await service?.dispose();
  });
  function setup() {
    let events: GdbEvents;
    const release = vi.fn();
    const target: DebugTarget = {
      projectPath: '/meter',
      buildDirectory: '/meter/build',
      executable: '/meter/build/meter.exe',
      args: [],
      gdbPath: '/gdb',
      env: {},
      release,
    };
    const connection: MiConnection = {
      command: vi.fn(async (command: string): Promise<MiFields> => {
        if (command.startsWith('-break-insert')) return { bkpt: { number: '1', line: '12' } };
        if (command === '-exec-run')
          events.onRecord({
            kind: '*',
            class: 'stopped',
            data: { reason: 'breakpoint-hit', frame: { func: 'main', line: '12' } },
          });
        if (command === '-exec-continue') events.onRecord({ kind: '*', class: 'running', data: {} });
        if (command.startsWith('-data-evaluate-expression')) return { value: '42' };
        return {};
      }),
      close: vi.fn(async () => {
        events.onExit();
      }),
    };
    const acquire = vi.fn(async () => target);
    service = new GdbService(
      acquire,
      (_launch, handlers) => {
        events = handlers;
        return connection;
      },
      async (root) => root
    );
    return {
      acquire,
      connection,
      release,
      emit: (data: MiFields, klass = 'stopped') => events.onRecord({ kind: '*', class: klass, data }),
    };
  }
  async function ready() {
    const { session } = await service.request({ projectPath: '/meter', operation: 'start' });
    await vi.waitFor(async () =>
      expect((await service.request({ projectPath: '/meter', operation: 'status' })).session?.state).toBe('stopped')
    );
    return { projectPath: '/meter', sessionId: session!.id };
  }
  it('does not launch anything for status and rejects parallel starts', async () => {
    const { acquire } = setup();
    expect(await service.request({ projectPath: '/meter', operation: 'status' })).toEqual({});
    expect(acquire).not.toHaveBeenCalled();
    await ready();
    await expect(service.request({ projectPath: '/other', operation: 'start' })).rejects.toThrow('gdb.busy');
  });
  it('reads a variable at a stop and rejects reads while running', async () => {
    setup();
    const input = await ready();
    expect((await service.request({ ...input, operation: 'evaluate', expression: 'meter.status' })).value).toBe('42');
    await service.request({ ...input, operation: 'continue' });
    await expect(service.request({ ...input, operation: 'evaluate', expression: 'meter.status' })).rejects.toThrow(
      'gdb.notStopped'
    );
  });
  it('rejects stale session commands and cross-project access', async () => {
    setup();
    const input = await ready();
    await expect(service.request({ ...input, sessionId: 'old', operation: 'stop' })).rejects.toThrow(
      'gdb.sessionChanged'
    );
    expect(await service.request({ projectPath: '/other', operation: 'status' })).toEqual({});
  });
  it('rejects mutating expressions and oversized memory requests', async () => {
    const { connection } = setup();
    const input = await ready();
    await expect(service.request({ ...input, operation: 'evaluate', expression: 'meter.status=0' })).rejects.toThrow();
    await expect(service.request({ ...input, operation: 'memory', address: '0x1234', count: 257 })).rejects.toThrow();
    expect(connection.command).not.toHaveBeenCalledWith(expect.stringContaining('meter.status=0'));
  });
  it('rejects breakpoint address expressions that could mutate the inferior', async () => {
    const { connection } = setup();
    const input = await ready();
    for (const location of ['*(meter.status = 123)', '*foo()', '*(meter.status++)', 'foo if meter.status=5']) {
      await expect(service.request({ ...input, operation: 'breakpointAdd', location })).rejects.toThrow(
        'gdb.invalidInput'
      );
    }
    expect(connection.command).not.toHaveBeenCalledWith(expect.stringContaining('123'));
  });
  it('holds the build lease until the debug tree closes and releases only once', async () => {
    const { release } = setup();
    const input = await ready();
    expect(release).not.toHaveBeenCalled();
    const result = await service.request({ ...input, operation: 'stop' });
    expect(result.session?.state).toBe('exited');
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('debugs with an older GDB that lacks newer print and call settings', async () => {
    const { connection } = setup();
    const respond = vi.mocked(connection.command).getMockImplementation()!;
    vi.mocked(connection.command).mockImplementation(async (command) => {
      if (/may-call-functions|max-depth/.test(command)) throw new Error('Undefined set command');
      return respond(command);
    });
    await ready();
  });
  it('fails the launch when GDB rejects a required setup command', async () => {
    const { connection } = setup();
    const respond = vi.mocked(connection.command).getMockImplementation()!;
    vi.mocked(connection.command).mockImplementation(async (command) => {
      if (command.startsWith('-file-exec-and-symbols')) throw new Error('No symbol table is loaded');
      return respond(command);
    });
    await service.request({ projectPath: '/meter', operation: 'start' });
    await vi.waitFor(async () =>
      expect((await service.request({ projectPath: '/meter', operation: 'status' })).session?.error).toBe(
        'No symbol table is loaded'
      )
    );
  });
  it('cleans up a launch that fails during GDB setup', async () => {
    const { connection, release } = setup();
    vi.mocked(connection.command).mockRejectedValue(new Error('setup failure'));
    await service.request({ projectPath: '/meter', operation: 'start' });
    await vi.waitFor(async () =>
      expect((await service.request({ projectPath: '/meter', operation: 'status' })).session?.state).toBe('failed')
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('finishes and releases the lease after normal inferior exit', async () => {
    const { emit, release } = setup();
    await ready();
    emit({ reason: 'exited-normally' });
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });
  it('cancels during target acquisition without launching a debugger', async () => {
    const { acquire, connection, release } = setup();
    const target = await acquire();
    let acquired: (target: DebugTarget) => void;
    acquire.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acquired = resolve;
        })
    );
    const started = await service.request({ projectPath: '/meter', operation: 'start' });
    const stopped = service.request({ projectPath: '/meter', sessionId: started.session!.id, operation: 'stop' });
    await vi.waitFor(async () =>
      expect((await service.request({ projectPath: '/meter', operation: 'status' })).session?.state).toBe('stopping')
    );
    acquired!(target);
    await stopped;
    expect(connection.command).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('rejects a late value returned after the session has been stopped', async () => {
    const { connection } = setup();
    const input = await ready();
    let deliver: (data: MiFields) => void;
    vi.mocked(connection.command).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        })
    );
    const pending = service.request({ ...input, operation: 'evaluate', expression: 'meter.status' });
    await vi.waitFor(() => expect(deliver).toBeDefined());
    await service.request({ ...input, operation: 'stop' });
    deliver!({ value: 'old' });
    await expect(pending).rejects.toThrow('gdb.stateChanged');
  });
});
