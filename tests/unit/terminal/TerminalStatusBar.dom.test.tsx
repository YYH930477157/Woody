import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { TerminalConnection } from '../../../packages/desktop/src/common/types/terminal';
import TerminalStatusBar from '../../../packages/desktop/src/renderer/pages/terminal/components/TerminalStatusBar';

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
});
