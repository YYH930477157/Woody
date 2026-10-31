/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

type WorkspaceDecisionDeps = {
  /** Resolves with the renderer's answer; true lets the close continue. */
  confirm: () => Promise<boolean>;
  /** Whether a prompt is waiting on the user. Never settling or rejecting means the renderer is gone. */
  isPromptOpen: () => Promise<boolean>;
  logWarn: (message: string, error?: unknown) => void;
  timeoutMs?: number;
  probeIntervalMs?: number;
};

const UNANSWERED = Symbol('unanswered');

/**
 * How long a renderer may stay silent, and how long it may run without showing a prompt, before the close goes on
 * regardless. Neither limit applies while a prompt is open: the user may take as long as they need.
 */
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_PROBE_INTERVAL_MS = 1000;

const withinTimeout = async <T>(work: Promise<T>, timeoutMs: number): Promise<T | typeof UNANSWERED> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof UNANSWERED>((resolve) => {
    timer = setTimeout(() => resolve(UNANSWERED), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Wait for the user's workspace decision. A fixed deadline cannot tell a hung renderer from a dialog on screen, so
 * the renderer is probed instead: a stuck one fails open and the window stays closable, while a responsive one with
 * a prompt open is waited for without limit. Always settles, and never rejects.
 */
export function waitForWorkspaceDecision({
  confirm,
  isPromptOpen,
  logWarn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
}: WorkspaceDecisionDeps): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline = Date.now() + timeoutMs;

    const settle = (decision: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(decision);
    };
    const giveUp = (reason: string, error?: unknown): void => {
      if (settled) return;
      logWarn(`[Workspace] ${reason}; closing without a decision`, error);
      settle(true);
    };
    const probe = (): void => {
      withinTimeout(isPromptOpen(), timeoutMs).then(
        (open) => {
          if (settled) return;
          if (open === UNANSWERED) {
            giveUp('The renderer stopped responding');
            return;
          }
          if (open) deadline = Date.now() + timeoutMs;
          else if (Date.now() >= deadline) {
            giveUp('The renderer showed no prompt in time');
            return;
          }
          timer = setTimeout(probe, probeIntervalMs);
        },
        (error: unknown) => giveUp('The renderer is gone', error)
      );
    };

    confirm().then(
      (decision) => settle(Boolean(decision)),
      (error: unknown) => giveUp('Close confirmation failed', error)
    );
    timer = setTimeout(probe, probeIntervalMs);
  });
}
