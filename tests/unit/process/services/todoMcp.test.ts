import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type McpReply = {
  result: {
    tools?: { name: string; inputSchema: { properties: { status?: { enum: string[] } } } }[];
    content?: { text: string }[];
    isError?: boolean;
  };
};

let child: ChildProcessWithoutNullStreams;
let lines: Interface;
let todoDir: string;
let requestId = 0;

function startServer(env: NodeJS.ProcessEnv = {}): void {
  child = spawn(process.execPath, [path.resolve('resources/bundled-mcp/todo-mcp/index.js')], {
    env: { ...process.env, AIONUI_TODO_DIR: todoDir, AIONUI_TODO_EMAIL_SCRIPT: '', ...env },
    windowsHide: true,
  });
  lines = createInterface({ input: child.stdout });
}

async function stopServer(): Promise<void> {
  const exited = once(child, 'exit');
  child.stdin.end();
  await exited;
  lines.close();
}

beforeEach(() => {
  todoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-todo-mcp-test-'));
  startServer();
});

afterEach(async () => {
  await stopServer();
  fs.rmSync(todoDir, { recursive: true, force: true });
});

async function request(method: string, params?: unknown): Promise<McpReply> {
  const response = once(lines, 'line');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params })}\n`);
  const [line] = await response;
  return JSON.parse(line as string) as McpReply;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const reply = await request('tools/call', { name, arguments: args });
  return reply.result.content![0].text;
}

function writeSnapshot(emails: Array<{ message_id: string; subject: string }>, fetchedAt = Date.now()): void {
  fs.writeFileSync(
    path.join(todoDir, 'emails.json'),
    JSON.stringify({ fetched_at: fetchedAt, source: 'test', emails })
  );
}

/** Restart the server with a fake Outlook export that records its -Days argument. */
async function restartWithEmailScript(): Promise<string> {
  const marker = path.join(todoDir, 'fetched.marker');
  const script = path.join(todoDir, 'fetch-outlook.ps1');
  fs.writeFileSync(
    script,
    [
      'param([string]$OutFile, [int]$Days)',
      `Set-Content -LiteralPath '${marker}' -Value $Days`,
      '$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
      `$json = '{"fetched_at":' + $now + ',"source":"test","emails":[{"message_id":"new@test","subject":"New"}]}'`,
      '[System.IO.File]::WriteAllText($OutFile, $json)',
    ].join('\r\n')
  );
  await stopServer();
  startServer({ AIONUI_TODO_EMAIL_SCRIPT: script });
  return marker;
}

describe('bundled Todo MCP', () => {
  it('advertises and applies the waiting status filter', async () => {
    const reply = await request('tools/list');
    expect(
      reply.result.tools?.find((tool) => tool.name === 'todo_list')?.inputSchema.properties.status?.enum
    ).toContain('waiting');
    await request('tools/call', { name: 'todo_create', arguments: { title: 'Waiting task', status: 'waiting' } });
    await request('tools/call', { name: 'todo_create', arguments: { title: 'Active task' } });

    const filtered = await request('tools/call', { name: 'todo_list', arguments: { status: 'waiting' } });

    expect(filtered.result.content?.[0].text).toContain('Waiting task');
    expect(filtered.result.content?.[0].text).not.toContain('Active task');
  });

  it('removes the waiting reason from the persisted item when marked pending', async () => {
    const created = await request('tools/call', {
      name: 'todo_create',
      arguments: { title: 'Reply', status: 'waiting', blocked_reason: 'Approval' },
    });
    const { todo } = JSON.parse(created.result.content![0].text) as { todo: { id: string } };

    await request('tools/call', { name: 'todo_complete', arguments: { id: todo.id, done: false } });

    const stored = JSON.parse(fs.readFileSync(path.join(todoDir, 'todo.json'), 'utf8')) as {
      todos: { status: string; completed_at: number | null; blocked_reason?: string }[];
    };
    expect(stored.todos[0]).toMatchObject({ status: 'pending', completed_at: null });
    expect(stored.todos[0].blocked_reason).toBeUndefined();
  });

  it('reports a missing item without creating a todo', async () => {
    const reply = await request('tools/call', { name: 'todo_complete', arguments: { id: 'missing', done: false } });

    expect(JSON.parse(reply.result.content![0].text)).toEqual({ updated: false, reason: 'not found' });
  });
});

describe('bundled Todo MCP email snapshot', () => {
  it('stops returning emails once they are marked skipped', async () => {
    writeSnapshot([
      { message_id: 'm1', subject: 'Newsletter' },
      { message_id: 'm2', subject: 'Report' },
    ]);

    const marked = JSON.parse(await callTool('email_mark_skipped', { message_ids: ['m1', 'm1', 'unknown'] }));
    const text = await callTool('email_snapshot_read');

    expect(marked).toEqual({ marked: 1, already_processed: 0, unknown: ['unknown'] });
    expect(text).toContain('"m2"');
    expect(text).not.toContain('"m1"');
  });

  it('reaches emails beyond the first batch after the batch is handled', async () => {
    writeSnapshot(Array.from({ length: 16 }, (_, index) => ({ message_id: `m${index}`, subject: `S${index}` })));

    const first = await callTool('email_snapshot_read');
    await callTool('email_mark_skipped', { message_ids: Array.from({ length: 15 }, (_, index) => `m${index}`) });
    const second = await callTool('email_snapshot_read');

    expect(first).toContain('1 more unprocessed email(s) remain');
    expect(first).not.toContain('"m15"');
    expect(second).toContain('"m15"');
    expect(second).toContain('No more unprocessed emails');
  });

  it('reads a fresh snapshot without rerunning the email export', async () => {
    const marker = await restartWithEmailScript();
    writeSnapshot([{ message_id: 'm1', subject: 'Fresh' }]);

    const text = await callTool('email_snapshot_read');

    expect(text).toContain('"m1"');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'refreshes a stale snapshot through the email export before reading',
    async () => {
      const marker = await restartWithEmailScript();
      writeSnapshot([{ message_id: 'old', subject: 'Old' }], 0);

      const text = await callTool('email_snapshot_read');

      expect(text).toContain('"new@test"');
      expect(text).not.toContain('"old"');
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe('3');
      const store = JSON.parse(fs.readFileSync(path.join(todoDir, 'todo.json'), 'utf8')) as {
        last_scan_status: string;
      };
      expect(store.last_scan_status).toBe('snapshot-ok');
    },
    60_000
  );
});
