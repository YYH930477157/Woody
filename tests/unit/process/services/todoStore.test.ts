import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
}));

import { createTodoStoreService, getTodoDir } from '@/process/services/todo/todoStore';

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
