import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

export type InferiorOutput = { terminal: string; close: () => Promise<void> };

/** Native Windows GDB otherwise interleaves unframed target stdout with its MI records. */
export async function createInferiorOutput(emit: (text: string) => void): Promise<InferiorOutput> {
  const terminal = `\\\\.\\pipe\\woody-gdb-${randomUUID()}`;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const decoder = new StringDecoder('utf8');
    socket.on('data', (data: Buffer) => emit(decoder.write(data)));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      sockets.delete(socket);
      const tail = decoder.end();
      if (tail) emit(tail);
    });
  });
  server.maxConnections = 1;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(terminal, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  let closing: Promise<void> | undefined;
  return {
    terminal,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}
