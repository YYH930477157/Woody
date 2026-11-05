import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (params?: unknown) => Promise<unknown>>(),
  sender: vi.fn(),
  owner: vi.fn(),
  partition: {},
  target: vi.fn(),
  dialog: vi.fn(),
  getPath: vi.fn(),
}));
vi.mock('@/common/adapter/main', () => ({ getNativeBridgeSender: mocks.sender }));
vi.mock('@/common/adapter/websitePasswords', () => ({
  websitePasswords: Object.fromEntries(
    ['list', 'importChrome', 'remove', 'setDefault', 'setEnabled', 'updatePassword'].map((name) => [
      name,
      {
        provider: (handler: (params?: unknown) => Promise<unknown>) => mocks.handlers.set(name, handler),
      },
    ])
  ),
}));
vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  BrowserWindow: { fromWebContents: mocks.owner },
  dialog: { showOpenDialog: mocks.dialog },
  session: { fromPartition: () => mocks.partition },
  webContents: { fromId: mocks.target },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));
import { initWebsitePasswordsBridge } from '@process/bridge/websitePasswordsBridge';
import {
  attachWebsitePasswordTarget,
  disposeWebsitePasswords,
  getWebsitePasswordRuntime,
  setWebsitePasswordWindow,
} from '@process/services/websitePasswords/runtime';

let directory: string;
const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, getType: () => 'window' });
const window = { webContents: sender, isDestroyed: () => false };
const invoke = (name: string, params?: unknown) => mocks.handlers.get(name)!(params);
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'woody-native-passwords-'));
  mocks.getPath.mockReturnValue(directory);
  mocks.sender.mockReturnValue(sender);
  mocks.owner.mockReturnValue(window);
  setWebsitePasswordWindow(window as never);
  initWebsitePasswordsBridge();
});
afterEach(async () => {
  disposeWebsitePasswords();
  await rm(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});
describe('native password management boundary', () => {
  it('injects only the dedicated isolated preload in the owned browser partition', () => {
    const browser: Electron.WebPreferences = {};
    sender.emit('will-attach-webview', {}, browser, { partition: BROWSER_SESSION_PARTITION });
    expect(browser.preload).toMatch(/websitePasswordPreload\.js$/);
    expect(browser).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
    const extension: Electron.WebPreferences = { preload: 'extension.js' };
    sender.emit('will-attach-webview', {}, extension, { partition: 'persist:extension' });
    expect(extension.preload).toBe('extension.js');
  });
  it('accepts a write-only password edit and never returns it', async () => {
    const store = getWebsitePasswordRuntime().store;
    await store.importCsv('name,url,username,password\nX,https://x.test,alice,old');
    const id = (await store.status()).accounts[0].id;
    const response = await invoke('updatePassword', {
      id,
      password: 'replacement-secret',
      expectedPassword: 'ignored',
    });
    expect((await store.find('https://x.test'))?.password).toBe('replacement-secret');
    expect(JSON.stringify(response)).not.toContain('replacement-secret');
  });
  it('rejects malformed password edits without exposing input in errors', async () => {
    await expect(invoke('updatePassword', { id: 'a', password: {} })).rejects.toThrow(/^WEBSITE_PASSWORDS_IO$/);
    await expect(invoke('updatePassword', { id: 'a', password: '' })).rejects.toThrow(/^WEBSITE_PASSWORDS_IO$/);
  });
  it('rejects WebUI requests and browser webviews for every account operation', async () => {
    mocks.sender.mockReturnValue(undefined);
    for (const name of mocks.handlers.keys()) {
      await expect(invoke(name, {})).rejects.toThrow('WEBSITE_PASSWORDS_FORBIDDEN');
    }
    mocks.sender.mockReturnValue({ ...sender, getType: () => 'webview' });
    await expect(invoke('list')).rejects.toThrow('WEBSITE_PASSWORDS_FORBIDDEN');
    expect(mocks.dialog).not.toHaveBeenCalled();
  });
  it('returns cancellation without reading or changing any vault', async () => {
    mocks.dialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await invoke('importChrome')).toMatchObject({ cancelled: true, added: 0, updated: 0, skipped: 0 });
  });
  it('imports only the native-picker file and returns no secret', async () => {
    const file = path.join(directory, 'chrome.csv');
    await writeFile(file, 'name,url,username,password\nX,https://x.test,a,private-value');
    mocks.dialog.mockResolvedValue({ canceled: false, filePaths: [file] });
    const response = await invoke('importChrome', { path: 'some-renderer-path' });
    expect(response).toMatchObject({ added: 1, status: { accounts: [{ username: 'a' }] } });
    expect(JSON.stringify(response)).not.toContain('private-value');
  });
  it('returns stable sanitized errors for filesystem failures', async () => {
    mocks.dialog.mockResolvedValue({
      canceled: false,
      filePaths: [path.join(directory, 'private-name-does-not-exist.csv')],
    });
    await expect(invoke('importChrome')).rejects.toThrow(/^WEBSITE_PASSWORDS_IO$/);
  });
  it('rejects malformed management payloads', async () => {
    await expect(invoke('setEnabled', { enabled: 'yes' })).rejects.toThrow('WEBSITE_PASSWORDS_IO');
    await expect(invoke('remove', { id: {} })).rejects.toThrow('WEBSITE_PASSWORDS_IO');
  });
  it('rejects targets outside the built-in partition or owned by another window', () => {
    mocks.target.mockReturnValue({
      isDestroyed: () => false,
      getType: () => 'webview',
      session: {},
      hostWebContents: sender,
    });
    expect(() => attachWebsitePasswordTarget(7)).toThrow('WEBSITE_PASSWORDS_FORBIDDEN');
    mocks.target.mockReturnValue({
      isDestroyed: () => false,
      getType: () => 'webview',
      session: mocks.partition,
      hostWebContents: {},
    });
    expect(() => attachWebsitePasswordTarget(7)).toThrow('WEBSITE_PASSWORDS_FORBIDDEN');
  });
  it('validates inactive reports and detaches only their authenticated target', () => {
    const controller = getWebsitePasswordRuntime().controller;
    const attach = vi.spyOn(controller, 'attach').mockImplementation(() => {});
    const detach = vi.spyOn(controller, 'detach').mockImplementation(() => {});
    const target = {
      id: 7,
      isDestroyed: () => false,
      getType: () => 'webview',
      session: mocks.partition,
      hostWebContents: sender,
    };
    mocks.target.mockReturnValue(target);
    attachWebsitePasswordTarget(7, false);
    expect(attach).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledWith(7);
    mocks.sender.mockReturnValue(undefined);
    expect(() => attachWebsitePasswordTarget(7, false)).toThrow('WEBSITE_PASSWORDS_FORBIDDEN');
    mocks.sender.mockReturnValue(sender);
    mocks.target.mockReturnValue({ ...target, session: {} });
    expect(() => attachWebsitePasswordTarget(7, false)).toThrow('WEBSITE_PASSWORDS_FORBIDDEN');
    mocks.target.mockReturnValue({ ...target, hostWebContents: {} });
    expect(() => attachWebsitePasswordTarget(7, false)).toThrow('WEBSITE_PASSWORDS_FORBIDDEN');
    expect(detach).toHaveBeenCalledTimes(1);
    attach.mockRestore();
    detach.mockRestore();
  });
});
