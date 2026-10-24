import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { stored, providers } = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  providers: new Map<string, (input?: unknown) => Promise<unknown>>(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    // Every channel the bridge registers records its provider under its own name.
    systemSettings: new Proxy(
      {},
      {
        get: (_target, name: string) => ({
          provider: (handler: (input?: unknown) => Promise<unknown>) => providers.set(name, handler),
          emit: vi.fn(),
        }),
      }
    ),
  },
}));

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: {
    get: vi.fn(async (key: string) => stored.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      stored.set(key, value);
    }),
  },
}));

vi.mock('@process/services/i18n', () => ({ changeLanguage: vi.fn(async () => {}) }));
vi.mock('@process/utils/tray', () => ({
  createOrUpdateTray: vi.fn(),
  destroyTray: vi.fn(),
  setCloseToTrayEnabled: vi.fn(),
}));
vi.mock('@process/utils/closeToTraySetting', () => ({
  readCloseToTraySetting: vi.fn(async () => false),
  writeCloseToTraySetting: vi.fn(async () => {}),
}));

import {
  SCM_GIT_BACKEND_ENV,
  initSystemSettingsBridge,
  publishScmGitBackend,
} from '@/process/bridge/systemSettingsBridge';

describe('system git setting for the Changes panel', () => {
  beforeEach(() => {
    stored.clear();
    providers.clear();
    delete process.env[SCM_GIT_BACKEND_ENV];
  });
  afterEach(() => {
    delete process.env[SCM_GIT_BACKEND_ENV];
  });

  it('tells the backend to use system git only when the setting is on', async () => {
    await publishScmGitBackend();
    expect(process.env[SCM_GIT_BACKEND_ENV]).toBeUndefined();

    stored.set('scm.systemGit', false);
    await publishScmGitBackend();
    expect(process.env[SCM_GIT_BACKEND_ENV]).toBeUndefined();

    stored.set('scm.systemGit', true);
    await publishScmGitBackend();
    expect(process.env[SCM_GIT_BACKEND_ENV]).toBe('cli');
  });

  it('keeps a backend chosen explicitly in the environment', async () => {
    process.env[SCM_GIT_BACKEND_ENV] = 'libgit2';
    stored.set('scm.systemGit', true);
    await publishScmGitBackend();
    expect(process.env[SCM_GIT_BACKEND_ENV]).toBe('libgit2');
  });

  it('stores the switch for the next start and reports it back off by default', async () => {
    initSystemSettingsBridge();
    const get = providers.get('getScmSystemGit');
    const set = providers.get('setScmSystemGit');
    expect(await get?.()).toBe(false);

    await set?.({ enabled: true });
    expect(stored.get('scm.systemGit')).toBe(true);
    expect(await get?.()).toBe(true);
    // Only the next start applies it: the running backend keeps its engine.
    expect(process.env[SCM_GIT_BACKEND_ENV]).toBeUndefined();
  });
});
