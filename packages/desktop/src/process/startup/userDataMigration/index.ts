/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// This module runs before storage/logging imports. Keep dependencies Node-only.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

type MigrationOptions = {
  assertIdle?: () => void;
  /** Bytes hashed or copied so far; called synchronously while the migration blocks startup. */
  onProgress?: (completedBytes: number, totalBytes: number) => void;
};
type MigrationResult = { userDataPath: string; backupPath?: string };
type Advance = (bytes: number) => void;
type Journal = {
  version: 1;
  backup: string;
  entries: { name: string; directory: boolean }[];
  complete: boolean;
};
const JOURNAL = '.woodyui-data-migration.json';
const LOCK_FILES = new Set(['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']);

function readJournal(appDataDir: string): Journal | undefined {
  const file = path.join(appDataDir, JOURNAL);
  if (!entry(file)) return undefined;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Journal;
  if (
    value.version !== 1 ||
    !/^AionUi-backup-[\w-]+$/.test(value.backup) ||
    typeof value.complete !== 'boolean' ||
    !Array.isArray(value.entries) ||
    value.entries.some(
      (item) =>
        !item ||
        typeof item.name !== 'string' ||
        !item.name ||
        /[\\/:]/.test(item.name) ||
        item.name === '.' ||
        item.name === '..' ||
        LOCK_FILES.has(item.name) ||
        typeof item.directory !== 'boolean'
    )
  ) {
    throw new Error('Invalid WoodyUi migration journal; existing data retained.');
  }
  return value;
}

