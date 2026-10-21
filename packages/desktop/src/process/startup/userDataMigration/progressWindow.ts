/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Runs before Electron is ready, while migration blocks the main thread, so no
// Electron window can paint. Keep dependencies Node-only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export type MigrationProgressText = { title: string; body: string };
export type MigrationProgressWindow = {
  update: (completedBytes: number, totalBytes: number) => void;
  close: () => void;
};

const WRITE_INTERVAL_MS = 200;

// Localized text and paths arrive through the environment, never as script source.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$file = $env:WOODY_MIGRATION_PROGRESS
$owner = [int]$env:WOODY_MIGRATION_OWNER
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:WOODY_MIGRATION_TITLE
$form.Font = [System.Drawing.SystemFonts]::MessageBoxFont
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.ControlBox = $false
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.TopMost = $true
$form.ClientSize = New-Object System.Drawing.Size(460, 132)
$label = New-Object System.Windows.Forms.Label
$label.Text = $env:WOODY_MIGRATION_BODY
$label.SetBounds(16, 14, 428, 68)
$bar = New-Object System.Windows.Forms.ProgressBar
$bar.SetBounds(16, 94, 428, 20)
$bar.Maximum = 1000
$form.Controls.AddRange(@($label, $bar))
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
  try {
    if (-not (Get-Process -Id $owner -ErrorAction SilentlyContinue)) { $form.Close(); return }
    $stream = [System.IO.File]::Open($file, 'Open', 'Read', 'ReadWrite, Delete')
    try { $text = (New-Object System.IO.StreamReader($stream)).ReadToEnd() } finally { $stream.Dispose() }
    $value = 0
    if ([int]::TryParse($text.Trim(), [ref]$value)) { $bar.Value = [Math]::Max(0, [Math]::Min(1000, $value)) }
  } catch {}
})
$timer.Start()
# windowsHide also hides the first window this process shows; show it again.
$form.Add_Shown({ $form.Hide(); $form.Show() })
[System.Windows.Forms.Application]::Run($form)
`;

/**
 * Show migration progress from a detached PowerShell window on Windows. It
 * starts on the first update, so launches without migration work spawn
 * nothing. Progress display is best-effort and never fails the migration.
 */
export function createMigrationProgressWindow(
  text: MigrationProgressText,
  platform: NodeJS.Platform = process.platform
): MigrationProgressWindow {
  let started = false;
  let closed = false;
  let child: ChildProcess | undefined;
  let directory: string | undefined;
  let file: string | undefined;
  let lastPermille = -1;
  let lastWrite = 0;

  const start = (): void => {
    started = true;
    if (platform !== 'win32') return;
    try {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-migration-'));
      file = path.join(directory, 'progress');
      fs.writeFileSync(file, '0');
      child = spawn(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
        {
          // Hide PowerShell's console. A detached PowerShell exits immediately,
          // so the script re-shows its form instead.
          windowsHide: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            WOODY_MIGRATION_PROGRESS: file,
            WOODY_MIGRATION_OWNER: String(process.pid),
            WOODY_MIGRATION_TITLE: text.title,
            WOODY_MIGRATION_BODY: text.body,
          },
        }
      );
      // Spawn failures are reported after the blocking migration returns.
      child.on('error', () => undefined);
      child.unref();
    } catch (error) {
      console.warn('[Woody] Data migration progress window unavailable:', error);
    }
  };

  return {
    update(completedBytes, totalBytes) {
      if (closed) return;
      if (!started) start();
      if (!file) return;
      const permille = totalBytes > 0 ? Math.min(1000, Math.floor((completedBytes / totalBytes) * 1000)) : 0;
      const now = Date.now();
      if (permille === lastPermille || (permille < 1000 && now - lastWrite < WRITE_INTERVAL_MS)) return;
      try {
        fs.writeFileSync(file, String(permille));
        lastPermille = permille;
        lastWrite = now;
      } catch {
        // The window may be reading the file; the next update retries.
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        child?.kill();
      } catch {
        // The window has already exited.
      }
      if (directory) {
        try {
          fs.rmSync(directory, { recursive: true, force: true });
        } catch {
          // A just-terminated reader can briefly hold the file; the OS temp cleanup removes it.
        }
      }
    },
  };
}
