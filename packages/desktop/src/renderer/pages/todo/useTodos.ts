/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import { Message } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import dayjs from 'dayjs';
import { ipcBridge } from '@/common';
import type { ITodoItem, ITodoSubtask, TodoStatusInfo } from '@/common/types/todo/todoTypes';

const BACKGROUND_REFRESH_MS = 15_000;

export type TodoDraft = {
  title: string;
  notes: string;
  due_at: number | null;
  requester: string;
  /** Omitted when editing a finished todo, so saving does not reopen it. */
  status?: 'pending' | 'waiting';
};

/** Todo data plus optimistic actions; the email scan writes todo.json in the background, so it re-reads on focus. */
export function useTodos(enabled: boolean) {
  const { t } = useTranslation();
  const [todos, setTodos] = useState<ITodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanInfo, setScanInfo] = useState<TodoStatusInfo | null>(null);
  const [scanning, setScanning] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [list, info] = await Promise.all([
        ipcBridge.todo.list.invoke(),
        ipcBridge.todo.status.invoke().catch((): TodoStatusInfo | null => null),
      ]);
      setTodos(list || []);
      setScanInfo(info);
    } catch (error) {
      console.error('[TodoPage] failed to load todos:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refresh();
    const onFocus = (): void => {
      void refresh();
    };
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, BACKGROUND_REFRESH_MS);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, refresh]);

  /** Apply the change locally first; frequent actions such as ticking should not wait for IPC. */
  const optimistic = useCallback(
    async (id: string, patch: (item: ITodoItem) => ITodoItem, request: () => Promise<unknown>) => {
      setTodos((items) => items.map((item) => (item.id === id ? patch(item) : item)));
      try {
        await request();
      } catch {
        Message.error(t('todo.opFailed'));
        void refresh();
      }
    },
    [refresh, t]
  );

  const setDone = useCallback(
    (item: ITodoItem, done: boolean) =>
      optimistic(
        item.id,
        (current) => ({ ...current, status: done ? 'done' : 'pending', completed_at: done ? Date.now() : null }),
        () => ipcBridge.todo.setDone.invoke({ id: item.id, done })
      ),
    [optimistic]
  );

  const setStatus = useCallback(
    (item: ITodoItem, status: ITodoItem['status']) => {
      if (status === 'done') return setDone(item, true);
      return optimistic(
        item.id,
        (current) => ({ ...current, status, completed_at: null }),
        () => ipcBridge.todo.update.invoke({ id: item.id, status })
      );
    },
    [optimistic, setDone]
  );

  /** Waiting → active; an overdue or unscheduled deadline moves to today so it shows up in focus. */
  const unblock = useCallback(
    (item: ITodoItem) => {
      const today = dayjs().startOf('day').valueOf();
      const due_at = item.due_at && item.due_at >= today ? item.due_at : today;
      return optimistic(
        item.id,
        (current) => ({ ...current, status: 'pending', due_at, blocked_reason: undefined }),
        () => ipcBridge.todo.update.invoke({ id: item.id, status: 'pending', due_at, blocked_reason: '' })
      );
    },
    [optimistic]
  );

  /** Steps are written as a whole list. */
  const setSubtasks = useCallback(
    (item: ITodoItem, subtasks: ITodoSubtask[]) =>
      optimistic(
        item.id,
        (current) => ({ ...current, subtasks }),
        () => ipcBridge.todo.update.invoke({ id: item.id, subtasks })
      ),
    [optimistic]
  );

  const remove = useCallback(
    async (item: ITodoItem) => {
      try {
        await ipcBridge.todo.remove.invoke({ id: item.id });
        setTodos((items) => items.filter((current) => current.id !== item.id));
        return true;
      } catch {
        Message.error(t('todo.opFailed'));
        return false;
      }
    },
    [t]
  );

  /** Create or update; failures are reported here and leave the caller's form open for a retry. */
  const save = useCallback(
    async (draft: TodoDraft, existing?: ITodoItem | null): Promise<{ ok: boolean; item?: ITodoItem }> => {
      try {
        const saved = existing
          ? await ipcBridge.todo.update.invoke({ id: existing.id, ...draft })
          : await ipcBridge.todo.create.invoke(draft);
        await refresh();
        return { ok: true, ...(saved ? { item: saved } : {}) };
      } catch {
        Message.error(t('todo.opFailed'));
        return { ok: false };
      }
    },
    [refresh, t]
  );

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await ipcBridge.todo.scanNow.invoke();
      if (result?.ok) Message.success(t('todo.scan.started', { count: result.emails_fetched ?? 0 }));
      else if (result?.message === 'no_scan_job')
        Message.warning(t('todo.scan.noJob', { count: result.emails_fetched ?? 0 }));
      else if (result?.message === 'scan_in_progress') Message.info(t('todo.scan.inProgress'));
      else Message.warning(result?.message || t('todo.scan.failed'));
    } catch {
      Message.error(t('todo.scan.failed'));
    } finally {
      setScanning(false);
      void refresh();
    }
  }, [refresh, t]);

  return { todos, loading, scanInfo, scanning, refresh, setDone, setStatus, unblock, setSubtasks, remove, save, scan };
}
