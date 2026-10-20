import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalConnectionService } from '../../../packages/desktop/src/process/services/terminal/connectionService';
import { startTerminalRpc } from '../../../packages/desktop/src/process/services/terminal/terminalRpc';
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
  async function setup() {
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
    const rpc = await startTerminalRpc(service, async () => [{ path: 'COM61' }]);
    cleanups.push(async () => {
      await rpc.close();
      await service.dispose();
    });
    const mcp = client(rpc.port, rpc.token);
    children.push(mcp.process);
    return { service, rpc, mcp, sent };
  }
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
    expect((result.tools as unknown[]).length).toBe(9);
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
