/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Todo IPC bridge — renderer-facing handlers backed by the file store.
 *
 * scanNow runs the two-phase pipeline: (1) refresh the email snapshot via the
 * source adapter (Outlook v1), (2) trigger the email-scan cron job so an
 * agent turn does the LLM extraction. The cron job itself is created in
 * runBackendMigrations (see TODO_SCAN_JOB_NAME there).
 */

import { ipcBridge } from '@/common';
import { httpRequest } from '@/common/adapter/httpBridge';
import { fetchEmailSnapshot, resolveEmailScriptPath } from '@process/services/todo/emailSource';
import { createTodoStoreService, getTodoSnapshotPath } from '@process/services/todo/todoStore';
import fs from 'fs';
import type { ICronJob } from '@/common/adapter/ipcBridge';

export const TODO_SCAN_JOB_NAME = 'Todo email scan';

export function initTodoBridge(): void {
  const store = createTodoStoreService();

  ipcBridge.todo.list.provider(() => store.list());

  ipcBridge.todo.create.provider(({ title, notes, due_at }) =>
    store.create({ title, notes, due_at, source: 'manual' })
  );

  ipcBridge.todo.update.provider(({ id, title, notes, due_at }) => store.update({ id, title, notes, due_at }));

  ipcBridge.todo.setDone.provider(({ id, done }) => store.setDone({ id, done }));

  ipcBridge.todo.remove.provider(({ id }) => store.remove({ id }));

  ipcBridge.todo.scanNow.provider(async () => {
    // 快照先行:即使 agent 执行失败,邮件也已在快照里,下次扫描仍能消化。
    // Snapshot first: even if the agent turn fails, the emails are captured
    // and the next scan still processes them.
    const fetch = await fetchEmailSnapshot();
    await store.withLock((data) => {
      data.last_scan_at = Date.now();
      data.last_scan_status = fetch.ok ? 'snapshot-ok' : `snapshot-failed: ${fetch.message}`;
    });

    if (!fetch.ok) {
      return { ok: false, message: fetch.message, emails_fetched: 0 };
    }

    try {
      const jobs = (await httpRequest<ICronJob[]>('GET', '/api/cron/jobs')) || [];
      const scanJob = jobs.find((job) => job.name === TODO_SCAN_JOB_NAME);
      if (!scanJob) {
        // 结构化代码而非拼接文案:渲染层按 i18n 本地化展示。
        // A structured code, not prose: the renderer localizes it via i18n.
        return { ok: false, message: 'no_scan_job', emails_fetched: fetch.emails };
      }
      await httpRequest('POST', `/api/cron/jobs/${scanJob.id}/run`);
      return { ok: true, message: 'scan started', emails_fetched: fetch.emails };
    } catch (error) {
      return {
        ok: false,
        message: `agent scan failed to start: ${error instanceof Error ? error.message : String(error)}`,
        emails_fetched: fetch.emails,
      };
    }
  });

  ipcBridge.todo.status.provider(async () => {
    const data = store.readStore();
    const scriptReady = fs.existsSync(resolveEmailScriptPath());
    let snapshotFresh = false;
    try {
      const raw = JSON.parse(fs.readFileSync(getTodoSnapshotPath(), 'utf8')) as { fetched_at?: number };
      snapshotFresh = Date.now() - (raw.fetched_at || 0) < 7 * 24 * 60 * 60 * 1000;
    } catch {
      /* no snapshot yet */
    }
    return {
      last_scan_at: data.last_scan_at ?? null,
      last_scan_status: data.last_scan_status ?? null,
      source_ready: scriptReady && snapshotFresh,
      source_message: scriptReady ? (snapshotFresh ? 'outlook' : 'outlook (no snapshot yet)') : 'email source script missing',
    };
  });
}
