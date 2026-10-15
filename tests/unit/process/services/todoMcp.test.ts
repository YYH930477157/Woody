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

beforeEach(() => {
  todoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-todo-mcp-test-'));
  child = spawn(process.execPath, [path.resolve('resources/bundled-mcp/todo-mcp/index.js')], {
    env: { ...process.env, AIONUI_TODO_DIR: todoDir },
    windowsHide: true,
  });
  lines = createInterface({ input: child.stdout });
});

afterEach(async () => {
  const exited = once(child, 'exit');
  child.stdin.end();
  await exited;
  lines.close();
  fs.rmSync(todoDir, { recursive: true, force: true });
});

async function request(method: string, params?: unknown): Promise<McpReply> {
  const response = once(lines, 'line');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params })}\n`);
  const [line] = await response;
  return JSON.parse(line as string) as McpReply;
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
