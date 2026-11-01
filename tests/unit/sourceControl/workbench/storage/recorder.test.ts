import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ capture: vi.fn(), watch: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  watch: mocks.watch,
}));
vi.mock('@process/services/sourceControl/workbench/storage/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@process/services/sourceControl/workbench/storage/history')>()),
  captureHistory: mocks.capture,
}));

import { createHistoryRecorder } from '@process/services/sourceControl/workbench/storage/recorder';

const scope = (peId = 'r') => ({ projectId: 'p', peId, relativePath: '' });
const log = vi.fn();
const context = { root: '/repo', dir: '/store', log };
const contexts = {
  resolve: vi.fn(async () => context),
  run: vi.fn(async (_scope: unknown, action: (value: typeof context) => Promise<unknown>) => action(context)),
};
const watcher = { close: vi.fn(), on: vi.fn() };
const recorder = (intervalMs = 1000) =>
  createHistoryRecorder(contexts as never, { recorderIntervalMs: intervalMs } as never);
const fileEvent = () => mocks.watch.mock.calls.at(-1)?.[2]();
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  mocks.capture.mockResolvedValue([]);
  mocks.watch.mockReturnValue(watcher);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('history recorder', () => {
  it('records once when it starts', async () => {
    const history = recorder();

    await history.start(scope());

    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(await history.status(scope())).toMatchObject({ recording: true, errors: [] });
    await history.dispose();
  });

  it('keeps one recording when started twice at once', async () => {
    const history = recorder();

    await Promise.all([history.start(scope()), history.start(scope())]);
    await history.start(scope());

    expect(mocks.watch).toHaveBeenCalledOnce();
    await history.dispose();
  });

  it('polls for changes that file events miss', async () => {
    const history = recorder();
    await history.start(scope());
    mocks.capture.mockClear();

    await tick(3100);

    expect(mocks.capture).toHaveBeenCalledTimes(3);
    await history.dispose();
  });

  it('never polls faster than a quarter of a second', async () => {
    const history = recorder(1);
    await history.start(scope());
    mocks.capture.mockClear();

    await tick(1000);

    expect(mocks.capture.mock.calls.length).toBeLessThanOrEqual(4);
    await history.dispose();
  });

  it('turns a burst of file events into one recording', async () => {
    const history = recorder(60_000);
    await history.start(scope());
    mocks.capture.mockClear();

    fileEvent();
    await tick(100);
    fileEvent();
    await tick(100);
    fileEvent();
    expect(mocks.capture).not.toHaveBeenCalled();

    await tick(300);

    expect(mocks.capture).toHaveBeenCalledOnce();
    await history.dispose();
  });

  it('never runs two recordings of one scope at the same time', async () => {
    const history = recorder();
    await history.start(scope());
    mocks.capture.mockClear();
    let finish = (): void => undefined;
    mocks.capture.mockReturnValue(new Promise<void>((resolve) => (finish = () => resolve())));

    await tick(5000);

    expect(mocks.capture).toHaveBeenCalledOnce();
    finish();
    await tick(0);
    await history.dispose();
  });

  it('keeps polling when the filesystem cannot be watched', async () => {
    mocks.watch.mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    const history = recorder();

    await history.start(scope());
    mocks.capture.mockClear();
    await tick(1100);

    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('bounded polling remains active'));
    expect(await history.status(scope())).toMatchObject({ recording: true });
    await history.dispose();
  });

  it('reports a watcher that fails later', async () => {
    const history = recorder();
    await history.start(scope());
    const onError = watcher.on.mock.calls.find(([name]) => name === 'error')?.[1];

    onError(new Error('EPERM'));

    expect((await history.status(scope())).errors).toEqual(['Error: EPERM']);
    await history.dispose();
  });

  it('reports a failed recording and keeps trying', async () => {
    const history = recorder();
    mocks.capture.mockRejectedValue(new Error('disk full'));

    await history.start(scope());
    expect((await history.status(scope())).errors).toEqual(['Error: disk full']);

    mocks.capture.mockClear();
    await tick(1100);
    expect(mocks.capture).toHaveBeenCalledOnce();
    await history.dispose();
  });

  it('clears the error once recording works again', async () => {
    const history = recorder();
    mocks.capture.mockRejectedValueOnce(new Error('disk full'));
    await history.start(scope());

    await tick(1100);

    expect((await history.status(scope())).errors).toEqual([]);
    await history.dispose();
  });

  it('keeps only the latest errors', async () => {
    const history = recorder();
    let attempt = 0;
    mocks.capture.mockImplementation(async () => {
      attempt += 1;
      throw new Error(`failure ${attempt}`);
    });
    await history.start(scope());

    await tick(40_000);

    const { errors } = await history.status(scope());
    expect(errors).toHaveLength(20);
    expect(errors.at(-1)).toBe(`Error: failure ${attempt}`);
    await history.dispose();
  });

  it('stops polling and watching', async () => {
    const history = recorder();
    await history.start(scope());
    mocks.capture.mockClear();

    await history.stop(scope());
    await tick(5000);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(watcher.close).toHaveBeenCalledOnce();
    expect(await history.status(scope())).toMatchObject({ recording: false });
    await history.dispose();
  });

  it('drops a pending file event when it stops', async () => {
    const history = recorder(60_000);
    await history.start(scope());
    mocks.capture.mockClear();

    fileEvent();
    await history.stop(scope());
    await tick(1000);

    expect(mocks.capture).not.toHaveBeenCalled();
    await history.dispose();
  });

  it('waits for a running recording before it reports stopped', async () => {
    const history = recorder();
    await history.start(scope());
    let finish = (): void => undefined;
    mocks.capture.mockReturnValue(new Promise<void>((resolve) => (finish = () => resolve())));
    await tick(1000);
    let stopped = false;

    const stopping = history.stop(scope()).then(() => {
      stopped = true;
    });
    await tick(0);
    expect(stopped).toBe(false);

    finish();
    await stopping;
    expect(stopped).toBe(true);
    await history.dispose();
  });

  it('can start again after stopping', async () => {
    const history = recorder();
    await history.start(scope());
    await history.stop(scope());

    await history.start(scope());

    expect(await history.status(scope())).toMatchObject({ recording: true });
    await history.dispose();
  });

  it('limits how many folders record at once', async () => {
    const history = recorder();
    for (let index = 0; index < 32; index++) await history.start(scope(`r${index}`));

    await expect(history.start(scope('one-too-many'))).rejects.toThrow(/limit/);
    await history.dispose();
  });

  it('refuses work after disposal', async () => {
    const history = recorder();
    await history.dispose();

    await expect(history.start(scope())).rejects.toThrow(/disposed/);
    await expect(history.capture(scope())).rejects.toThrow(/disposed/);
  });

  it('disposal stops everything that is recording', async () => {
    const history = recorder();
    await history.start(scope('a'));
    await history.start(scope('b'));
    mocks.capture.mockClear();

    await history.dispose();
    await tick(5000);

    expect(watcher.close).toHaveBeenCalledTimes(2);
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
