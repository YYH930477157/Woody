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

type PresentedEmail = {
  message_id: string;
  my_role: string;
  to?: string;
  automated?: boolean;
  thread_todo?: { id: string; title: string };
  latest_message: string;
  quoted_history?: string;
};

const ME = { name: '李国强', address: 'lgq@corp.com' };
const ZHANG = { name: '张三', address: 'zs@corp.com' };

function writeMailbox(emails: Array<Record<string, unknown>>): void {
  fs.writeFileSync(
    path.join(todoDir, 'emails.json'),
    JSON.stringify({
      fetched_at: Date.now(),
      source: 'test',
      mailbox: { names: [ME.name], addresses: ['/o=Corp/cn=Recipients/cn=lgq', ME.address] },
      emails: emails.map((email) => ({ subject: 'Subject', received_at: 1_700_000_000_000, ...email })),
    })
  );
}

function readStoreFile(): {
  todos: Array<{ id: string; email_ref?: { thread_id?: string; subject?: string } }>;
  skipped_emails?: Array<Record<string, unknown>>;
} {
  return JSON.parse(fs.readFileSync(path.join(todoDir, 'todo.json'), 'utf8'));
}

async function readBatch(): Promise<{ header: string; emails: Map<string, PresentedEmail> }> {
  const text = await callTool('email_snapshot_read');
  const start = text.indexOf('\n[');
  const emails = JSON.parse(text.slice(start + 1)) as PresentedEmail[];
  return { header: text.slice(0, start), emails: new Map(emails.map((email) => [email.message_id, email])) };
}

