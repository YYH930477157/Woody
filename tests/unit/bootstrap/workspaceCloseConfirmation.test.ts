import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForWorkspaceDecision } from '@process/startup/workspaceCloseConfirmation';

const never = <T>(): Promise<T> => new Promise<T>(() => {});

describe('waitForWorkspaceDecision', () => {
  const logWarn = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    logWarn.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const settledValue = (promise: Promise<boolean>) => {
    const seen: { value?: boolean } = {};
    void promise.then((value) => {
      seen.value = value;
    });
    return seen;
  };

  it('returns the answer as soon as the renderer gives one', async () => {
    const result = waitForWorkspaceDecision({
      confirm: async () => false,
      isPromptOpen: async () => false,
      logWarn,
    });

    await expect(result).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps waiting while the user has a prompt open, however long they take', async () => {
    let answer: (value: boolean) => void = () => {};
    const seen = settledValue(
      waitForWorkspaceDecision({
        confirm: () => new Promise<boolean>((resolve) => (answer = resolve)),
        isPromptOpen: async () => true,
        logWarn,
      })
    );

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(seen.value).toBeUndefined();

    answer(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.value).toBe(false);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('fails open when a responsive renderer never shows a prompt', async () => {
    const seen = settledValue(
      waitForWorkspaceDecision({ confirm: never, isPromptOpen: async () => false, logWarn, timeoutMs: 5000 })
    );

    await vi.advanceTimersByTimeAsync(4000);
    expect(seen.value).toBeUndefined();

    await vi.advanceTimersByTimeAsync(2000);
    expect(seen.value).toBe(true);
  });

  it('fails open when the renderer stops answering, even with a prompt on screen', async () => {
    let calls = 0;
    const seen = settledValue(
      waitForWorkspaceDecision({
        confirm: never,
        isPromptOpen: () => {
          calls += 1;
          return calls === 1 ? Promise.resolve(true) : never<boolean>();
        },
        logWarn,
        timeoutMs: 5000,
      })
    );

    await vi.advanceTimersByTimeAsync(8000);

    expect(seen.value).toBe(true);
    expect(logWarn).toHaveBeenCalledOnce();
  });

  it('fails open when the renderer is destroyed', async () => {
    const seen = settledValue(
      waitForWorkspaceDecision({
        confirm: never,
        isPromptOpen: () => Promise.reject(new Error('Object has been destroyed')),
        logWarn,
      })
    );

    await vi.advanceTimersByTimeAsync(1000);

    expect(seen.value).toBe(true);
  });

  it('fails open when the confirmation itself rejects', async () => {
    const result = waitForWorkspaceDecision({
      confirm: () => Promise.reject(new Error('script failed')),
      isPromptOpen: async () => false,
      logWarn,
    });

    await expect(result).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
