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
});
