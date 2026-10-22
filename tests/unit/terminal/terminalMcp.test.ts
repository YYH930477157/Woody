import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalConnectionService } from '../../../packages/desktop/src/process/services/terminal/connectionService';
import { startTerminalRpc } from '../../../packages/desktop/src/process/services/terminal/terminalRpc';
import { TerminalSerialAccess } from '../../../packages/desktop/src/process/services/terminal/serialAccess';
import type { TerminalProfile, TerminalTransport } from '../../../packages/desktop/src/common/types/terminal';

const profile: TerminalProfile = {
  id: 'device',
  name: 'Virtual serial',
  kind: 'serial',
  path: 'COM61',
  baudRate: 9600,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  rtscts: false,
  xon: false,
  xoff: false,
};

function client(port: number, token: string) {
  const process = spawn(globalThis.process.execPath, [path.resolve('resources/bundled-mcp/terminal-mcp/index.cjs')], {
    env: { ...globalThis.process.env, AIONUI_TERMINAL_PORT: String(port), AIONUI_TERMINAL_TOKEN: token },
    stdio: 'pipe',
  });
  let id = 0;
  let buffer = '';
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  process.stdout.on('data', (bytes: Buffer) => {
    buffer += bytes.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline)) as { id: number; result: Record<string, unknown> };
      buffer = buffer.slice(newline + 1);
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    }
  });
  return {
    process,
    call(method: string, params: unknown): Promise<Record<string, unknown>> {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP test response timeout')), 5000);
        pending.set(requestId, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      });
    },
  };
}

