/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

type BeforeQuitEvent = {
  preventDefault: () => void;
};

type QuitCleanupDeps = {
  confirmQuit?: () => Promise<boolean>;
  onBeforeQuit: (handler: (event: BeforeQuitEvent) => void) => void;
  quitApp: () => void;
  setIsQuitting: (value: boolean) => void;
  markExplicitQuit: () => void;
  destroyTray: () => void;
  disposeCronResumeListener: () => void;
  stopBackend: () => Promise<void>;
  destroyPetWindow: () => Promise<void> | void;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  logError: (message: string, error: unknown) => void;
  timeoutMs?: number;
};

const DEFAULT_QUIT_CLEANUP_TIMEOUT_MS = 10_000;

async function runWithTimeout(
  work: Promise<void>,
  timeoutMs: number,
  logWarn: (message: string) => void
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      logWarn('[AionUi] Cleanup timed out after 10s, forcing quit');
      resolve();
    }, timeoutMs);
  });

  await Promise.race([work, timeout]);
  if (!timedOut && timeoutId) {
    clearTimeout(timeoutId);
  }
}

async function runQuitCleanup(deps: QuitCleanupDeps): Promise<void> {
  deps.logInfo('[AionUi] before-quit');
  deps.setIsQuitting(true);
  deps.markExplicitQuit();
  deps.destroyTray();

  const cleanup = async () => {
    deps.disposeCronResumeListener();

    await deps.stopBackend().catch((err) => deps.logError('[App] Failed to stop backend:', err));

    try {
      await deps.destroyPetWindow();
    } catch {
      /* pet not initialized */
    }
  };

  await runWithTimeout(cleanup(), deps.timeoutMs ?? DEFAULT_QUIT_CLEANUP_TIMEOUT_MS, deps.logWarn);
}

export function installQuitCleanup(deps: QuitCleanupDeps): void {
  let cleanupStarted = false;
  let cleanupCompleted = false;

  deps.onBeforeQuit((event) => {
    if (cleanupCompleted) {
      return;
    }

    event.preventDefault();
    if (cleanupStarted) {
      return;
    }

    cleanupStarted = true;
    const finish = (): void => {
      void runQuitCleanup(deps).finally(() => {
        cleanupCompleted = true;
        deps.quitApp();
      });
    };
    if (deps.confirmQuit) {
      void deps
        .confirmQuit()
        .then((confirmed) => {
          if (confirmed) finish();
          else {
            cleanupStarted = false;
            deps.setIsQuitting(false);
          }
        })
        .catch((error) => {
          cleanupStarted = false;
          deps.setIsQuitting(false);
          deps.logError('[Workspace] Quit confirmation failed', error);
        });
    } else finish();
  });
}