describe('bundled Todo MCP email ownership', () => {
  it("states the user's role in each email", async () => {
    writeMailbox([
      { message_id: 'to-me', from_name: '王经理', to: [ME], cc: [] },
      { message_id: 'cc-me', from_name: '王经理', to: [ZHANG], cc: [ME] },
      { message_id: 'exchange', from_name: '王经理', to: [{ name: '', address: '/O=Corp/cn=Recipients/cn=lgq' }] },
      { message_id: 'via-list', from_name: '王经理', to: [{ name: 'All Staff', address: 'all@corp.com' }], cc: [] },
      { message_id: 'sent', from_name: ME.name, from_address: ME.address, to: [ZHANG], cc: [] },
      { message_id: 'note-to-self', from_name: ME.name, from_address: ME.address, to: [ME], cc: [] },
      { message_id: 'old-export', from_name: '王经理' },
    ]);

    const { header, emails } = await readBatch();

    expect(header).toContain('Mailbox owner ("me"): 李国强, lgq@corp.com');
    expect(Object.fromEntries([...emails].map(([id, email]) => [id, email.my_role]))).toEqual({
      'to-me': 'to',
      'cc-me': 'cc',
      exchange: 'to',
      'via-list': 'not_listed',
      sent: 'sender',
      'note-to-self': 'self',
      'old-export': 'unknown',
    });
    expect(emails.get('cc-me')?.to).toBe('张三');
    expect(emails.get('to-me')?.to).toBe('李国强 (me)');
  });

  it('separates the newest message from the quoted thread', async () => {
    writeMailbox([
      {
        message_id: 'reply',
        to: [ME],
        body_preview:
          '张三，请周五前提交测试报告。\r\n\r\n发件人: 李国强 <lgq@corp.com>\r\n发送时间: 2026年10月18日 10:00\r\n主题: 测试\r\n\r\n请大家确认排期。',
      },
      {
        message_id: 'outlook-en',
        to: [ME],
        body_preview:
          'Please review the draft.\n________________________________\nFrom: Tom\nSent: Monday\nFix the build.',
      },
      { message_id: 'plain', to: [ME], body_preview: 'No history here.' },
    ]);

    const { emails } = await readBatch();

    expect(emails.get('reply')?.latest_message).toBe('张三，请周五前提交测试报告。');
    expect(emails.get('reply')?.quoted_history).toContain('请大家确认排期');
    expect(emails.get('outlook-en')?.latest_message).toBe('Please review the draft.');
    expect(emails.get('outlook-en')?.quoted_history).toContain('Fix the build.');
    expect(emails.get('plain')?.latest_message).toBe('No history here.');
    expect(emails.get('plain')?.quoted_history).toBeUndefined();
  });

  it('flags mailing-list and no-reply mail as automated', async () => {
    writeMailbox([
      { message_id: 'list', to: [ME], list_headers: ['List-Unsubscribe: <mailto:u@news.com>'] },
      { message_id: 'noreply', to: [ME], from_address: 'no-reply@system.com' },
      { message_id: 'person', to: [ME], from_address: 'wang@corp.com', list_headers: ['Auto-Submitted: no'] },
    ]);

    const { emails } = await readBatch();

    expect(emails.get('list')?.automated).toBe(true);
    expect(emails.get('noreply')?.automated).toBe(true);
    expect(emails.get('person')?.automated).toBeUndefined();
  });

  it('logs why emails were skipped and keeps the log through later writes', async () => {
    writeMailbox([
      { message_id: 'theirs', subject: 'RE: 样机反馈', from_name: '王经理', to: [ZHANG], cc: [ME], thread_id: 'T1' },
      { message_id: 'legacy', subject: 'Digest', from_address: 'news@x.com', to: [ME] },
    ]);

    const marked = JSON.parse(
      await callTool('email_mark_skipped', {
        emails: [{ message_id: 'theirs', reason: 'not_mine', owner: '张三', note: '王经理让张三整理' }],
        message_ids: ['legacy'],
      })
    );
    await callTool('todo_create', { title: 'Unrelated' });

    expect(marked).toEqual({ marked: 2, already_processed: 0, unknown: [] });
    expect(readStoreFile().skipped_emails).toEqual([
      expect.objectContaining({
        message_id: 'theirs',
        subject: 'RE: 样机反馈',
        from: '王经理',
        thread_id: 'T1',
        reason: 'not_mine',
        owner: '张三',
        note: '王经理让张三整理',
        by: 'scan',
      }),
      expect.objectContaining({ message_id: 'legacy', from: 'news@x.com', reason: 'other' }),
    ]);
  });

  it('links later mail of a thread to the todo already made from it', async () => {
    writeMailbox([{ message_id: 'first', subject: '评审方案', from_name: '王经理', to: [ME], thread_id: 'T9' }]);
    const created = JSON.parse(
      await callTool('todo_create', { title: '评审方案', email_ref: { message_id: 'first' } })
    );
    writeMailbox([
      { message_id: 'reply', subject: 'RE: 评审方案', to: [ME], thread_id: 'T9' },
      { message_id: 'other', subject: '别的事', to: [ME], thread_id: 'T2' },
    ]);

    const { emails } = await readBatch();

    expect(readStoreFile().todos[0].email_ref).toMatchObject({ subject: '评审方案', thread_id: 'T9' });
    expect(emails.get('reply')?.thread_todo).toMatchObject({ id: created.todo.id, title: '评审方案' });
    expect(emails.get('other')?.thread_todo).toBeUndefined();
  });

  it("shows the user's corrections to later scans, newest first", async () => {
    fs.writeFileSync(
      path.join(todoDir, 'todo.json'),
      JSON.stringify({
        version: 1,
        todos: [],
        processed_message_ids: [],
        scan_feedback: [
          { verdict: 'not_mine', subject: '周报汇总', from: '王经理', owner: '张三', at: 1 },
          { verdict: 'mine', subject: '审批单', from: 'OA', at: 2 },
        ],
      })
    );
    writeMailbox([{ message_id: 'm1', to: [ME] }]);

    const { header } = await readBatch();

    expect(header).toContain(`NOT the user's todo: "周报汇总" from 王经理 (it is 张三's)`);
    expect(header).toContain(`IS the user's todo (an earlier scan skipped it): "审批单" from OA`);
    expect(header.indexOf('审批单')).toBeLessThan(header.indexOf('周报汇总'));
  });
});
