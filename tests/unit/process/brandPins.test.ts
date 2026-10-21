import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({
  isPackaged: true,
  getPath: vi.fn(),
  setPath: vi.fn(),
  requestSingleInstanceLock: vi.fn(),
  getPreferredSystemLanguages: vi.fn(() => ['en-US']),
  exit: vi.fn(),
}));

const migration = vi.hoisted(() => ({ prepareLegacyUserDataPath: vi.fn(), migrateUserData: vi.fn() }));
const showErrorBox = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app, dialog: { showErrorBox } }));
vi.mock('@/process/startup/userDataMigration', () => migration);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('AIONUI_E2E_TEST', '');
  vi.stubEnv('AIONUI_MULTI_INSTANCE', '');
  app.isPackaged = true;
  app.getPath.mockReturnValue('C:/test');
  app.requestSingleInstanceLock.mockReturnValue(true);
  migration.prepareLegacyUserDataPath.mockImplementation((root: string) => path.join(root, 'AionUi'));
  migration.migrateUserData.mockImplementation((root: string) => ({ userDataPath: path.join(root, 'WoodyUi') }));
});

afterEach(() => vi.unstubAllEnvs());

describe('brand storage paths', () => {
  it.each(['C:/Users/test/AppData/Roaming', '/Users/test/Library/Application Support', '/home/test/.config'])(
    'migrates packaged user data to WoodyUi under %s',
    async (appData) => {
      app.isPackaged = true;
      app.getPath.mockReturnValue(appData);

      await import('@/brandPins');

      expect(app.setPath).toHaveBeenLastCalledWith('sessionData', path.join(appData, 'WoodyUi'));
      expect(app.requestSingleInstanceLock.mock.invocationCallOrder[0]).toBeLessThan(
        migration.migrateUserData.mock.invocationCallOrder[0]
      );
      expect(app.setPath.mock.calls.filter(([key]) => key === 'userData')).toEqual([
        ['userData', path.join(appData, 'AionUi')],
        ['userData', path.join(appData, 'WoodyUi')],
      ]);
    }
  );

  it('leaves the development user data path unchanged', async () => {
    app.isPackaged = false;

    await import('@/brandPins');

    expect(app.setPath).not.toHaveBeenCalled();
  });

  it('exits before migrating when an old or new instance already owns the lock', async () => {
    app.requestSingleInstanceLock.mockReturnValue(false);
    await import('@/brandPins');
    expect(app.exit).toHaveBeenCalledWith(0);
    expect(migration.migrateUserData).not.toHaveBeenCalled();
  });

  it('never allows multi-instance mode to bypass the production migration lock', async () => {
    vi.stubEnv('AIONUI_MULTI_INSTANCE', '1');
    await import('@/brandPins');
    expect(app.requestSingleInstanceLock).toHaveBeenCalled();
  });

  it('stops startup and reports migration failure before opening a new profile', async () => {
    migration.migrateUserData.mockImplementationOnce(() => {
      throw new Error('conflict');
    });
    await import('@/brandPins');
    expect(app.exit).toHaveBeenCalledWith(1);
    expect(showErrorBox).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('conflict'));
    expect(app.setPath).not.toHaveBeenCalledWith('userData', path.join('C:/test', 'WoodyUi'));
  });

  it('bypasses all production path access for an isolated E2E profile', async () => {
    vi.stubEnv('AIONUI_E2E_TEST', '1');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-brand-test-'));
    vi.stubEnv('AIONUI_E2E_USER_DATA_DIR', profile);
    try {
      await import('@/brandPins');
      expect(app.setPath).toHaveBeenCalledWith('sessionData', profile);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
    expect(app.getPath).not.toHaveBeenCalled();
    expect(migration.prepareLegacyUserDataPath).not.toHaveBeenCalled();
    expect(app.requestSingleInstanceLock).not.toHaveBeenCalled();
  });

  it('rejects E2E mode without an explicit profile instead of touching real data', async () => {
    vi.stubEnv('AIONUI_E2E_TEST', '1');
    vi.stubEnv('AIONUI_E2E_USER_DATA_DIR', '');
    await import('@/brandPins');
    expect(app.exit).toHaveBeenCalledWith(1);
    expect(migration.prepareLegacyUserDataPath).not.toHaveBeenCalled();
  });
});
