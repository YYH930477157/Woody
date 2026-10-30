import { describe, expect, it, vi } from 'vitest';
import { createRecorderLifecycle } from '@process/bridge/sourceControlBridge/lifecycle';
const a = { projectId: 'a', peId: 'root', relativePath: '' };
const b = { projectId: 'b', peId: 'root', relativePath: '' };
describe('opened project recorder ownership', () => {
  it('keeps a shared root recording until the last window releases it', async () => {
    const start = vi.fn(async () => {}),
      stop = vi.fn(async () => {});
    const life = createRecorderLifecycle({ resolveRoot: async () => 'shared', start, stop });
    await life.set(1, [a]);
    await life.set(2, [b]);
    await life.set(1, []);
    expect(stop).not.toHaveBeenCalled();
    await life.set(2, []);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('releases removed roots and retries failed starts without stale ownership', async () => {
    const start = vi.fn(async () => {}),
      stop = vi.fn(async () => {});
    const life = createRecorderLifecycle({ resolveRoot: async (s) => s.projectId, start, stop });
    await life.set(1, [a]);
    start.mockRejectedValueOnce(new Error('unreadable'));
    await expect(life.set(1, [b])).rejects.toThrow('unreadable');
    expect(stop).toHaveBeenCalledWith(a);
    await life.set(1, [b]);
    expect(start).toHaveBeenCalledTimes(3);
  });
  it('queues close after a pending start so no recorder leaks', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stop = vi.fn(async () => {});
    const life = createRecorderLifecycle({ resolveRoot: async () => 'a', start: async () => wait, stop });
    const opening = life.set(1, [a]);
    const closing = life.set(1, []);
    release();
    await opening;
    await closing;
    expect(stop).toHaveBeenCalledWith(a);
  });
});
