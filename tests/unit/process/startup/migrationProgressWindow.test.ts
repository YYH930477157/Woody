import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({ on: vi.fn(), unref: vi.fn(), kill: vi.fn() }));
const spawn = vi.hoisted(() => vi.fn(() => child));
vi.mock('node:child_process', () => ({ spawn }));

import { createMigrationProgressWindow } from '@/process/startup/userDataMigration/progressWindow';

const text = { title: 'Upgrading', body: "Moving data; don't close $(Remove-Item x)" };
type SpawnOptions = { env: Record<string, string>; windowsHide: boolean };
const options = () => (spawn.mock.calls[0] as unknown as [string, string[], SpawnOptions])[2];
const progressFile = () => options().env.WOODY_MIGRATION_PROGRESS;

let now = 0;
beforeEach(() => {
  vi.clearAllMocks();
  spawn.mockImplementation(() => child);
  now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => vi.restoreAllMocks());

describe('migration progress window', () => {
  it('does not start anything until the migration reports work', () => {
    const window = createMigrationProgressWindow(text, 'win32');
    window.close();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not start a helper outside Windows', () => {
    const window = createMigrationProgressWindow(text, 'darwin');
    window.update(1, 2);
    window.close();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('starts one console-free helper for repeated updates', () => {
    const window = createMigrationProgressWindow(text, 'win32');
    window.update(0, 100);
    window.update(50, 100);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(options()).toMatchObject({ windowsHide: true });
    window.close();
  });

  it('passes localized text through the environment instead of the command line', () => {
    const window = createMigrationProgressWindow(text, 'win32');
    window.update(0, 100);
    const args = (spawn.mock.calls[0] as unknown as [string, string[]])[1];
    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
    expect(script).not.toContain(text.body);
    expect(options().env.WOODY_MIGRATION_BODY).toBe(text.body);
    window.close();
  });

  it('throttles progress writes but always records completion', () => {
    const window = createMigrationProgressWindow(text, 'win32');
    window.update(0, 1000);
    window.update(400, 1000);
    expect(fs.readFileSync(progressFile(), 'utf8')).toBe('0');
    window.update(1000, 1000);
    expect(fs.readFileSync(progressFile(), 'utf8')).toBe('1000');
    window.close();
  });

  it('writes progress again after the interval', () => {
    const window = createMigrationProgressWindow(text, 'win32');
    window.update(0, 1000);
    now += 250;
    window.update(400, 1000);
    expect(fs.readFileSync(progressFile(), 'utf8')).toBe('400');
    window.close();
  });

  it('stops the helper and removes its progress file on close', () => {
    const window = createMigrationProgressWindow(text, 'win32');
    window.update(0, 100);
    const file = progressFile();
    window.close();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps migrating when the helper cannot start', () => {
    spawn.mockImplementation(() => {
      throw new Error('powershell blocked');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const window = createMigrationProgressWindow(text, 'win32');
    expect(() => {
      window.update(0, 100);
      window.update(100, 100);
      window.close();
    }).not.toThrow();
  });
});
