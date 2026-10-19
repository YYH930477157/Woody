import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EmailScanPage from '@/renderer/pages/emailScan';

const bridge = vi.hoisted(() => ({
  status: vi.fn(),
  sessions: vi.fn(),
  executed: new Set<() => void>(),
  updated: new Set<() => void>(),
  conversations: new Set<() => void>(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    todo: {
      status: { invoke: bridge.status },
      scanSessions: { invoke: bridge.sessions },
    },
    cron: {
      onJobExecuted: {
        on: (listener: () => void) => {
          bridge.executed.add(listener);
          return () => bridge.executed.delete(listener);
        },
      },
      onJobUpdated: {
        on: (listener: () => void) => {
          bridge.updated.add(listener);
          return () => bridge.updated.delete(listener);
        },
      },
    },
    conversation: {
      listChanged: {
        on: (listener: () => void) => {
          bridge.conversations.add(listener);
          return () => bridge.conversations.delete(listener);
        },
      },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

const session = (name: string) => ({ id: name, name, created_at: 1, updated_at: 1 });

beforeEach(() => {
  vi.clearAllMocks();
  bridge.status.mockResolvedValue({ source_ready: true, source_message: 'outlook' });
  bridge.sessions.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  bridge.executed.clear();
  bridge.updated.clear();
  bridge.conversations.clear();
});

describe('email scan live history', () => {
  it.each(['executed', 'updated', 'conversations'] as const)(
    'refreshes visible sessions and source status after a %s event',
    async (event) => {
      render(<EmailScanPage />);
      await screen.findByText('todo.emailScan.empty');
      bridge.sessions.mockResolvedValue([session('new scan')]);
      bridge.status.mockResolvedValue({ source_ready: false, source_message: 'updated source status' });

      act(() => bridge[event].forEach((listener) => listener()));

      expect(await screen.findByText('new scan')).toBeInTheDocument();
      expect(screen.getByText('updated source status')).toBeInTheDocument();
    }
  );

  it('removes deleted conversations from the visible history', async () => {
    bridge.sessions.mockResolvedValue([session('old scan')]);
    render(<EmailScanPage />);
    await screen.findByText('old scan');
    bridge.sessions.mockResolvedValue([]);

    act(() => bridge.conversations.forEach((listener) => listener()));

    expect(await screen.findByText('todo.emailScan.empty')).toBeInTheDocument();
    expect(screen.queryByText('old scan')).toBeNull();
  });

  it('does not let an older refresh overwrite the latest history', async () => {
    let finishOld!: (value: ReturnType<typeof session>[]) => void;
    bridge.sessions.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      })
    );
    render(<EmailScanPage />);
    await waitFor(() => expect(bridge.sessions).toHaveBeenCalledOnce());
    bridge.sessions.mockResolvedValue([session('latest scan')]);
    act(() => bridge.executed.forEach((listener) => listener()));
    await screen.findByText('latest scan');

    await act(async () => finishOld([session('stale scan')]));

    expect(screen.getByText('latest scan')).toBeInTheDocument();
    expect(screen.queryByText('stale scan')).toBeNull();
  });

  it('unsubscribes from background events on unmount', async () => {
    const { unmount } = render(<EmailScanPage />);
    await screen.findByText('todo.emailScan.empty');
    expect(bridge.executed.size).toBe(1);
    unmount();
    expect([bridge.executed.size, bridge.updated.size, bridge.conversations.size]).toEqual([0, 0, 0]);
  });
});
