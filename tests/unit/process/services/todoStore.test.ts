import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
}));

import { createTodoStoreService, getTodoDbPath, getTodoDir } from '@/process/services/todo/todoStore';
import type { TodoSkippedEmail, TodoStoreData } from '@/common/types/todo/todoTypes';

beforeEach(() => {
  state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-todo-test-'));
  fs.mkdirSync(getTodoDir(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(state.userData, { recursive: true, force: true });
});

describe('Todo status changes', () => {
  it('clears the waiting reason when marking a waiting item pending', async () => {
    const store = createTodoStoreService();
    const item = await store.create({ title: 'Reply', status: 'waiting', blocked_reason: 'Approval' });

    await store.setDone({ id: item.id, done: false });

    expect(store.list()[0]).toMatchObject({ status: 'pending', completed_at: null });
    expect(store.list()[0].blocked_reason).toBeUndefined();
  });

  it.each(['pending', 'waiting'] as const)('clears the completion timestamp when reopening as %s', async (status) => {
    const store = createTodoStoreService();
    const item = await store.create({ title: 'Reply' });
    await store.setDone({ id: item.id, done: true });

    await store.update({ id: item.id, status });

    expect(store.list()[0]).toMatchObject({ status, completed_at: null });
  });

  it('returns null when changing the status of a missing item', async () => {
    const store = createTodoStoreService();

    expect(await store.setDone({ id: 'missing', done: false })).toBeNull();
    expect(store.list()).toEqual([]);
  });
});

const scanSkipped = (overrides: Partial<TodoSkippedEmail> = {}): TodoSkippedEmail => ({
  message_id: 'm1',
  subject: '周报汇总',
  from: '王经理',
  received_at: 1_700_000_000_000,
  thread_id: 'T1',
  reason: 'not_mine',
  owner: '张三',
  by: 'scan',
  at: 1,
  ...overrides,
});

/** What the todo MCP writes to the shared file. */
function writeStoreFile(data: Partial<TodoStoreData>): void {
  fs.writeFileSync(getTodoDbPath(), JSON.stringify({ version: 1, todos: [], processed_message_ids: [], ...data }));
}

const readStoreFile = (): TodoStoreData => JSON.parse(fs.readFileSync(getTodoDbPath(), 'utf8'));

describe('Email scan corrections', () => {
  it('keeps the skipped emails and corrections the todo MCP wrote', async () => {
    writeStoreFile({
      skipped_emails: [scanSkipped()],
      scan_feedback: [{ verdict: 'mine', subject: 'A', from: 'B', at: 1 }],
    });
    const store = createTodoStoreService();

    await store.create({ title: 'Manual' });

    expect(readStoreFile()).toMatchObject({
      skipped_emails: [{ message_id: 'm1' }],
      scan_feedback: [{ verdict: 'mine' }],
    });
  });

  it('moves an email todo that is not the user’s to the skipped list', async () => {
    const store = createTodoStoreService();
    const manual = await store.create({ title: 'Manual' });
    const fromEmail = await store.create({
      title: 'Summarize the report',
      source: 'email',
      email_ref: { message_id: 'm7', subject: '周报汇总', from: '王经理', received_at: 5, thread_id: 'T7' },
    });

    expect(await store.dismissEmailTodo({ id: manual.id })).toBe(false);
    expect(await store.dismissEmailTodo({ id: fromEmail.id })).toBe(true);

    expect(store.list().map((item) => item.id)).toEqual([manual.id]);
    expect(store.skippedEmails()).toEqual([
      expect.objectContaining({
        message_id: 'm7',
        subject: '周报汇总',
        thread_id: 'T7',
        reason: 'not_mine',
        by: 'user',
      }),
    ]);
    expect(readStoreFile().scan_feedback).toEqual([
      expect.objectContaining({ verdict: 'not_mine', subject: '周报汇总', from: '王经理' }),
    ]);
  });

  it('turns an email the scan skipped into a todo and remembers the correction', async () => {
    writeStoreFile({ skipped_emails: [scanSkipped(), scanSkipped({ message_id: 'm2', received_at: 9 })] });
    const store = createTodoStoreService();

    const item = await store.restoreSkippedEmail({ message_id: 'm1', title: 'Summarize the weekly report' });

    expect(item).toMatchObject({
      title: 'Summarize the weekly report',
      source: 'email',
      email_ref: { message_id: 'm1', subject: '周报汇总', from: '王经理', thread_id: 'T1' },
    });
    expect(store.skippedEmails().map((entry) => entry.message_id)).toEqual(['m2']);
    expect(readStoreFile().scan_feedback).toEqual([
      expect.objectContaining({ verdict: 'mine', subject: '周报汇总', from: '王经理' }),
    ]);
    expect(await store.restoreSkippedEmail({ message_id: 'm1', title: 'Again' })).toBeNull();
  });

  it('withdraws the user’s own “not mine” correction when the email is restored', async () => {
    const store = createTodoStoreService();
    const item = await store.create({
      title: 'Summarize the report',
      source: 'email',
      email_ref: { message_id: 'm7', subject: '周报汇总', from: '王经理', received_at: 5 },
    });
    await store.dismissEmailTodo({ id: item.id });

    await store.restoreSkippedEmail({ message_id: 'm7', title: 'Summarize the report' });

    expect(store.list()).toHaveLength(1);
    expect(readStoreFile().scan_feedback).toEqual([]);
  });

  it('keeps only the latest correction when the user changes their mind', async () => {
    writeStoreFile({ skipped_emails: [scanSkipped()] });
    const store = createTodoStoreService();
    const item = await store.restoreSkippedEmail({ message_id: 'm1', title: 'Summarize the weekly report' });

    await store.dismissEmailTodo({ id: item!.id });

    expect(readStoreFile().scan_feedback).toEqual([
      expect.objectContaining({ verdict: 'not_mine', subject: '周报汇总', from: '王经理' }),
    ]);
  });
});
