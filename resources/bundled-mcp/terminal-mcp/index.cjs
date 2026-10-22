'use strict';

// Dependency-free stdio MCP. Native devices are held by the desktop process.
const readline = require('node:readline');
const port = Number(process.env.AIONUI_TERMINAL_PORT);
const token = process.env.AIONUI_TERMINAL_TOKEN;
if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) {
  console.error('Woody terminal service is unavailable. Restart Woody.');
  process.exit(1);
}
// The global WebSocket client ships with Node.js 22; the bundled managed runtime is newer.
if (typeof WebSocket !== 'function') {
  console.error(`Woody terminal MCP requires Node.js 22 or newer (running ${process.version}).`);
  process.exit(1);
}
const socket = new WebSocket(`ws://127.0.0.1:${port}/terminal?token=${encodeURIComponent(token)}`);
let nextId = 0;
const pending = new Map();
const ready = new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', () => reject(new Error('Terminal service connection failed')), { once: true });
});
ready.catch(() => {});
socket.addEventListener('message', ({ data }) => {
  try {
    const message = JSON.parse(String(data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  } catch {
    /* Ignore malformed responses; the request timeout remains active. */
  }
});
socket.addEventListener('close', () => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error('Terminal service disconnected'));
  }
  pending.clear();
});
async function request(action, args) {
  await Promise.race([
    ready,
    new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error('Terminal service unavailable')), 5000);
      timeout.unref();
    }),
  ]);
  if (socket.readyState !== WebSocket.OPEN) throw new Error('Terminal service disconnected');
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Terminal request timed out; do not automatically resend device data'));
    }, 185000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ ...args, id, action }));
  });
}

const string = { type: 'string' };
const ticket = {
  type: 'string',
  description:
    'Optional legacy Hand to AI grant, mainly for shell connections. Serial access uses Woody Settings > Tools authorization automatically; never ask the user to supply or invent a ticket.',
};
function tool(action, description, properties, required) {
  return {
    name: `terminal_${action}`,
    description,
    inputSchema: {
      type: 'object',
      properties: { ticket, ...properties },
      required,
      additionalProperties: false,
    },
  };
}
const connection = { connectionId: string };
const tools = [
  tool(
    'claim',
    'Claim an explicit Hand to AI ticket already delivered by Woody. For serial connections use terminal_profiles then terminal_open instead; never ask the user for a ticket.',
    {},
    ['ticket']
  ),
  tool(
    'profiles',
    'List saved serial profiles and their profileId (id field). No ticket required. If empty, ask the user to save a serial configuration in the terminal panel.',
    {},
    []
  ),
  tool('ports', 'Enumerate local serial ports without opening or probing devices. No ticket required.', {}, []),
  tool(
    'list',
    'List serial connection metadata without a ticket. Reading or writing uses the global authorization setting. With an explicit ticket, list only its scoped connection.',
    {},
    []
  ),
  tool(
    'open',
    'Open or reuse a saved serial profile by profileId. Woody asks the user or grants access automatically according to Settings > Tools. Do not ask for a ticket. After approval use the returned connection id for read/send/close. Reusing a port the user already has open only observes it; control moves to the AI on the first send. Shell opening still requires an explicit Hand to AI ticket.',
    { profileId: string },
    []
  ),
  tool(
    'read',
    'Read raw output with an independent byte cursor. Data is base64; inspect lost/more flags. At most 64 KiB per read.',
    {
      ...connection,
      cursor: { type: 'integer', minimum: 0 },
      maxBytes: { type: 'integer', minimum: 1, maximum: 65536 },
    },
    ['connectionId']
  ),
  tool(
    'send',
    'Send explicit HEX or UTF-8 input to the shared connection. Serial accepts arbitrary bytes; Shell requires valid UTF-8 bytes even in HEX mode. No automatic retries. A writePending result means an already issued native write may still complete: inspect outgoing history before resending. Optional serial wait matches only bytes observed after send starts; chunks are not frames.',
    {
      ...connection,
      send: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: string,
          encoding: { type: 'string', enum: ['hex', 'utf8'] },
          ending: { type: 'string', enum: ['none', 'cr', 'lf', 'crlf'] },
          wait: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: ['count', 'pattern', 'idle'] },
              count: { type: 'integer', minimum: 1 },
              pattern: string,
              patternEncoding: { type: 'string', enum: ['hex', 'utf8'] },
              idleMs: { type: 'integer', minimum: 1 },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
            },
            required: ['mode', 'timeoutMs'],
          },
        },
        required: ['data', 'encoding', 'ending'],
      },
    },
    ['connectionId', 'send']
  ),
  tool('cancel', 'Cancel an authorized pending send/wait. Already transmitted bytes are retained.', connection, [
    'connectionId',
  ]),
  tool('interrupt', 'Send Ctrl+C to an authorized interactive shell.', connection, ['connectionId']),
  tool('close', 'Close an authorized connection. Denied after manual takeover.', connection, ['connectionId']),
];
const names = new Set(tools.map((entry) => entry.name));
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let inFlight = 0;
input.on('line', (line) => {
  void (async () => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    try {
      if (message.method === 'initialize') {
        reply({
          protocolVersion: message.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'woody-terminal', version: '1.0.0' },
        });
      } else if (message.method === 'ping') reply({});
      else if (message.method === 'tools/list') reply({ tools });
      else if (message.method === 'tools/call') {
        if (!names.has(message.params?.name)) throw new Error('Unknown terminal tool');
        if (inFlight >= 16) throw new Error('Too many pending terminal operations');
        inFlight++;
        try {
          const result = await request(message.params.name.slice('terminal_'.length), message.params.arguments || {});
          reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
        } finally {
          inFlight--;
        }
      } else {
        process.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) +
            '\n'
        );
      }
    } catch (error) {
      reply({ isError: true, content: [{ type: 'text', text: error.message || String(error) }] });
    }
  })();
});
input.on('close', () => {
  socket.close();
  // Disconnecting the lease revokes access, while user-owned connections stay open.
  const timeout = setTimeout(() => process.exit(0), 200);
  timeout.unref();
});
