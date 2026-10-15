/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { EmailSnapshot } from '@/common/types/todo/todoTypes';
import { getTodoSnapshotPath } from './todoStore';

/**
 * 邮件源适配器。v1 实现 = Outlook 桌面版(PowerShell + COM 读收件箱)。
 *
 * 读取永远走「快照」而不是直连:适配器把最近邮件导出为 emails.json,
 * 扫描 agent 经 todo MCP 的 email_snapshot_read 工具读快照。这样
 * 邮件访问(可能慢、可能失败)与 LLM 提取(确定快照已就绪)解耦,
 * 也让 IMAP / webmail 等其他源未来可以即插即换。
 *
 * Email source adapter. v1 targets desktop Outlook via PowerShell + COM.
 * Reads always go through a snapshot file (emails.json) that the scan agent
 * consumes through the todo MCP's email_snapshot_read tool, decoupling mail
 * access (slow, fallible) from LLM extraction. Future sources (IMAP,
 * webmail) implement the same interface.
 */

export interface EmailFetchResult {
  ok: boolean;
  message: string;
  emails: number;
}

const POWERSHELL_TIMEOUT_MS = 180_000;

export const resolveEmailScriptPath = (): string => {
  const baseDir = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
  return path.join(baseDir, 'todo-email', 'fetch-outlook.ps1');
};

export const fetchEmailSnapshot = async (options?: { days?: number }): Promise<EmailFetchResult> => {
  const scriptPath = resolveEmailScriptPath();
  const snapshotPath = getTodoSnapshotPath();
  const days = options?.days ?? 3;

  if (!fs.existsSync(scriptPath)) {
    return { ok: false, message: `email source script missing: ${scriptPath}`, emails: 0 };
  }

  // 即使失败也写入带 error 字段的快照,让扫描 agent / UI 能看到失败原因,
  // 而不是静默地什么都不发生。
  // Failures still write an error snapshot so the scan agent and the UI can
  // surface the reason instead of silently doing nothing.
  const writeErrorSnapshot = (message: string): void => {
    const snapshot: EmailSnapshot = { fetched_at: Date.now(), source: 'outlook-com', error: message, emails: [] };
    try {
      fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');
    } catch {
      /* best effort */
    }
  };

  return await new Promise<EmailFetchResult>((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-OutFile',
        snapshotPath,
        '-Days',
        String(days),
      ],
      { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          const message = `outlook fetch failed: ${error.message}`;
          writeErrorSnapshot(message);
          resolve({ ok: false, message, emails: 0 });
          return;
        }
        // 脚本自身在无 Outlook 等情况下也退出 0,成败由快照 JSON 表达。
        // The script also exits 0 without Outlook; success is expressed by the snapshot JSON.
        try {
          const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as EmailSnapshot;
          if (snapshot.error) {
            resolve({ ok: false, message: snapshot.error, emails: 0 });
            return;
          }
          resolve({ ok: true, message: (stdout || '').trim(), emails: snapshot.emails.length });
        } catch (parseError) {
          const message = `snapshot unreadable: ${parseError instanceof Error ? parseError.message : String(parseError)}`;
          writeErrorSnapshot(message);
          resolve({ ok: false, message, emails: 0 });
        }
      }
    );
  });
};
