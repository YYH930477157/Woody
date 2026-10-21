import { createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInferiorOutput, type InferiorOutput } from '@/process/services/cmake/gdb/inferiorOutput';

describe.skipIf(process.platform !== 'win32')('Windows inferior output isolation', () => {
  let channel: InferiorOutput;
  let client: Socket;
  afterEach(async () => {
    client?.destroy();
    await channel?.close();
  });
  it('delivers MI-looking target text literally and preserves split UTF-8', async () => {
    let text = '';
    channel = await createInferiorOutput((part) => {
      text += part;
    });
    client = createConnection(channel.terminal);
    await once(client, 'connect');
    client.write('*[hello\npartial');
    client.write(Buffer.from([0xe4, 0xb8]));
    client.write(Buffer.from([0xad]));
    await vi.waitFor(() => expect(text).toBe('*[hello\npartial中'));
  });
  it('closes active sockets and does not leave the pipe listening', async () => {
    channel = await createInferiorOutput(() => undefined);
    client = createConnection(channel.terminal);
    await once(client, 'connect');
    const closed = once(client, 'close');
    await channel.close();
    await closed;
    client = createConnection(channel.terminal);
    const [error] = await once(client, 'error');
    expect((error as Error).message).toMatch(/ENOENT|ECONNREFUSED/);
  });
  it('closes a channel with no inferior and allows repeated cleanup', async () => {
    channel = await createInferiorOutput(() => undefined);
    await expect(channel.close()).resolves.toBeUndefined();
    await expect(channel.close()).resolves.toBeUndefined();
  });
});
