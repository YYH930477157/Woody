/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { ITodoItem, TodoSkippedEmail, TodoStoreData } from '@/common/types/todo/todoTypes';

/**
 * todo.json 存储:Electron 主进程侧的读写实现。
 *
 * 与 todo MCP 子进程共享同一个文件,两边必须使用同一套并发协议——
 * mkdir 目录锁(创建成功者获得写权,10 秒视为陈旧可强制破除)+
 * 临时文件 rename 原子落盘。单用户桌面应用,争用概率极低,协议只保证
 * 「读-改-写」整体不交错,不追求高吞吐。
 *
 * Shared-file store for todo.json on the Electron main-process side. The todo
 * MCP child writes the same file, so both sides follow one protocol: a mkdir
 * directory lock (stale after 10s) plus tmp-file rename for atomic replace.
 * Single-user desktop app — the protocol only keeps read-modify-write cycles
 * from interleaving; throughput is irrelevant.
 */

const LOCK_STALE_MS = 10_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 3_000;
const LOCK_RETRY_DELAY_MS = 50;
// Keep in sync with the todo MCP (resources/bundled-mcp/todo-mcp/index.js).
const SKIPPED_EMAILS_LIMIT = 300;
const SCAN_FEEDBACK_LIMIT = 30;

export const getTodoDir = (): string => path.join(app.getPath('userData'), 'todo');
export const getTodoDbPath = (): string => path.join(getTodoDir(), 'todo.json');
export const getTodoSnapshotPath = (): string => path.join(getTodoDir(), 'emails.json');

