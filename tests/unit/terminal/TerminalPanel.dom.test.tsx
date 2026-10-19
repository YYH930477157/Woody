import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TerminalPanel from '../../../packages/desktop/src/renderer/pages/terminal/TerminalPanel';

const mocks = vi.hoisted(() => ({
  owner: 'ai' as 'ai' | 'manual',
  send: vi.fn().mockResolvedValue({ status: 'completed', writtenBytes: 3 }),
  takeover: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));
vi.mock('../../../packages/desktop/src/common', () => ({
  ipcBridge: {
    terminal: {
      send: { invoke: mocks.send },
      takeover: { invoke: mocks.takeover },
    },
  },
}));
vi.mock('../../../packages/desktop/src/renderer/pages/terminal/useTerminal', () => ({
  useTerminal: () => ({
    profiles: [],
    connections: [],
    selectedId: 'shared-device',
    setSelectedId: vi.fn(),
    events: [],
    lost: false,
    error: '',
    setError: vi.fn(),
    report: vi.fn(),
    clear: vi.fn(),
    selected: {
      id: 'shared-device',
      owner: mocks.owner,
      status: 'open',
      profile: {
        kind: 'serial',
        name: 'Device',
        path: 'COM61',
        baudRate: 9600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
      },
    },
  }),
}));

describe('manual terminal controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.owner = 'ai';
  });
  afterEach(cleanup);
  it('keeps manual send disabled while AI controls the connection', () => {
    render(<TerminalPanel conversationId='chat' />);
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.terminal.input' }), { target: { value: '7E' } });
    expect(screen.getByRole('button', { name: 'tools.terminal.send' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'tools.terminal.takeover' }));
    expect(mocks.takeover).toHaveBeenCalledWith({ id: 'shared-device' });
  });
  it('sends manual HEX without adding a hidden line ending', async () => {
    mocks.owner = 'manual';
    render(<TerminalPanel conversationId='chat' />);
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.terminal.input' }), { target: { value: '7E A0 21' } });
    fireEvent.click(screen.getByRole('button', { name: 'tools.terminal.send' }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith({
        id: 'shared-device',
        request: { data: '7E A0 21', encoding: 'hex', ending: 'none', wait: undefined },
      })
    );
  });
  it('warns when cancellation returns before an already issued native write completes', async () => {
    mocks.owner = 'manual';
    mocks.send.mockResolvedValueOnce({ status: 'cancelled', writtenBytes: 0, writePending: true });
    render(<TerminalPanel conversationId='chat' />);
    fireEvent.change(screen.getByRole('textbox', { name: 'tools.terminal.input' }), { target: { value: '7E' } });
    fireEvent.click(screen.getByRole('button', { name: 'tools.terminal.send' }));
    await waitFor(() => expect(screen.getByText(/tools\.terminal\.writePending/)).toBeInTheDocument());
  });
});
