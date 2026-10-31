/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { installQuitCleanup } from '@/process/startup/quitCleanup';

type BeforeQuitEvent = {
  preventDefault: () => void;
};

const flushMicrotasks = async () => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
};

describe('installQuitCleanup', () => {
  it('keeps the backend and window alive when workspace save confirmation is cancelled', async () => {
    let handler: ((event: BeforeQuitEvent) => void) | undefined;
    const stopBackend = vi.fn(async () => {});
    const quitApp = vi.fn();
    const setIsQuitting = vi.fn();
    installQuitCleanup({
      onBeforeQuit: (value) => {
        handler = value;
      },
      confirmQuit: async () => false,
      stopBackend,
      quitApp,
      setIsQuitting,
      markExplicitQuit: vi.fn(),
      destroyTray: vi.fn(),
      disposeCronResumeListener: vi.fn(),
      destroyPetWindow: vi.fn(),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    });
    handler?.({ preventDefault: vi.fn() });
    await flushMicrotasks();
    expect(stopBackend).not.toHaveBeenCalled();
    expect(quitApp).not.toHaveBeenCalled();
    expect(setIsQuitting).toHaveBeenCalledWith(false);
  });
  it('prevents the first quit until cleanup finishes, then requests quit again', async () => {
    const calls: string[] = [];
    let beforeQuitHandler: ((event: BeforeQuitEvent) => void) | undefined;
    let resolveStopBackend: (() => void) | undefined;

    const quitApp = vi.fn(() => calls.push('quit-app'));
    const stopBackend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          calls.push('stop-backend-start');
          resolveStopBackend = resolve;
        })
    );

    installQuitCleanup({
      onBeforeQuit: (handler) => {
        beforeQuitHandler = handler;
      },
      quitApp,
      setIsQuitting: (value) => calls.push(`set-quitting:${value}`),
      markExplicitQuit: () => calls.push('mark-explicit-quit'),
      destroyTray: () => calls.push('destroy-tray'),
      disposeCronResumeListener: () => calls.push('dispose-cron'),
      stopBackend,
      destroyPetWindow: () => calls.push('destroy-pet'),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    });

    const preventDefault = vi.fn();
    beforeQuitHandler?.({ preventDefault });
    await flushMicrotasks();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(quitApp).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'set-quitting:true',
      'mark-explicit-quit',
      'destroy-tray',
      'dispose-cron',
      'stop-backend-start',
    ]);

    resolveStopBackend?.();
    await flushMicrotasks();

    expect(quitApp).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      'set-quitting:true',
      'mark-explicit-quit',
      'destroy-tray',
      'dispose-cron',
      'stop-backend-start',
      'destroy-pet',
      'quit-app',
    ]);
  });

  it('continues the quit when the workspace confirmation never answers', async () => {
    let beforeQuitHandler: ((event: BeforeQuitEvent) => void) | undefined;
    const stopBackend = vi.fn(async () => {});
    const quitApp = vi.fn();
    const logWarn = vi.fn();

    installQuitCleanup({
      onBeforeQuit: (handler) => {
        beforeQuitHandler = handler;
      },
      // A stuck renderer never settles its confirmation; without the timeout every later quit is swallowed.
      confirmQuit: () => new Promise<boolean>(() => {}),
      confirmTimeoutMs: 5,
      quitApp,
      setIsQuitting: vi.fn(),
      markExplicitQuit: vi.fn(),
      destroyTray: vi.fn(),
      disposeCronResumeListener: vi.fn(),
      stopBackend,
      destroyPetWindow: vi.fn(),
      logInfo: vi.fn(),
      logWarn,
      logError: vi.fn(),
    });

    beforeQuitHandler?.({ preventDefault: vi.fn() });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await flushMicrotasks();

    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
    expect(stopBackend).toHaveBeenCalled();
    expect(quitApp).toHaveBeenCalled();
  });

  it('allows the second before-quit after cleanup has completed', async () => {
    let beforeQuitHandler: ((event: BeforeQuitEvent) => void) | undefined;

    installQuitCleanup({
      onBeforeQuit: (handler) => {
        beforeQuitHandler = handler;
      },
      quitApp: vi.fn(),
      setIsQuitting: vi.fn(),
      markExplicitQuit: vi.fn(),
      destroyTray: vi.fn(),
      disposeCronResumeListener: vi.fn(),
      stopBackend: async () => {},
      destroyPetWindow: vi.fn(),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    });

    beforeQuitHandler?.({ preventDefault: vi.fn() });
    await flushMicrotasks();

    const preventDefault = vi.fn();
    beforeQuitHandler?.({ preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
  });
});