const emptyStore = (): TodoStoreData => ({
  version: 1,
  todos: [],
  processed_message_ids: [],
  last_scan_at: null,
  last_scan_status: null,
  skipped_emails: [],
  scan_feedback: [],
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class TodoFileLock {
  private readonly lockDir: string;

  constructor(private readonly filePath: string) {
    this.lockDir = `${filePath}.lock`;
  }

  async acquire(): Promise<void> {
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    for (;;) {
      try {
        fs.mkdirSync(this.lockDir);
        return;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST') throw err;
        // 陈旧锁(持锁方已死)强制破除:删除后下一轮 mkdir 竞争。
        // Break a stale lock (holder died): remove it and race the next mkdir.
        try {
          const stat = fs.statSync(this.lockDir);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(this.lockDir, { recursive: true, force: true });
          }
        } catch {
          /* stat failed — retry loop handles it */
        }
        if (Date.now() > deadline) {
          throw new Error(`todo store lock timeout: ${this.lockDir}`);
        }
        await sleep(LOCK_RETRY_DELAY_MS);
      }
    }
  }

  release(): void {
    try {
      fs.rmSync(this.lockDir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
}

const readStoreUnlocked = (): TodoStoreData => {
  try {
    const raw = fs.readFileSync(getTodoDbPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<TodoStoreData>;
    if (!parsed || !Array.isArray(parsed.todos)) return emptyStore();
    return {
      version: 1,
      todos: parsed.todos,
      processed_message_ids: Array.isArray(parsed.processed_message_ids) ? parsed.processed_message_ids : [],
      last_scan_at: parsed.last_scan_at ?? null,
      last_scan_status: parsed.last_scan_status ?? null,
      // Also written by the todo MCP: every rewrite here must carry them over.
      skipped_emails: Array.isArray(parsed.skipped_emails) ? parsed.skipped_emails : [],
      scan_feedback: Array.isArray(parsed.scan_feedback) ? parsed.scan_feedback : [],
    };
  } catch {
    return emptyStore();
  }
};

/** 整个读-改-写周期持锁,保证与 MCP 子进程的写入互斥。 */
const withLock = async <T>(mutate: (store: TodoStoreData) => T | Promise<T>): Promise<T> => {
  const lock = new TodoFileLock(getTodoDbPath());
  await lock.acquire();
  try {
    const store = readStoreUnlocked();
    const result = await mutate(store);
    const tmpPath = `${getTodoDbPath()}.tmp`;
    fs.mkdirSync(getTodoDir(), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(store), 'utf8');
    fs.renameSync(tmpPath, getTodoDbPath());
    return result;
  } finally {
    lock.release();
  }
};

const readStore = (): TodoStoreData => {
  try {
    return readStoreUnlocked();
  } catch {
    return emptyStore();
  }
};

const newId = (): string => `todo_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;

const newSubtaskId = (): string => `st_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;

/** 清洗 subtasks 输入(双侧写入方共用同一上限/规则):去空文本、补 id、限量。 */
export const sanitizeSubtasks = (input: unknown): { id: string; text: string; done: boolean }[] | undefined => {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return undefined;
  const cleaned = input
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      id: typeof entry.id === 'string' && entry.id ? entry.id : newSubtaskId(),
      text: String(entry.text ?? '')
        .trim()
        .slice(0, 300),
      done: Boolean(entry.done),
    }))
    .filter((entry) => entry.text)
    .slice(0, 30);
  return cleaned;
};

type TodoDraftInput = {
  title: string;
  notes?: string;
  due_at?: number | null;
  requester?: string;
  status?: 'pending' | 'waiting';
  blocked_reason?: string;
  subtasks?: { id: string; text: string; done: boolean }[];
};

const buildItem = (
  input: TodoDraftInput & { source?: ITodoItem['source']; email_ref?: ITodoItem['email_ref'] }
): ITodoItem => {
  const title = input.title.trim();
  if (!title) throw new Error('title is required');
  const now = Date.now();
  const status = input.status === 'waiting' ? 'waiting' : 'pending';
  return {
    id: newId(),
    title,
    notes: input.notes?.trim() || undefined,
    due_at: input.due_at ?? null,
    status,
    blocked_reason: status === 'waiting' ? input.blocked_reason?.trim() || undefined : undefined,
    requester: input.requester?.trim() || undefined,
    subtasks: sanitizeSubtasks(input.subtasks) ?? undefined,
    completed_at: null,
    source: input.source ?? 'manual',
    email_ref: input.email_ref ?? null,
    created_at: now,
    updated_at: now,
  };
};

const pushCapped = <T>(list: T[], entry: T, limit: number): void => {
  list.push(entry);
  if (list.length > limit) list.splice(0, list.length - limit);
};

type FeedbackMail = { subject: string; from: string };

/** Drop earlier corrections of the same email; the user's latest word on it is the only one kept. */
const withdrawFeedback = (store: TodoStoreData, mail: FeedbackMail): void => {
  store.scan_feedback = (store.scan_feedback ?? []).filter(
    (entry) => !(entry.subject === mail.subject && entry.from === mail.from)
  );
};

const recordFeedback = (store: TodoStoreData, verdict: 'mine' | 'not_mine', mail: FeedbackMail): void => {
  withdrawFeedback(store, mail);
  pushCapped(
    store.scan_feedback!,
    { verdict, subject: mail.subject, from: mail.from, at: Date.now() },
    SCAN_FEEDBACK_LIMIT
  );
};

export const createTodoStoreService = () => ({
  list(): ITodoItem[] {
    return readStore().todos;
  },

  async create(
    input: TodoDraftInput & { source?: ITodoItem['source']; email_ref?: ITodoItem['email_ref'] }
  ): Promise<ITodoItem> {
    const item = buildItem(input);
    await withLock((store) => {
      store.todos.push(item);
    });
    return item;
  },

  /** Emails the scan left out of the todo list, newest first. */
  skippedEmails(): TodoSkippedEmail[] {
    return (readStore().skipped_emails ?? []).toSorted((a, b) => b.received_at - a.received_at);
  },

  /**
   * The user says an email todo is someone else's: the todo goes, its email
   * joins the skipped list, and later scans see the correction.
   */
  async dismissEmailTodo(input: { id: string }): Promise<boolean> {
    return withLock((store) => {
      const item = store.todos.find((todo) => todo.id === input.id);
      const ref = item?.email_ref;
      if (!item || !ref) return false;
      const now = Date.now();
      store.todos = store.todos.filter((todo) => todo.id !== item.id);
      const skipped = (store.skipped_emails ?? []).filter((entry) => entry.message_id !== ref.message_id);
      pushCapped(
        skipped,
        {
          message_id: ref.message_id,
          subject: ref.subject,
          from: ref.from,
          received_at: ref.received_at,
          ...(ref.thread_id ? { thread_id: ref.thread_id } : {}),
          reason: 'not_mine',
          by: 'user',
          at: now,
        },
        SKIPPED_EMAILS_LIMIT
      );
      store.skipped_emails = skipped;
      recordFeedback(store, 'not_mine', ref);
      return true;
    });
  },

  /**
   * Make a todo from a skipped email. Restoring what the scan skipped teaches
   * later scans; restoring what the user dismissed withdraws that correction.
   */
  async restoreSkippedEmail(input: TodoDraftInput & { message_id: string }): Promise<ITodoItem | null> {
    return withLock((store) => {
      const skipped = store.skipped_emails ?? [];
      const entry = skipped.find((current) => current.message_id === input.message_id);
      if (!entry) return null;
      const { message_id: _messageId, ...draft } = input;
      const item = buildItem({
        ...draft,
        source: 'email',
        email_ref: {
          message_id: entry.message_id,
          subject: entry.subject,
          from: entry.from,
          received_at: entry.received_at,
          ...(entry.thread_id ? { thread_id: entry.thread_id } : {}),
        },
      });
      store.todos.push(item);
      store.skipped_emails = skipped.filter((current) => current !== entry);
      // The scan had made it a todo when the user is the one who removed it, so there is nothing to teach.
      if (entry.by === 'user') withdrawFeedback(store, entry);
      else recordFeedback(store, 'mine', entry);
      return item;
    });
  },

  async update(input: {
    id: string;
    title?: string;
    notes?: string;
    due_at?: number | null;
    requester?: string;
    status?: 'pending' | 'waiting';
    blocked_reason?: string | null;
    subtasks?: { id: string; text: string; done: boolean }[];
  }): Promise<ITodoItem | null> {
    return withLock((store) => {
      const item = store.todos.find((todo) => todo.id === input.id);
      if (!item) return null;
      if (input.title !== undefined) item.title = input.title.trim() || item.title;
      if (input.notes !== undefined) item.notes = input.notes.trim() || undefined;
      if (input.due_at !== undefined) item.due_at = input.due_at;
      if (input.requester !== undefined) item.requester = input.requester.trim() || undefined;
      if (input.subtasks !== undefined) item.subtasks = sanitizeSubtasks(input.subtasks) ?? undefined;
      // update 允许 pending ↔ waiting,也允许从 done 重开(清 completed_at);
      // 置为 done 仍须经 setDone(要写完成时间戳)。
      if (input.status === 'waiting' || input.status === 'pending') {
        item.status = input.status;
        item.completed_at = null;
      }
      if (input.blocked_reason !== undefined) {
        item.blocked_reason = input.blocked_reason?.trim() || undefined;
      }
      if (item.status !== 'waiting') item.blocked_reason = undefined;
      item.updated_at = Date.now();
      return { ...item };
    });
  },

  async setDone(input: { id: string; done: boolean }): Promise<ITodoItem | null> {
    return withLock((store) => {
      const item = store.todos.find((todo) => todo.id === input.id);
      if (!item) return null;
      item.status = input.done ? 'done' : 'pending';
      item.completed_at = input.done ? Date.now() : null;
      if (!input.done) item.blocked_reason = undefined;
      item.updated_at = Date.now();
      return { ...item };
    });
  },

  async remove(input: { id: string }): Promise<boolean> {
    return withLock((store) => {
      const before = store.todos.length;
      store.todos = store.todos.filter((todo) => todo.id !== input.id);
      return store.todos.length < before;
    });
  },

  readStore,
  withLock,
});