function writeJournal(appDataDir: string, journal: Journal): void {
  const destination = path.join(appDataDir, JOURNAL);
  const temporary = `${destination}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(journal));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, destination);
}

function entry(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function linkLegacyPath(legacy: string, target: string): void {
  fs.symlinkSync(target, legacy, process.platform === 'win32' ? 'junction' : 'dir');
}

function inspectRoots(appDataDir: string) {
  const legacy = path.join(appDataDir, 'AionUi');
  const target = path.join(appDataDir, 'WoodyUi');
  const sourceEntry = entry(legacy);
  const targetEntry = entry(target);
  if (targetEntry && (!targetEntry.isDirectory() || targetEntry.isSymbolicLink())) {
    throw new Error(`WoodyUi data path must be a real directory: ${target}`);
  }
  if (sourceEntry?.isSymbolicLink()) {
    if (!targetEntry || fs.realpathSync(legacy) !== fs.realpathSync(target)) {
      throw new Error(`Unexpected legacy data link: ${legacy}`);
    }
  } else if (sourceEntry && !sourceEntry.isDirectory()) {
    throw new Error(`Legacy data path is not a directory: ${legacy}`);
  } else if (sourceEntry && targetEntry && !readJournal(appDataDir)) {
    throw new Error(`Data directory conflict; both paths exist: ${legacy}, ${target}`);
  }
  return { legacy, target, sourceEntry, targetEntry };
}

/** Prepare the historical path used by Electron's single-instance identity. */
export function prepareLegacyUserDataPath(appDataDir: string): string {
  const { legacy, target, sourceEntry, targetEntry } = inspectRoots(appDataDir);
  if (readJournal(appDataDir)?.complete && !targetEntry)
    throw new Error('WoodyUi profile is missing. Restore the backup.');
  if (targetEntry) {
    if (!sourceEntry) linkLegacyPath(legacy, target);
  } else if (!sourceEntry) {
    // A fresh installation has nothing to back up: create the new root and
    // take the historical lock through its compatibility link.
    fs.mkdirSync(target, { recursive: true });
    try {
      linkLegacyPath(legacy, target);
    } catch {
      // Junctions need a local volume, so a redirected AppData share cannot link.
      // Fall back to an empty historical root, which migrates with no links to create.
      fs.rmdirSync(target);
      fs.mkdirSync(legacy, { recursive: true });
    }
  }
  return legacy;
}

/** Refuse to copy databases while an orphaned backend might still write to them. */
export function assertMigrationBackendIdle(): void {
  const output =
    process.platform === 'win32'
      ? execFileSync(
          path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter \"Name = 'aioncore.exe'\" | ForEach-Object { $_.ProcessId }",
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 15000 }
        ).trim()
      : execFileSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8', timeout: 5000 })
          .split('\n')
          .filter((command) => path.basename(command.trim()) === 'aioncore')
          .join('\n');
  if (output) throw new Error('AionCore backend is still running. Close all Woody/AionUi instances before migrating.');
}

function meter(totalBytes: number, report?: MigrationOptions['onProgress']): Advance {
  let completed = 0;
  report?.(0, totalBytes);
  return (bytes) => {
    completed = Math.min(totalBytes, completed + bytes);
    report?.(completed, totalBytes);
  };
}

function digest(file: string, advance?: Advance): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let bytes: number;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
      advance?.(bytes);
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Metadata-only fingerprint. A rename keeps each file's size and mtime, and a
 * write changes them, so this detects changes without rereading file contents.
 * Directory mtimes are excluded because moving their children updates them.
 */
function inventory(root: string): { fingerprint: string; bytes: number } {
  const entries: string[][] = [];
  let bytes = 0;
  function visit(relative: string): void {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute, { bigint: true });
    if (stat.isSymbolicLink()) entries.push([relative, 'link', fs.readlinkSync(absolute)]);
    else if (stat.isDirectory()) {
      if (relative) entries.push([relative, 'dir']);
      for (const name of fs.readdirSync(absolute).toSorted()) {
        if (!relative && LOCK_FILES.has(name)) continue;
        visit(path.join(relative, name));
      }
    } else if (stat.isFile()) {
      bytes += Number(stat.size);
      entries.push([relative, 'file', String(stat.size), String(stat.mtimeNs)]);
    } else throw new Error(`Unsupported data entry: ${absolute}`);
  }
  visit('');
  return { fingerprint: JSON.stringify(entries), bytes };
}

function snapshot(root: string, advance?: Advance): string {
  const entries: [string, string, string][] = [];
  function visit(relative: string): void {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) entries.push([relative, 'link', fs.readlinkSync(absolute)]);
    else if (stat.isDirectory()) {
      entries.push([relative, 'dir', '']);
      for (const name of fs.readdirSync(absolute).toSorted()) {
        if (!relative && LOCK_FILES.has(name)) continue;
        visit(path.join(relative, name));
      }
    } else if (stat.isFile()) entries.push([relative, 'file', digest(absolute, advance)]);
    else throw new Error(`Unsupported data entry: ${absolute}`);
  }
  visit('');
  return JSON.stringify(entries);
}

function isDirectoryLink(source: string): boolean {
  try {
    return fs.statSync(source).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (process.platform !== 'win32') return false;
    // FileAttributes describes the reparse point itself, even when its target
    // no longer exists. Pass the path as environment data, never shell code.
    return (
      execFileSync(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$ErrorActionPreference = 'Stop'; [bool]((Get-Item -LiteralPath $env:WOODY_MIGRATION_LINK -Force).Attributes -band [IO.FileAttributes]::Directory)",
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, WOODY_MIGRATION_LINK: source } }
      ).trim() === 'True'
    );
  }
}

function copyTree(source: string, destination: string, root = false, advance?: Advance): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    // Do not follow session-skill junctions or copy data outside the profile.
    // Windows directory junctions do not require symlink privileges.
    const link = fs.readlinkSync(source);
    const isDirectory = process.platform === 'win32' && isDirectoryLink(source);
    fs.symlinkSync(link, destination, isDirectory ? (path.isAbsolute(link) ? 'junction' : 'dir') : undefined);
  } else if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: false, mode: stat.mode });
    for (const name of fs.readdirSync(source)) {
      if (root && LOCK_FILES.has(name)) continue;
      copyTree(path.join(source, name), path.join(destination, name), false, advance);
    }
  } else if (stat.isFile()) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, stat.mode);
    fs.utimesSync(destination, stat.atime, stat.mtime);
    advance?.(stat.size);
  } else throw new Error(`Unsupported data entry: ${source}`);
}

/**
 * Migrate only while holding the historical Electron instance lock. A verified
 * backup remains beside the profile. The historical root must stay in place:
 * Electron holds its Windows lockfile open without delete sharing. Move each
 * child and leave compatibility junctions (files use hard links) instead.
 * The journal makes a crash between a move and link creation resumable.
 * Contents are hashed twice, once for the source and once for its backup.
 * Unchanged source data and complete moves are checked through metadata.
 */
export function migrateUserData(appDataDir: string, options: MigrationOptions = {}): MigrationResult {
  const { legacy, target, sourceEntry, targetEntry } = inspectRoots(appDataDir);
  let journal = readJournal(appDataDir);
  if (journal?.complete && !targetEntry) throw new Error('WoodyUi profile is missing. Restore the backup.');
  if (sourceEntry?.isSymbolicLink()) return { userDataPath: target };
  if (!sourceEntry) {
    if (!targetEntry) fs.mkdirSync(target, { recursive: true });
    linkLegacyPath(legacy, target);
    return { userDataPath: target };
  }

  if (journal?.complete) {
    if (!targetEntry) throw new Error('WoodyUi profile is missing after a completed migration. Restore the backup.');
    return { userDataPath: target };
  }
  const assertIdle = options.assertIdle ?? assertMigrationBackendIdle;
  assertIdle();
  // Set only when this run inventoried the source before moving it.
  let movedInventory: string | undefined;
  if (!journal) {
    const source = inventory(legacy);
    const advance = meter(source.bytes * 3, options.onProgress);
    const before = snapshot(legacy, advance);
    const backupContainer = fs.mkdtempSync(path.join(appDataDir, 'AionUi-backup-'));
    const partial = path.join(backupContainer, 'incomplete');
    const backupPath = path.join(backupContainer, 'AionUi');
    copyTree(legacy, partial, true, advance);
    if (snapshot(partial, advance) !== before || inventory(legacy).fingerprint !== source.fingerprint) {
      throw new Error(`Data backup verification failed. Original data retained: ${legacy}`);
    }
    movedInventory = source.fingerprint;
    fs.renameSync(partial, backupPath);
    assertIdle();
    inspectRoots(appDataDir);
    journal = {
      version: 1,
      backup: path.basename(backupContainer),
      complete: false,
      entries: fs
        .readdirSync(legacy)
        .filter((name) => !LOCK_FILES.has(name))
        .map((name) => {
          const file = path.join(legacy, name);
          const stat = fs.lstatSync(file);
          return { name, directory: stat.isDirectory() || (stat.isSymbolicLink() && isDirectoryLink(file)) };
        }),
    };
    writeJournal(appDataDir, journal);
  }
  const backupPath = path.join(appDataDir, journal.backup, 'AionUi');
  if (!fs.statSync(backupPath).isDirectory()) throw new Error('Migration backup is missing.');
  fs.mkdirSync(target, { recursive: true });
  for (const item of journal.entries) {
    const oldPath = path.join(legacy, item.name);
    const newPath = path.join(target, item.name);
    if (!entry(newPath)) fs.renameSync(oldPath, newPath);
    if (!entry(oldPath)) {
      if (item.directory) linkLegacyPath(oldPath, newPath);
      else fs.linkSync(newPath, oldPath);
    } else {
      const oldStat = fs.lstatSync(oldPath);
      const newStat = fs.lstatSync(newPath);
      const directoryAlias =
        item.directory &&
        oldStat.isSymbolicLink() &&
        path.toNamespacedPath(fs.readlinkSync(oldPath)) === path.toNamespacedPath(newPath);
      if (!directoryAlias && (oldStat.dev !== newStat.dev || oldStat.ino !== newStat.ino)) {
        throw new Error(`Migration entry conflict: ${oldPath}`);
      }
    }
  }
  // A resumed run has no pre-move inventory, so it compares contents with the backup.
  let verified: boolean;
  if (movedInventory !== undefined) verified = inventory(target).fingerprint === movedInventory;
  else {
    const advance = meter(inventory(backupPath).bytes * 2, options.onProgress);
    verified = snapshot(target, advance) === snapshot(backupPath, advance);
  }
  if (!verified) throw new Error('Migrated data verification failed; backup retained.');
  writeJournal(appDataDir, { ...journal, complete: true });
  return { userDataPath: target, backupPath };
}
