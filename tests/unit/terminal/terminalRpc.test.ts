import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startTerminalRpc } from '../../../packages/desktop/src/process/services/terminal/terminalRpc';

describe('private terminal RPC', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
  });
  it('rejects connections without the runtime secret', async () => {
    const bridge = await startTerminalRpc({} as never, async () => []);
    cleanup.push(bridge.close);
    const rejected = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/terminal?token=wrong`);
      socket.on('unexpected-response', (_req, response) => {
        response.resume();
        socket.terminate();
        resolve(response.statusCode!);
      });
      socket.on('error', () => {});
    });
    expect(rejected).toBe(403);
  });
  it('revokes the socket lease on disconnect without closing manual connections', async () => {
    let revoked = '';
    const bridge = await startTerminalRpc(
      {
        revokeLease: (id: string) => {
          revoked = id;
        },
      } as never,
      async () => []
    );
    cleanup.push(bridge.close);
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/terminal?token=${bridge.token}`);
    await new Promise<void>((resolve) => socket.once('open', resolve));
    socket.close();
    await new Promise<void>((resolve) => socket.once('close', () => setTimeout(resolve, 10)));
    expect(revoked.length).toBeGreaterThan(20);
  });
  it('rejects non-ASCII credentials without an uncaught timing comparison error', async () => {
    const bridge = await startTerminalRpc({} as never, async () => []);
    cleanup.push(bridge.close);
    const rejected = await new Promise<number>((resolve) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${bridge.port}/terminal?token=${encodeURIComponent('中'.repeat(64))}`
      );
      socket.on('unexpected-response', (_req, response) => {
        response.resume();
        socket.terminate();
        resolve(response.statusCode!);
      });
      socket.on('error', () => {});
    });
    expect(rejected).toBe(403);
  });
  it('accepts a schema-valid send whose JSON escaping exceeds one MiB', async () => {
    const sends: Array<{ data: string }> = [];
    const bridge = await startTerminalRpc(
      {
        send: async (_id: string, send: { data: string }) => {
          sends.push(send);
          return { status: 'completed', byteLength: 1 };
        },
        revokeLease: () => undefined,
      } as never,
      async () => [],
      {
        actor: async () => ({ ticket: 'ticket', leaseId: 'lease' }),
        release: () => undefined,
      } as never
    );
    cleanup.push(bridge.close);
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/terminal?token=${bridge.token}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const data = '\u0001'.repeat(196608);
    const pattern = '\u0002'.repeat(65536);
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
      socket.once('error', reject);
      socket.once('close', (code) => reject(new Error(`socket closed early (${code})`)));
      socket.send(
        JSON.stringify({
          id: 1,
          action: 'send',
          connectionId: 'connection',
          send: {
            data,
            encoding: 'utf8',
            ending: 'none',
            wait: { mode: 'pattern', pattern, patternEncoding: 'utf8', timeoutMs: 1000 },
          },
        })
      );
    });
    expect(response).toMatchObject({ id: 1, result: { status: 'completed' } });
    expect(sends).toHaveLength(1);
    expect(sends[0].data).toHaveLength(196608);
  });
});
