import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { z } from 'zod';
import type { CmakeService } from '../cmakeService';
import type { GdbService } from '../gdb/gdbService';
import { gdbRequestSchema } from '../gdb/validation';

const root = z.string().min(1).max(32768);
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('debugProjects') }).strict(),
  z.object({ action: z.literal('debug'), request: gdbRequestSchema }).strict(),
  z.object({ action: z.literal('projects') }).strict(),
  z.object({ action: z.literal('inspect'), projectPath: root }).strict(),
  z
    .object({
      action: z.literal('start'),
      projectPath: root,
      operation: z.enum(['check', 'configure', 'build', 'test', 'run']),
      selection: z.record(z.string().max(256), z.string().max(256)).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('read'),
      jobId: z.string().min(1).max(128),
      cursor: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ action: z.literal('cancel'), jobId: z.string().min(1).max(128) }).strict(),
]);

const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);

/** The desktop panel owns project access. MCP can use saved settings, never rewrite them. */
export async function startCmakeRpc(
  service: Pick<CmakeService, 'inspect' | 'start' | 'read' | 'cancel'>,
  debug?: Pick<GdbService, 'request'>
) {
  const token = randomBytes(32).toString('hex');
  const enabled = new Map<string, string>();
  const debugEnabled = new Map<string, string>();
  let active = 0;
  async function authorize(projectPath: string): Promise<string> {
    const canonical = await realpath(projectPath).catch(() => {
      throw new Error('cmake.aiDisabled');
    });
    if (!enabled.has(key(canonical))) throw new Error('cmake.aiDisabled');
    return canonical;
  }
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    const supplied = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      request.method !== 'POST' ||
      request.url !== '/cmake' ||
      request.headers.origin ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      response.writeHead(403).end(JSON.stringify({ error: 'cmake.unauthorized' }));
      return;
    }
    if (active >= 8) {
      response.writeHead(429).end(JSON.stringify({ error: 'cmake.busy' }));
      return;
    }
    active++;
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk as Uint8Array);
          size += buffer.length;
          if (size > 65536) throw new Error('cmake.requestTooLarge');
          chunks.push(buffer);
        }
        const input = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        let result: unknown;
        switch (input.action) {
          case 'debugProjects':
            result = [...debugEnabled.values()];
            break;
          case 'debug': {
            const canonical = await realpath(input.request.projectPath).catch(() => {
              throw new Error('gdb.aiDisabled');
            });
            if (!debug || !debugEnabled.has(key(canonical))) throw new Error('gdb.aiDisabled');
            const reply = await debug.request({ ...input.request, projectPath: canonical });
            if (!debugEnabled.has(key(canonical))) {
              if (input.request.operation === 'start' && reply.session)
                await debug.request({ operation: 'stop', projectPath: canonical, sessionId: reply.session.id });
              throw new Error('gdb.aiDisabled');
            }
            result = reply;
            break;
          }
          case 'projects':
            result = [...enabled.values()];
            break;
          case 'inspect':
            result = await service.inspect(await authorize(input.projectPath));
            break;
          case 'start': {
            const canonical = await authorize(input.projectPath);
            const job = await service.start(canonical, input.operation, input.selection);
            if (!enabled.has(key(canonical))) {
              await service.cancel(job.id);
              throw new Error('cmake.aiDisabled');
            }
            result = job;
            break;
          }
          case 'read': {
            const read = service.read(input.jobId, input.cursor);
            await authorize(read.job.projectPath);
            result = read;
            break;
          }
          case 'cancel':
            await authorize(service.read(input.jobId).job.projectPath);
            await service.cancel(input.jobId);
            result = null;
            break;
        }
        response.end(JSON.stringify({ result }));
      } catch (error) {
        response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : 'cmake.failed' }));
      } finally {
        active--;
      }
    })();
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 30000;
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('cmake.failed'));
      resolve(address.port);
    });
  });
  return {
    port,
    token,
    async setDebugEnabled(projectPath: string, value: boolean): Promise<void> {
      const canonical = await realpath(projectPath);
      if (value) {
        await service.inspect(canonical);
        debugEnabled.set(key(canonical), canonical);
      } else debugEnabled.delete(key(canonical));
    },
    async isDebugEnabled(projectPath: string): Promise<boolean> {
      return debugEnabled.has(key(await realpath(projectPath)));
    },
    async setEnabled(projectPath: string, value: boolean): Promise<void> {
      const canonical = await realpath(projectPath);
      if (value) {
        await service.inspect(canonical);
        enabled.set(key(canonical), canonical);
      } else enabled.delete(key(canonical));
    },
    async isEnabled(projectPath: string): Promise<boolean> {
      return enabled.has(key(await realpath(projectPath)));
    },
    async close(): Promise<void> {
      enabled.clear();
      debugEnabled.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
