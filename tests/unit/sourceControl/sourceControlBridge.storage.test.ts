import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providers: {} as Record<string, (input: never) => Promise<unknown>>,
  http: vi.fn(),
  sender: vi.fn(),
  lifetime: { set: vi.fn() },
  service: {
    shelfList: vi.fn(),
    shelfDelete: vi.fn(),
    historyStart: vi.fn(),
    historyStop: vi.fn(),
    dispose: vi.fn(),
  },
  quit: [] as (() => Promise<void>)[],
  options: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => 'D:/user-data' } }));
vi.mock('@/common/adapter/ipcBridge', () => ({
  gitStorage: new Proxy(
    {},
    {
      get: (_target, key: string) => ({
        provider: (handler: (input: never) => Promise<unknown>) => {
          mocks.providers[key] = handler;
        },
      }),
    }
  ),
}));
vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: mocks.http }));
vi.mock('@/common/adapter/main', () => ({ getNativeBridgeSender: mocks.sender }));
vi.mock('@process/services/sourceControl/workbench/workspace', () => ({ createProjectRootResolver: () => vi.fn() }));
vi.mock('@process/services/sourceControl/workbench/storage', () => ({
  createGitStorageService: (options: unknown) => {
    mocks.options(options);
    return mocks.service;
  },
}));
vi.mock('@process/startup/quitCleanup', () => ({
  onConfirmedQuit: (handler: () => Promise<void>) => mocks.quit.push(handler),
}));
vi.mock('@process/bridge/sourceControlBridge/runtime', () => ({ getGitBridgeRuntime: vi.fn() }));
vi.mock('@process/bridge/sourceControlBridge/lifecycle', () => ({ createRecorderLifecycle: () => mocks.lifetime }));

import { initGitStorageBridge } from '@process/bridge/sourceControlBridge/storage';

const scope = { projectId: 'p', peId: 'r', relativePath: '' };
const project = {
  project_id: 'p',
  explorer: {
    entries: [
      { pe_id: 'a', runtime_status: 'available' },
      { pe_id: 'gone', runtime_status: 'missing' },
      { pe_id: 'b', runtime_status: 'available' },
    ],
  },
};
const window = (id = 1) => {
  const destroyed = { value: false };
  const onDestroyed: (() => void)[] = [];
  const sender = {
    id,
    isDestroyed: () => destroyed.value,
    once: vi.fn((_event: string, listener: () => void) => onDestroyed.push(listener)),
  };
  return {
    sender,
    close: () => {
      destroyed.value = true;
      for (const listener of onDestroyed) listener();
    },
  };
};
const track = (projectId: string | null) => mocks.providers.historyTrack({ projectId } as never);
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.quit.length = 0;
  mocks.http.mockResolvedValue(project);
  mocks.lifetime.set.mockResolvedValue(undefined);
  mocks.service.dispose.mockResolvedValue(undefined);
  mocks.sender.mockReturnValue(window().sender);
  initGitStorageBridge(Promise.resolve({ git: vi.fn(), coordinator: { run: vi.fn() } } as never));
});

describe('git storage bridge', () => {
  it('keeps storage in the user data folder', async () => {
    await mocks.providers.shelfList({ scope } as never);

    expect(mocks.options).toHaveBeenCalledWith(
      expect.objectContaining({ storeDir: expect.stringContaining('git-storage') })
    );
  });

  it('passes every argument through to the service', async () => {
    await mocks.providers.shelfDelete({ scope, id: 's', permanently: true } as never);

    expect(mocks.service.shelfDelete).toHaveBeenCalledWith(scope, 's', true);
  });

  it('reports a missing Git on each call, without an unhandled failure at startup', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    initGitStorageBridge(Promise.reject(new Error('Git is not available')));
    await settle();

    await expect(mocks.providers.shelfList({ scope } as never)).rejects.toThrow('Git is not available');
    await expect(track('p')).rejects.toThrow('Git is not available');
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('records every available folder of the project', async () => {
    await track('p');

    expect(mocks.lifetime.set).toHaveBeenCalledWith(1, [
      { projectId: 'p', peId: 'a', relativePath: '' },
      { projectId: 'p', peId: 'b', relativePath: '' },
    ]);
  });

  it('stops recording when no project is open', async () => {
    await track(null);

    expect(mocks.http).not.toHaveBeenCalled();
    expect(mocks.lifetime.set).toHaveBeenCalledWith(1, []);
  });

  it('escapes the project id in the request path', async () => {
    await track('a/b');

    expect(mocks.http).toHaveBeenCalledWith('GET', '/api/projects/a%2Fb');
  });

  it('refuses a request with unexpected fields', async () => {
    await expect(mocks.providers.historyTrack({ projectId: 'p', extra: 1 } as never)).rejects.toThrow();
  });

  it('refuses a request from no window', async () => {
    mocks.sender.mockReturnValue(undefined);

    await expect(track('p')).rejects.toThrow(/desktop window/);
  });

  it('lets a newer request win over one still loading', async () => {
    await track(null);
    mocks.lifetime.set.mockClear();
    let answer = (_value: unknown): void => undefined;
    mocks.http.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));

    const older = track('p');
    await settle();
    await track(null);
    answer(project);
    await older;

    expect(mocks.lifetime.set).toHaveBeenCalledOnce();
    expect(mocks.lifetime.set).toHaveBeenCalledWith(1, []);
  });

  it('ignores a project that loads after the window closed', async () => {
    const closing = window(2);
    mocks.sender.mockReturnValue(closing.sender);
    let answer = (_value: unknown): void => undefined;
    mocks.http.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));

    const request = track('p');
    await settle();
    closing.close();
    answer(project);
    await request;
    await settle();

    expect(mocks.lifetime.set.mock.calls).toEqual([[2, []]]);
  });

  it('releases the folders of a closed window, once', async () => {
    const closing = window(3);
    mocks.sender.mockReturnValue(closing.sender);
    await track('p');
    await track('p');
    expect(closing.sender.once).toHaveBeenCalledOnce();

    closing.close();
    await settle();

    expect(mocks.lifetime.set).toHaveBeenLastCalledWith(3, []);
  });

  it('tracks each window on its own', async () => {
    const first = window(4);
    const second = window(5);
    mocks.sender.mockReturnValue(first.sender);
    await track('p');
    mocks.sender.mockReturnValue(second.sender);
    await track(null);

    expect(mocks.lifetime.set.mock.calls.map(([id]) => id)).toEqual([4, 5]);
  });

  it('flushes history on quit', async () => {
    await mocks.quit[0]();

    expect(mocks.service.dispose).toHaveBeenCalledOnce();
  });

  it('does not stop quitting when the flush fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.service.dispose.mockRejectedValue(new Error('disk full'));

    await expect(mocks.quit[0]()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
