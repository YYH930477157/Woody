import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateUserData, prepareLegacyUserDataPath } from '@/process/startup/userDataMigration';

let root: string;
let legacy: string;
let target: string;
const idle = () => {};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-migration-'));
  legacy = path.join(root, 'AionUi');
  target = path.join(root, 'WoodyUi');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function seed() {
  fs.mkdirSync(path.join(legacy, 'aionui'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'aionui', 'chats.db'), Buffer.from([0, 255, 18, 10]));
  fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ workspace: path.join(legacy, 'aionui') }));
}

/** Fail the compatibility link for one migrated entry once, after the link probe has passed. */
function failEntryLinkOnce(name: string) {
  const link = fs.symlinkSync;
  let failed = false;
  vi.spyOn(fs, 'symlinkSync').mockImplementation((from, to, type) => {
    if (!failed && path.basename(String(to)) === name) {
      failed = true;
      throw new Error('link denied');
    }
    link(from, to, type);
  });
}

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

describe('WoodyUi profile migration', () => {
  it('preserves bytes, creates a verified backup, and keeps old absolute paths working', () => {
    seed();
    const result = migrateUserData(root, { assertIdle: idle });
    expect(fs.readFileSync(path.join(target, 'aionui', 'chats.db'))).toEqual(Buffer.from([0, 255, 18, 10]));
    expect(fs.readFileSync(path.join(result.backupPath!, 'config.json'), 'utf8')).toBe(
      fs.readFileSync(path.join(target, 'config.json'), 'utf8')
    );
    expect(fs.realpathSync(path.join(legacy, 'aionui'))).toBe(fs.realpathSync(path.join(target, 'aionui')));
  });

  it('does not overwrite two independent directories', () => {
    seed();
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'new-chat'), 'keep');
    expect(() => migrateUserData(root, { assertIdle: idle })).toThrow(/conflict/i);
    expect(fs.readFileSync(path.join(target, 'new-chat'), 'utf8')).toBe('keep');
    expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(false);
  });

  it('leaves the source untouched while a backend is active', () => {
    seed();
    expect(() =>
      migrateUserData(root, {
        assertIdle: () => {
          throw new Error('backend busy');
        },
      })
    ).toThrow('backend busy');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(root)).toEqual(['AionUi']);
  });

  it('keeps the original and retries safely after a failed copy', () => {
    seed();
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => migrateUserData(root, { assertIdle: idle })).toThrow('disk full');
    expect(fs.existsSync(path.join(legacy, 'aionui', 'chats.db'))).toBe(true);
    copy.mockRestore();
    expect(migrateUserData(root, { assertIdle: idle }).userDataPath).toBe(target);
  });

  it('refuses to rename if the backup differs from the source', () => {
    seed();
    const copy = fs.copyFileSync;
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      copy(from, to, mode);
      fs.appendFileSync(to, 'corrupt');
    });
    expect(() => migrateUserData(root, { assertIdle: idle })).toThrow(/verif/i);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('refuses to rename when a file changes during the backup', () => {
    seed();
    const copy = fs.copyFileSync;
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      copy(from, to, mode);
      fs.appendFileSync(from, 'changed');
    });
    expect(() => migrateUserData(root, { assertIdle: idle })).toThrow(/verif/i);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('retains data and resumes if interrupted between moving a directory and linking it', () => {
    seed();
    failEntryLinkOnce('aionui');
    expect(() => migrateUserData(root, { assertIdle: idle })).toThrow('link denied');
    expect(fs.existsSync(path.join(target, 'aionui', 'chats.db'))).toBe(true);
    migrateUserData(root, { assertIdle: idle });
    expect(fs.readFileSync(path.join(legacy, 'aionui', 'chats.db'))).toEqual(Buffer.from([0, 255, 18, 10]));
  });

  it('repairs an interrupted rename before taking the historical instance lock', () => {
    seed();
    fs.renameSync(legacy, target);
    expect(prepareLegacyUserDataPath(root)).toBe(legacy);
    expect(fs.realpathSync(legacy)).toBe(fs.realpathSync(target));
    expect(migrateUserData(root, { assertIdle: idle }).backupPath).toBeUndefined();
  });

  it('does not repeat the backup or the idle check on subsequent launches', () => {
    seed();
    migrateUserData(root, { assertIdle: idle });
    const files = fs.readdirSync(root);
    const guard = vi.fn();
    migrateUserData(root, { assertIdle: guard });
    expect(guard).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual(files);
  });

  it('preserves session skill junctions and their old absolute targets', () => {
    seed();
    const link = path.join(legacy, 'skills');
    fs.symlinkSync(path.join(legacy, 'aionui'), link, process.platform === 'win32' ? 'junction' : 'dir');
    migrateUserData(root, { assertIdle: idle });
    expect(fs.lstatSync(path.join(target, 'skills')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(target, 'skills', 'chats.db'))).toEqual(Buffer.from([0, 255, 18, 10]));
  });

  it('rejects a legacy junction pointing to an unrelated profile', () => {
    fs.mkdirSync(target);
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    fs.symlinkSync(other, legacy, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => prepareLegacyUserDataPath(root)).toThrow(/link/i);
    expect(() => migrateUserData(root, { assertIdle: idle })).toThrow(/link/i);
  });

  it('rejects a dangling legacy link instead of starting an empty profile', () => {
    fs.symlinkSync(path.join(root, 'missing'), legacy, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => migrateUserData(root, { assertIdle: idle })).toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });

  it('creates the new root and compatibility link on a fresh installation', () => {
    prepareLegacyUserDataPath(root);
    expect(migrateUserData(root, { assertIdle: idle })).toEqual({ userDataPath: target });
    expect(fs.realpathSync(legacy)).toBe(fs.realpathSync(target));
  });

  it('does not back up or check for a backend on a fresh installation', () => {
    const guard = vi.fn();
    prepareLegacyUserDataPath(root);
    migrateUserData(root, { assertIdle: guard });
    expect(guard).not.toHaveBeenCalled();
    expect(fs.readdirSync(root).toSorted()).toEqual(['AionUi', 'WoodyUi']);
  });

  it('starts a fresh installation in the historical root on a volume that cannot hold links', () => {
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw new Error('junctions need a local volume');
    });
    prepareLegacyUserDataPath(root);
    expect(migrateUserData(root, { assertIdle: idle }).userDataPath).toBe(legacy);
  });

  it('keeps existing data in place when the volume cannot hold links', () => {
    seed();
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw new Error('junctions need a local volume');
    });
    expect(migrateUserData(root, { assertIdle: idle })).toEqual({ userDataPath: legacy });
    expect(fs.readdirSync(root)).toEqual(['AionUi']);
  });

  it('removes the copy of a backup that failed', () => {
    seed();
    vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => migrateUserData(root, { assertIdle: idle })).toThrow('disk full');
    expect(fs.readdirSync(root)).toEqual(['AionUi']);
  });

  it('removes copies left by an interrupted backup before starting another', () => {
    seed();
    fs.mkdirSync(path.join(root, 'AionUi-backup-abc123', 'incomplete'), { recursive: true });
    migrateUserData(root, { assertIdle: idle });
    expect(fs.existsSync(path.join(root, 'AionUi-backup-abc123'))).toBe(false);
  });

  it('keeps verified backups even when no journal names them', () => {
    seed();
    fs.mkdirSync(path.join(root, 'AionUi-backup-kept', 'AionUi'), { recursive: true });
    migrateUserData(root, { assertIdle: idle });
    expect(fs.existsSync(path.join(root, 'AionUi-backup-kept', 'AionUi'))).toBe(true);
  });

  it('does not follow links while removing a failed backup', () => {
    seed();
    const outside = path.join(root, 'workspace');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'notes.txt'), 'keep');
    fs.symlinkSync(outside, path.join(legacy, 'workspace-link'), linkType);
    const copy = fs.copyFileSync;
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      copy(from, to, mode);
      fs.appendFileSync(to, 'corrupt');
    });
    expect(() => migrateUserData(root, { assertIdle: idle })).toThrow(/verif/i);
    expect(fs.readFileSync(path.join(outside, 'notes.txt'), 'utf8')).toBe('keep');
  });

  it('reports progress from zero to the hashed and copied byte total', () => {
    seed();
    const bytes = 4 + fs.statSync(path.join(legacy, 'config.json')).size;
    const progress: [number, number][] = [];
    migrateUserData(root, { assertIdle: idle, onProgress: (done, total) => progress.push([done, total]) });
    expect(progress[0]).toEqual([0, bytes * 3]);
    expect(progress.at(-1)).toEqual([bytes * 3, bytes * 3]);
  });

  it('hashes file contents only for the source and its backup', () => {
    seed();
    const bytes = 4 + fs.statSync(path.join(legacy, 'config.json')).size;
    const read = vi.spyOn(fs, 'readSync');
    migrateUserData(root, { assertIdle: idle });
    const hashed = read.mock.results.reduce((sum, result) => sum + (result.value as number), 0);
    expect(hashed).toBe(bytes * 2);
  });

  it('refuses to finish when an entry changes while it is moved', () => {
    seed();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (path.basename(String(to)) === 'aionui') fs.appendFileSync(path.join(String(to), 'chats.db'), 'late');
    });
    expect(() => migrateUserData(root, { assertIdle: idle })).toThrow(/verif/i);
  });

  it('compares contents with the backup when finishing an interrupted migration', () => {
    seed();
    failEntryLinkOnce('aionui');
    expect(() => migrateUserData(root, { assertIdle: idle })).toThrow('link denied');
    fs.writeFileSync(path.join(target, 'aionui', 'chats.db'), Buffer.from([1, 2, 3, 4]));
    expect(() => migrateUserData(root, { assertIdle: idle })).toThrow(/verif/i);
  });

  it('leaves Electron lock files in the historical root and excludes them from backup', () => {
    seed();
    fs.writeFileSync(path.join(legacy, 'lockfile'), 'held by Electron');
    const result = migrateUserData(root, { assertIdle: idle });
    expect(fs.readFileSync(path.join(legacy, 'lockfile'), 'utf8')).toBe('held by Electron');
    expect(fs.existsSync(path.join(target, 'lockfile'))).toBe(false);
    expect(fs.existsSync(path.join(result.backupPath!, 'lockfile'))).toBe(false);
  });

  it('preserves a dangling nested skill junction without following it', () => {
    seed();
    fs.symlinkSync(
      path.join(root, 'removed-skill'),
      path.join(legacy, 'aionui', 'old-skill'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const originalLink = fs.readlinkSync(path.join(legacy, 'aionui', 'old-skill'));
    migrateUserData(root, { assertIdle: idle });
    expect(fs.readlinkSync(path.join(target, 'aionui', 'old-skill'))).toBe(originalLink);
  });

  it('does not create an empty profile when a migrated target has been removed', () => {
    seed();
    migrateUserData(root, { assertIdle: idle });
    fs.renameSync(target, path.join(root, 'removed-profile'));
    expect(() => prepareLegacyUserDataPath(root)).toThrow(/missing/);
    expect(() => migrateUserData(root, { assertIdle: idle })).toThrow(/missing/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('keeps root files accessible through hard links', () => {
    seed();
    migrateUserData(root, { assertIdle: idle });
    fs.writeFileSync(path.join(target, 'config.json'), 'updated');
    expect(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8')).toBe('updated');
  });
});