describe('bundled terminal MCP with shared desktop connections', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  afterEach(async () => {
    for (const child of children.splice(0)) child.kill();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });
  async function setup(mode: 'ask' | 'auto' = 'ask', confirm = async () => false) {
    const emitter = new EventEmitter();
    const sent: Buffer[] = [];
    const transport: TerminalTransport = {
      onData: (listener) => {
        emitter.on('data', listener);
        return () => {
          emitter.off('data', listener);
        };
      },
      onClose: (listener) => {
        emitter.on('closed', listener);
        return () => {
          emitter.off('closed', listener);
        };
      },
      write: async (bytes) => {
        sent.push(bytes);
        emitter.emit('data', Buffer.from([0x7e, 0xa0]));
        queueMicrotask(() => emitter.emit('data', Buffer.from([0x21, 0x7e])));
        return bytes.length;
      },
      close: async () => {
        emitter.emit('closed');
      },
    };
    const service = new TerminalConnectionService(async () => transport);
    let currentMode = mode;
    const access = new TerminalSerialAccess(
      service,
      {
        list: async () => [profile, { id: 'shell', name: 'Shell', kind: 'shell' }],
        getSerialAccessMode: async () => currentMode,
      },
      confirm
    );
    const rpc = await startTerminalRpc(service, async () => [{ path: 'COM61' }], access);
    cleanups.push(async () => {
      await rpc.close();
      await service.dispose();
    });
    const mcp = client(rpc.port, rpc.token);
    children.push(mcp.process);
    return {
      service,
      rpc,
      mcp,
      sent,
      access,
      setMode: (value: 'ask' | 'auto') => {
        currentMode = value;
        access.invalidate();
      },
    };
  }
  const value = (response: Record<string, unknown>) =>
    JSON.parse((response.content as Array<{ text: string }>)[0].text);
  const failure = (response: Record<string, unknown>) => (response.content as Array<{ text: string }>)[0].text;

  it('opens a saved serial profile and sends without a ticket in automatic mode', async () => {
    const { mcp, sent } = await setup('auto');
    const profiles = value(await mcp.call('tools/call', { name: 'terminal_profiles', arguments: {} }));
    expect(profiles.map((item: TerminalProfile) => item.id)).toEqual(['device']);
    const opened = await mcp.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'device' } });
    expect(opened.isError).not.toBe(true);
    const connection = value(opened);
    const result = await mcp.call('tools/call', {
      name: 'terminal_send',
      arguments: {
        connectionId: connection.id,
        send: { data: 'AA', encoding: 'hex', ending: 'none' },
      },
    });
    expect([result.isError, sent[0]?.toString('hex')]).toEqual([undefined, 'aa']);
  });

  it('does not open a serial port when the global ask prompt is denied', async () => {
    const { mcp, service } = await setup();
    const result = await mcp.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'device' } });
    expect(result.isError).toBe(true);
    expect(service.list()).toEqual([]);
  });

  it('asks once then reuses the granted serial connection for subsequent sends', async () => {
    let asks = 0;
    const { mcp } = await setup('ask', async () => {
      asks++;
      return true;
    });
    const connection = value(
      await mcp.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'device' } })
    );
    for (let i = 0; i < 2; i++) {
      const result = await mcp.call('tools/call', {
        name: 'terminal_send',
        arguments: {
          connectionId: connection.id,
          send: { data: 'AA', encoding: 'hex', ending: 'none' },
        },
      });
      expect(result.isError).not.toBe(true);
    }
    expect(asks).toBe(1);
  });

  it('does not let automatic authorization open shell profiles', async () => {
    const { mcp, service } = await setup('auto');
    const result = await mcp.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'shell' } });
    expect(result.isError).toBe(true);
    expect(service.list()).toEqual([]);
  });

  it('does not regain a manually taken-over port through another MCP client or profile open', async () => {
    const { mcp, service, rpc } = await setup('auto');
    const connection = value(
      await mcp.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'device' } })
    );
    service.takeover(connection.id);
    const other = client(rpc.port, rpc.token);
    children.push(other.process);
    for (const requester of [mcp, other]) {
      const blocked = await requester.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'device' } });
      expect(blocked.isError).toBe(true);
      // A stable code lets the agent tell a policy refusal apart from a transport or device failure.
      expect(failure(blocked)).toContain('terminal.aiAccessBlocked');
    }
    expect(service.list()).toHaveLength(1);
  });

  it('applies the global mode to a new MCP client without another chat ticket', async () => {
    const { mcp, service, rpc } = await setup('auto');
    const connection = value(
      await mcp.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'device' } })
    );
    mcp.process.kill();
    await vi.waitFor(() => expect(service.list()[0].owner).toBe('manual'));
    const other = client(rpc.port, rpc.token);
    children.push(other.process);
    const reused = await other.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'device' } });
    expect(value(reused).id).toBe(connection.id);
  });

  it('lets another AI observe but not take an actively controlled serial port', async () => {
    const { mcp, rpc, service, sent } = await setup('auto');
    const connection = value(
      await mcp.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'device' } })
    );
    const other = client(rpc.port, rpc.token);
    children.push(other.process);
    const attached = await other.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'device' } });
    const takeover = await other.call('tools/call', {
      name: 'terminal_send',
      arguments: { connectionId: connection.id, send: { data: 'AA', encoding: 'hex', ending: 'none' } },
    });
    expect([attached.isError, takeover.isError, sent.length, service.list().length]).toEqual([undefined, true, 0, 1]);
    expect(failure(takeover)).toContain('terminal.accessBusy');
  });

  it('reads a manually used serial port without pausing manual input', async () => {
    const { mcp, service } = await setup('auto');
    const connection = await service.open(profile);
    const read = await mcp.call('tools/call', { name: 'terminal_read', arguments: { connectionId: connection.id } });
    expect([read.isError, service.list()[0].owner]).toEqual([undefined, 'manual']);
    await expect(service.send(connection.id, { data: 'AA', encoding: 'hex', ending: 'none' })).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('takes control on the first AI write after a read without asking twice', async () => {
    let asks = 0;
    const { mcp, service, sent } = await setup('ask', async () => {
      asks++;
      return true;
    });
    const connection = await service.open(profile);
    await mcp.call('tools/call', { name: 'terminal_read', arguments: { connectionId: connection.id } });
    const send = await mcp.call('tools/call', {
      name: 'terminal_send',
      arguments: { connectionId: connection.id, send: { data: 'AA', encoding: 'hex', ending: 'none' } },
    });
    expect([send.isError, asks, service.list()[0].owner, sent.map((bytes) => bytes.toString('hex'))]).toEqual([
      undefined,
      1,
      'ai',
      ['aa'],
    ]);
  });

  it('asks again after switching automatic access back to ask', async () => {
    let asks = 0;
    const { mcp, setMode, sent } = await setup('auto', async () => {
      asks++;
      return false;
    });
    const connection = value(
      await mcp.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'device' } })
    );
    setMode('ask');
    const result = await mcp.call('tools/call', {
      name: 'terminal_send',
      arguments: {
        connectionId: connection.id,
        send: { data: 'AA', encoding: 'hex', ending: 'none' },
      },
    });
    expect([result.isError, asks, sent.length]).toEqual([true, 1, 0]);
  });

  it('cancels a pending authorization when its MCP client disconnects', async () => {
    let finish!: (value: boolean) => void;
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    const { mcp, service } = await setup('ask', confirm);
    // Closing the child discards its response; exercise the socket through a complete request first.
    await mcp.call('tools/list', {});
    mcp.process.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 900,
        method: 'tools/call',
        params: {
          name: 'terminal_open',
          arguments: { profileId: 'device' },
        },
      }) + '\n'
    );
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    mcp.process.kill();
    await once(mcp.process, 'exit');
    finish(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(service.list()).toEqual([]);
  });

  it('does not accept a late approval after the global mode changes', async () => {
    let finish!: (value: boolean) => void;
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    const { mcp, service, setMode } = await setup('ask', confirm);
    const response = mcp.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'device' } });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    setMode('auto');
    finish(true);
    expect((await response).isError).toBe(true);
    expect(service.list()).toEqual([]);
  });

  it('does not expose or read shell connections through implicit serial authorization', async () => {
    const { mcp, service } = await setup('auto');
    const shell = await service.open({ id: 'shell', name: 'Shell', kind: 'shell' });
    expect(value(await mcp.call('tools/call', { name: 'terminal_list', arguments: {} }))).toEqual([]);
    expect(
      (await mcp.call('tools/call', { name: 'terminal_read', arguments: { connectionId: shell.id } })).isError
    ).toBe(true);
  });

  it('retains authorized receive history after takeover and connection close', async () => {
    const { mcp, service } = await setup('auto');
    const connection = value(
      await mcp.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'device' } })
    );
    await mcp.call('tools/call', {
      name: 'terminal_send',
      arguments: {
        connectionId: connection.id,
        send: { data: 'AA', encoding: 'hex', ending: 'none' },
      },
    });
    service.takeover(connection.id);
    await service.close(connection.id);
    const result = await mcp.call('tools/call', { name: 'terminal_read', arguments: { connectionId: connection.id } });
    expect(result.isError).not.toBe(true);
    expect(value(result).events.length).toBeGreaterThan(0);
  });

  it('resumes global serial access after a manual UI action without a ticket or reconnect', async () => {
    const { mcp, service, access } = await setup('auto');
    const connection = value(
      await mcp.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'device' } })
    );
    service.takeover(connection.id);
    access.resume(connection.id);
    const reopened = await mcp.call('tools/call', { name: 'terminal_open', arguments: { profileId: 'device' } });
    expect(reopened.isError).not.toBe(true);
    expect(value(reopened).id).toBe(connection.id);
  });

  it('does not block an authorized connection behind an unrelated approval dialog', async () => {
    const transport: TerminalTransport = {
      write: async (data) => data.length,
      close: async () => {},
      onData: () => () => {},
      onClose: () => () => {},
    };
    const service = new TerminalConnectionService(async () => transport);
    cleanups.push(() => service.dispose());
    let asks = 0;
    const confirm = vi.fn(async () => (++asks === 1 ? true : new Promise<boolean>(() => {})));
    const access = new TerminalSerialAccess(
      service,
      {
        list: async () => [profile],
        getSerialAccessMode: async () => 'ask',
      },
      confirm
    );
    const first = await access.open('one', 'device', new AbortController().signal);
    const second = await service.open({ ...profile, id: 'second', path: 'COM62' } as TerminalProfile);
    const lease = new AbortController();
    const pending = access.actor('two', second.id, lease.signal);
    const cancelled = expect(pending).rejects.toThrow(/cancel/i);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    let available = false;
    const cached = access.actor('one', first.id, new AbortController().signal).then(() => {
      available = true;
    });
    try {
      await vi.waitFor(() => expect(available).toBe(true));
    } finally {
      lease.abort();
      await cancelled;
    }
    await cached;
  });

  it('releases the acquisition queue on cancellation and closes a late native handle', async () => {
    let complete!: (value: TerminalTransport) => void;
    const close = vi.fn(async () => {});
    const transport: TerminalTransport = {
      write: async (data) => data.length,
      close,
      onData: () => () => {},
      onClose: () => () => {},
    };
    const factory = vi.fn(async (item: TerminalProfile) =>
      item.id === 'device'
        ? new Promise<TerminalTransport>((resolve) => {
            complete = resolve;
          })
        : transport
    );
    const service = new TerminalConnectionService(factory);
    cleanups.push(() => service.dispose());
    const second = { ...profile, id: 'second', path: 'COM62' } as TerminalProfile;
    const access = new TerminalSerialAccess(
      service,
      {
        list: async () => [profile, second],
        getSerialAccessMode: async () => 'auto',
      },
      async () => false
    );
    const lease = new AbortController();
    const opening = access.open('first', 'device', lease.signal);
    const cancelled = expect(opening).rejects.toThrow(/cancel/i);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    lease.abort();
    await cancelled;
    await expect(access.open('second', 'second', new AbortController().signal)).resolves.toMatchObject({
      profile: { path: 'COM62' },
    });
    complete(transport);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
  it('exits with a clear message on a runtime without the global WebSocket client', async () => {
    const child = spawn(
      globalThis.process.execPath,
      ['--no-experimental-websocket', path.resolve('resources/bundled-mcp/terminal-mcp/index.cjs')],
      {
        env: { ...globalThis.process.env, AIONUI_TERMINAL_PORT: '1', AIONUI_TERMINAL_TOKEN: 'token' },
        stdio: 'pipe',
      }
    );
    let stderr = '';
    child.stderr.on('data', (bytes: Buffer) => {
      stderr += bytes.toString();
    });
    const [code] = await once(child, 'exit');

    expect(code).toBe(1);
    expect(stderr).toContain('requires Node.js 22 or newer');
  });
  it('initializes offline and exposes the bundled tools', async () => {
    const { mcp } = await setup();
    const result = await mcp.call('tools/list', {});
    expect((result.tools as unknown[]).length).toBe(10);
    expect((await mcp.call('initialize', { protocolVersion: '2024-11-05' })).protocolVersion).toBe('2024-11-05');
  });
  it('uses the same raw receive history for UI and AI across fragmented data', async () => {
    const { service, mcp, sent } = await setup();
    const connection = await service.open(profile);
    const { ticket } = service.grant({ connectionId: connection.id, conversationId: 'selected-chat' });
    const response = await mcp.call('tools/call', {
      name: 'terminal_send',
      arguments: {
        ticket,
        connectionId: connection.id,
        send: {
          data: '7E A0',
          encoding: 'hex',
          ending: 'none',
          wait: { mode: 'pattern', pattern: 'A0 21', patternEncoding: 'hex', timeoutMs: 1000 },
        },
      },
    });
    const result = JSON.parse((response.content as Array<{ text: string }>)[0].text);
    expect([sent[0].toString('hex'), result.status, result.wait.data]).toEqual([
      '7ea0',
      'completed',
      Buffer.from([0x7e, 0xa0, 0x21, 0x7e]).toString('base64'),
    ]);
    expect(
      service
        .read(connection.id)
        .events.filter((event) => event.direction === 'incoming')
        .reduce((sum, event) => sum + event.byteLength, 0)
    ).toBe(4);
  });
  it('denies a copied ticket in another MCP process and stops AI writes after takeover', async () => {
    const { service, mcp, rpc } = await setup();
    const connection = await service.open(profile);
    const { ticket } = service.grant({ connectionId: connection.id, conversationId: 'selected-chat' });
    await mcp.call('tools/call', { name: 'terminal_claim', arguments: { ticket } });
    const other = client(rpc.port, rpc.token);
    children.push(other.process);
    expect((await other.call('tools/call', { name: 'terminal_claim', arguments: { ticket } })).isError).toBe(true);
    service.takeover(connection.id);
    expect(
      (await mcp.call('tools/call', { name: 'terminal_close', arguments: { ticket, connectionId: connection.id } }))
        .isError
    ).toBe(true);
    expect(service.list()[0].status).toBe('open');
  });
  it('returns invalid-input errors immediately with the original request id', async () => {
    const { service, mcp } = await setup();
    const connection = await service.open(profile);
    const { ticket } = service.grant({ connectionId: connection.id, conversationId: 'chat' });
    expect(
      (
        await mcp.call('tools/call', {
          name: 'terminal_read',
          arguments: {
            ticket,
            connectionId: connection.id,
            cursor: -1,
          },
        })
      ).isError
    ).toBe(true);
  });
});
