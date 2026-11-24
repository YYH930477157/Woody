import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { TerminalConnection, TerminalEvent } from '../../../packages/desktop/src/common/types/terminal';
import TerminalStatusBar from '../../../packages/desktop/src/renderer/pages/terminal/components/TerminalStatusBar';
import { useTerminal } from '../../../packages/desktop/src/renderer/pages/terminal/useTerminal';

const bridge = vi.hoisted(() => ({
  profiles: vi.fn().mockResolvedValue([]),
  list: vi.fn().mockResolvedValue([]),
  read: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    terminal: {
      profiles: { invoke: bridge.profiles },
      list: { invoke: bridge.list },
      read: { invoke: bridge.read },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`),
  }),
}));

const serial: TerminalConnection = {
  id: 'serial-1',
  status: 'open',
  owner: 'manual',
  createdAt: 0,
  profile: {
    id: 'device',
    kind: 'serial',
    name: 'Device',
    path: 'COM3',
    baudRate: 115200,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    rtscts: false,
    xon: false,
    xoff: false,
  },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('terminal status bar', () => {
  it('shows connection time, totals, rates and frame counts for a serial link', () => {
    vi.useFakeTimers();
    vi.setSystemTime(65_000);
    const counters = { rx: 0, tx: 0, rxFrames: 0, txFrames: 0 };
    const { rerender } = render(<TerminalStatusBar connection={serial} counters={counters} />);
    expect(screen.getByText('1:05')).toBeInTheDocument();
    rerender(<TerminalStatusBar connection={serial} counters={{ rx: 3072, tx: 12, rxFrames: 4, txFrames: 2 }} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('3.0 KB')).toBeInTheDocument();
    expect(screen.getByText('3.0 KB/s')).toBeInTheDocument();
    expect(screen.getByText('tools.terminal.frameCount:4')).toBeInTheDocument();
    expect(screen.getByText('tools.terminal.frameCount:2')).toBeInTheDocument();
    expect(screen.getByText('1:06')).toBeInTheDocument();
  });

  it('shows only totals for a shell and no clock once closed', () => {
    render(
      <TerminalStatusBar
        connection={{ ...serial, status: 'closed', profile: { id: 'shell', kind: 'shell', name: 'Shell' } }}
        counters={{ rx: 20, tx: 3, rxFrames: 1, txFrames: 1 }}
      />
    );
    expect(screen.getByText('tools.terminal.closed')).toBeInTheDocument();
    expect(screen.getByText('20 B')).toBeInTheDocument();
    expect(screen.queryByText(/frameCount/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d:\d\d/)).not.toBeInTheDocument();
  });

  it('keeps closed serial rate at zero even when historical counters are non-zero', () => {
    render(
      <TerminalStatusBar
        connection={{ ...serial, status: 'closed' }}
        counters={{ rx: 1024, tx: 512, rxFrames: 2, txFrames: 1 }}
      />
    );
    expect(screen.getAllByText('0 B/s')).toHaveLength(2);
  });
});

describe('useTerminal frame gap resync', () => {
  const chunk = (cursor: number, timestamp: number): TerminalEvent => ({
    cursor,
    timestamp,
    direction: 'incoming',
    source: 'transport',
    data: Buffer.from('AB').toString('base64'),
    byteLength: 2,
  });

  it('recomputes serial frame counts when frameGapMs changes', async () => {
    bridge.list.mockResolvedValue([serial]);
    bridge.read
      .mockResolvedValueOnce({
        cursor: 6,
        lost: false,
        more: false,
        events: [chunk(2, 100), chunk(4, 140), chunk(6, 180)],
      })
      .mockResolvedValue({ cursor: 6, lost: false, more: false, events: [] });

    const { result, rerender } = renderHook(({ gap }) => useTerminal(gap), { initialProps: { gap: 30 } });
    act(() => result.current.setSelectedId(serial.id));
    await waitFor(() => expect(result.current.counters.rxFrames).toBe(3));

    rerender({ gap: 50 });
    expect(result.current.counters.rxFrames).toBe(1);
    expect(result.current.counters.rx).toBe(6);
  });

  it('reports read failures without resetting previously tallied counters', async () => {
    bridge.list.mockResolvedValue([serial]);
    bridge.read.mockRejectedValueOnce(new Error('read failed'));

    const { result } = renderHook(() => useTerminal(30));
    act(() => result.current.setSelectedId(serial.id));
    await waitFor(() => expect(result.current.error).toBe('read failed'));
  });
});
