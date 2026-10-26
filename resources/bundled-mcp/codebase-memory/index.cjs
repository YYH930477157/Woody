#!/usr/bin/env node
'use strict';
const path = require('node:path');
const os = require('node:os');
const { createRuntime } = require('./runtime.cjs');
// Curated v0.12.1 upstream schemas; see bundled THIRD_PARTY_NOTICES.
const tools = require('./tools.json');
const repo = process.env.WOODY_CBM_REPO || '';
const runtime = createRuntime({
  binaryPath: process.env.WOODY_CBM_BINARY || path.join(__dirname, 'bin', 'win32-x64', 'codebase-memory-mcp.exe'),
  adapterPath: __filename,
  cacheRoot:
    process.env.WOODY_CBM_CACHE_ROOT ||
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'Woody', 'codebase-memory'),
});
const pending = new Set();
function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}
async function handle(request) {
  if (!request || request.jsonrpc !== '2.0')
    return send({ id: request?.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request' } });
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'woody-codebase-memory', version: '1.0.0' },
        instructions:
          'Tools are bound to one enabled project. Start with index_status; project names and filesystem roots are supplied by Woody.',
      };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = { tools };
      break;
    case 'tools/call':
      try {
        result = await runtime.callTool(repo, request.params?.name, request.params?.arguments || {});
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: error.message }] };
      }
      break;
    default:
      return send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
  }
  send({ id: request.id, result });
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  if (buffer.length > 1024 * 1024) {
    process.stderr.write('MCP input exceeds 1 MiB\n');
    runtime.dispose();
    process.exitCode = 1;
    process.stdin.destroy();
    return;
  }
  for (let newline; (newline = buffer.indexOf('\n')) !== -1; ) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    const operation = handle(request).catch((error) =>
      send({ id: request.id ?? null, error: { code: -32603, message: error.message } })
    );
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  }
});
process.stdin.on('end', () => {
  runtime.dispose();
});
process.on('SIGTERM', () => {
  runtime.dispose();
  process.stdin.destroy();
});
process.on('SIGINT', () => {
  runtime.dispose();
  process.stdin.destroy();
});
process.on('exit', () => runtime.dispose());
