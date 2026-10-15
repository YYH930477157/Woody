import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({
  isPackaged: true,
  getPath: vi.fn(),
  setPath: vi.fn(),
}));

vi.mock('electron', () => ({ app }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('brand storage paths', () => {
  it.each(['C:/Users/test/AppData/Roaming', '/Users/test/Library/Application Support', '/home/test/.config'])(
    'keeps packaged user data in the historical directory under %s',
    async (appData) => {
      app.isPackaged = true;
      app.getPath.mockReturnValue(appData);

      await import('@/brandPins');

      expect(app.getPath).toHaveBeenCalledWith('appData');
      expect(app.setPath).toHaveBeenCalledWith('userData', path.join(appData, 'AionUi'));
    }
  );

  it('leaves the development user data path unchanged', async () => {
    app.isPackaged = false;

    await import('@/brandPins');

    expect(app.setPath).not.toHaveBeenCalled();
  });
});
