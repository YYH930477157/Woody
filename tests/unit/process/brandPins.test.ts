import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({
  isPackaged: true,
  getPath: vi.fn(),
  setPath: vi.fn(),
  requestSingleInstanceLock: vi.fn(),
  exit: vi.fn(),
}));
vi.mock('electron', () => ({ app }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('AIONUI_E2E_TEST', '');
  app.isPackaged = true;
  app.getPath.mockReturnValue('C:/test');
});

afterEach(() => vi.unstubAllEnvs());

describe('brand storage paths', () => {
  it.each(['C:/Users/test/AppData/Roaming', '/Users/test/Library/Application Support', '/home/test/.config'])(
    'stores packaged data directly under WoodyUi in %s',
    async (appData) => {
      app.getPath.mockReturnValue(appData);

      await import('@/brandPins');

      expect(app.setPath.mock.calls).toEqual([
        ['userData', path.join(appData, 'WoodyUi')],
        ['sessionData', path.join(appData, 'WoodyUi')],
      ]);
    }
  );

  it('leaves the historical AionUi directory and the instance lock alone', async () => {
    const { packagedInstanceLock } = await import('@/brandPins');

    expect(app.setPath).not.toHaveBeenCalledWith('userData', path.join('C:/test', 'AionUi'));
    expect([packagedInstanceLock, app.requestSingleInstanceLock.mock.calls.length]).toEqual([undefined, 0]);
  });

  it('leaves the development user data path unchanged', async () => {
    app.isPackaged = false;

    await import('@/brandPins');

    expect(app.setPath).not.toHaveBeenCalled();
  });

  it('uses an isolated E2E profile without resolving the real app-data directory', async () => {
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
  });

  it('stops startup in E2E mode without an explicit profile instead of touching real data', async () => {
    vi.stubEnv('AIONUI_E2E_TEST', '1');
    vi.stubEnv('AIONUI_E2E_USER_DATA_DIR', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { packagedInstanceLock } = await import('@/brandPins');

    expect([packagedInstanceLock, app.setPath.mock.calls.length]).toEqual([false, 0]);
    expect(app.exit).toHaveBeenCalledWith(1);
  });
});
