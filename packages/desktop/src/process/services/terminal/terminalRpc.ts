import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { TerminalConnectionService } from './connectionService';
import type { TerminalSendRequest } from '@/common/types/terminal';
import type { TerminalSerialAccess } from './serialAccess';

export const terminalSendSchema = z
  .object({
    data: z.string().max(196608),
    encoding: z.enum(['hex', 'utf8']),
    ending: z.enum(['none', 'cr', 'lf', 'crlf']),
    slow: z.boolean().optional(),
    wait: z
      .object({
        mode: z.enum(['count', 'pattern', 'idle']),
        count: z
          .number()
          .int()
          .positive()
          .max(4 * 1024 * 1024)
          .optional(),
        pattern: z.string().max(65536).optional(),
        patternEncoding: z.enum(['hex', 'utf8']).optional(),
        idleMs: z.number().int().positive().max(120000).optional(),
        timeoutMs: z.number().int().positive().max(120000),
      })
      .strict()
      .optional(),
  })
  .strict();

const requestSchema = z
  .object({
    id: z.number().int().nonnegative(),
    action: z.enum(['claim', 'profiles', 'ports', 'list', 'open', 'read', 'send', 'cancel', 'interrupt', 'close']),
    ticket: z.string().min(20).max(256).optional(),
    profileId: z.string().min(1).max(128).optional(),
    connectionId: z.string().max(128).optional(),
    cursor: z.number().int().nonnegative().optional(),
    maxBytes: z.number().int().positive().max(65536).optional(),
    send: terminalSendSchema.optional(),
  })
  .strict();

// Each code unit in `data` or `pattern` may become a six-byte \uXXXX escape, so the schema maximum
// (192 KiB + 64 KiB) can serialize to roughly 1.5 MiB. Leave room for the envelope and future fields.
const MAX_TERMINAL_FRAME_BYTES = 2 * 1024 * 1024;

/** Private socket credentials authorize transport; serial policy or explicit grants scope device access. */
export async function startTerminalRpc(
  service: TerminalConnectionService,
  ports: () => Promise<Array<{ path: string; manufacturer?: string }>>,
  access?: TerminalSerialAccess
): Promise<{ port: number; token: string; close: () => Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  const server = createServer((_request, response) => response.writeHead(404).end());
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_TERMINAL_FRAME_BYTES });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const candidate = url.searchParams.get('token') || '';
    const supplied = Buffer.from(candidate);
    const expected = Buffer.from(token);
    const authorized = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    if (url.pathname !== '/terminal' || request.headers.origin || !authorized) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      const leaseId = randomUUID();
      const lease = new AbortController();
      let active = 0;
      let alive = true;
      const heartbeat = setInterval(() => {
        if (!alive) return client.terminate();
        alive = false;
        client.ping();
      }, 15000);
      heartbeat.unref();
      client.on('pong', () => {
        alive = true;
      });
      client.on('error', () => client.terminate());
      client.once('close', () => {
        clearInterval(heartbeat);
        lease.abort();
        access?.release(leaseId);
        service.revokeLease(leaseId);
      });
      client.on('message', (raw) => {
        void (async () => {
          let id = 0;
          try {
            const input: unknown = JSON.parse(raw.toString());
            id = z.object({ id: z.number().int().nonnegative() }).parse(input).id;
            if (active >= 16) throw new Error('terminal.busy');
            const request = requestSchema.parse(input);
            active++;
            try {
              const { action, ticket, connectionId } = request;
              let result: unknown;
              if (request.profileId && (action !== 'open' || ticket || connectionId))
                throw new Error('terminal.invalidData');
              if (action === 'claim') {
                if (!ticket) throw new Error('terminal.unauthorized');
                result = service.claim(ticket, leaseId);
              } else if (!ticket && access && ['profiles', 'ports', 'list', 'open'].includes(action)) {
                if (action === 'profiles') result = await access.profiles();
                else if (action === 'ports') result = await ports();
                else if (action === 'list') result = access.list();
                else {
                  if (!request.profileId)
                    throw new Error('Specify a saved serial profileId from terminal_profiles. No ticket is needed.');
                  result = await access.open(leaseId, request.profileId, lease.signal);
                }
              } else {
                const capability = ticket ? service.claim(ticket, leaseId) : undefined;
                const actor = ticket
                  ? { ticket, leaseId }
                  : access && connectionId
                    ? await access.actor(leaseId, connectionId, lease.signal, action !== 'read')
                    : undefined;
                if (!actor) throw new Error('terminal.unauthorized');
                if (action === 'ports') result = await ports();
                else if (action === 'list') result = service.list(actor);
                else if (action === 'open') {
                  if (!capability?.profile) throw new Error('terminal.unauthorized');
                  result = await service.open(capability.profile, actor);
                } else {
                  if (!connectionId) throw new Error('terminal.invalidConnection');
                  switch (action) {
                    case 'read':
                      result = service.read(connectionId, request.cursor, request.maxBytes, actor);
                      break;
                    case 'send':
                      if (!request.send) throw new Error('terminal.invalidData');
                      result = await service.send(connectionId, request.send as TerminalSendRequest, actor);
                      break;
                    case 'cancel':
                      result = service.cancel(connectionId, actor);
                      break;
                    case 'interrupt':
                      result = await service.interrupt(connectionId, actor);
                      break;
                    case 'close':
                      result = await service.close(connectionId, actor);
                      break;
                    default:
                      throw new Error('terminal.invalidData');
                  }
                }
              }
              if (client.readyState === client.OPEN) client.send(JSON.stringify({ id, result: result ?? null }));
            } finally {
              active--;
            }
          } catch (error) {
            if (client.readyState === client.OPEN) {
              client.send(JSON.stringify({ id, error: error instanceof Error ? error.message : 'terminal.failed' }));
            }
          }
        })();
      });
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('terminal.failed'));
      resolve(address.port);
    });
  });
  return {
    port,
    token,
    close: async () => {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
    },
  };
}
