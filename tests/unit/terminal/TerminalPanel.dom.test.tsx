import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TerminalConnection, TerminalProfile, TerminalSendResult } from '@/common/types/terminal';
import TerminalPanel from '../../../packages/desktop/src/renderer/pages/terminal/TerminalPanel';

const mocks = vi.hoisted(() => ({
  owner: 'ai' as 'ai' | 'manual',
  send: vi.fn().mockResolvedValue({ status: 'completed', writtenBytes: 3 }),
  takeover: vi.fn().mockResolvedValue(undefined),
  profiles: [] as TerminalProfile[],
  connections: [] as TerminalConnection[],
  saveProfile: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  report: vi.fn(),
  setSelectedId: vi.fn(),
  refreshConnections: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));
vi.mock('../../../packages/desktop/src/common', () => ({
  ipcBridge: {
    terminal: {
      send: { invoke: mocks.send },
      takeover: { invoke: mocks.takeover },
      saveProfile: { invoke: mocks.saveProfile },
      open: { invoke: mocks.open },
      close: { invoke: mocks.close },
    },
  },
}));
vi.mock('../../../packages/desktop/src/renderer/pages/terminal/useTerminal', () => ({
  useTerminal: () => ({
    profiles: mocks.profiles,
    connections: mocks.connections,
    selectedId: 'shared-device',
    setSelectedId: mocks.setSelectedId,
    events: [],
    counters: { rx: 0, tx: 0 },
    lost: false,
    error: '',
    setError: vi.fn(),
    report: mocks.report,
    refreshProfiles: vi.fn().mockResolvedValue(undefined),
    refreshConnections: mocks.refreshConnections,
    refresh: vi.fn(),
    clear: vi.fn(),
    selected: {
      id: 'shared-device',
      owner: mocks.owner,
      status: 'open',
      createdAt: 1,
      profile: {
        id: 'device',
        kind: 'serial',
        name: 'Device',
        path: 'COM61',
        baudRate: 9600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        rtscts: false,
        xon: false,
        xoff: false,
      },
    },
  }),
}));

const input = () => screen.getByRole('textbox', { name: 'tools.terminal.input' });
const sendButton = () => screen.getByRole('button', { name: 'tools.terminal.send' });

describe('manual terminal controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.owner = 'ai';
    mocks.profiles = [];
    mocks.connections = [];
    mocks.send.mockReset().mockResolvedValue({ status: 'completed', writtenBytes: 3 });
    mocks.saveProfile.mockReset().mockImplementation(async (profile: TerminalProfile) => profile);
    mocks.open.mockReset().mockResolvedValue({ id: 'new-session' });
    mocks.close.mockReset().mockResolvedValue(undefined);
    mocks.refreshConnections.mockResolvedValue(undefined);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addListener() {}, removeListener() {} }),
    });
  });
  afterEach(cleanup);
  it('keeps manual send disabled while AI controls the connection', () => {
    render(<TerminalPanel conversationId='chat' />);
    fireEvent.change(input(), { target: { value: '7E' } });
    expect(sendButton()).toBeDisabled();
    expect(screen.getAllByText('tools.terminal.aiControlling').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'tools.terminal.takeover' }));
    expect(mocks.takeover).toHaveBeenCalledWith({ id: 'shared-device' });
  });
  it('sends manual HEX without adding a hidden line ending', async () => {
    mocks.owner = 'manual';
    render(<TerminalPanel conversationId='chat' />);
    fireEvent.change(input(), { target: { value: '7E A0 21' } });
    fireEvent.click(sendButton());
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
    fireEvent.change(input(), { target: { value: '7E' } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText(/tools\.terminal\.writePending/)).toBeInTheDocument());
  });
  it('explains an incomplete HEX byte before anything is sent', () => {
    mocks.owner = 'manual';
    render(<TerminalPanel />);
    fireEvent.change(input(), { target: { value: '7E A' } });
    expect(screen.getByText('tools.terminal.hexOdd')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  const typeStraightToDevice = () => {
    fireEvent.click(screen.getByRole('button', { name: /tools\.terminal\.sendOptions/ }));
    fireEvent.click(screen.getByText('tools.terminal.inputMode_normal'));
    return screen.getByRole('textbox', { name: 'tools.terminal.input' });
  };
  const sentKeys = (data: string) =>
    expect(mocks.send).toHaveBeenCalledWith({ id: 'shared-device', request: expect.objectContaining({ data }) });

  it('sends Ctrl+H for Backspace while typing straight to a serial shell', async () => {
    mocks.owner = 'manual';
    render(<TerminalPanel />);
    fireEvent.keyDown(typeStraightToDevice(), { key: 'Backspace' });
    await waitFor(() => sentKeys('\b'));
  });

  it('sends DEL for Backspace when the device expects it', async () => {
    mocks.owner = 'manual';
    render(<TerminalPanel />);
    const keys = typeStraightToDevice();
    fireEvent.click(screen.getByText('tools.terminal.backspace_del'));
    fireEvent.keyDown(keys, { key: 'Backspace' });
    await waitFor(() => sentKeys('\x7f'));
  });

  it('sends arrow keys as VT sequences so shell history works', async () => {
    mocks.owner = 'manual';
    render(<TerminalPanel />);
    fireEvent.keyDown(typeStraightToDevice(), { key: 'ArrowUp' });
    await waitFor(() => sentKeys('\x1b[A'));
  });

  it('sends on Enter, clears the draft, and recalls it from history', async () => {
    mocks.owner = 'manual';
    render(<TerminalPanel />);
    fireEvent.change(input(), { target: { value: '0x68,0x16' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith({
        id: 'shared-device',
        request: { data: '68 16', encoding: 'hex', ending: 'none', wait: undefined },
      })
    );
    await waitFor(() => expect(input()).toHaveValue(''));
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input()).toHaveValue('0x68,0x16');
  });

  it('ignores repeated Enter in the same tick and while a send is pending', async () => {
    mocks.owner = 'manual';
    let finish!: (result: TerminalSendResult) => void;
    mocks.send.mockReturnValue(
      new Promise<TerminalSendResult>((resolve) => {
        finish = resolve;
      })
    );
    render(<TerminalPanel />);
    fireEvent.change(input(), { target: { value: '68 16' } });
    act(() => {
      fireEvent.keyDown(input(), { key: 'Enter' });
      fireEvent.keyDown(input(), { key: 'Enter' });
    });
    fireEvent.keyDown(input(), { key: 'Enter' });
    const requests = mocks.send.mock.calls.length;
    await act(async () => finish({ status: 'completed', writtenBytes: 2 }));
    expect(requests).toBe(1);
  });

  it.each(['7E A0', '68 16'])('keeps a draft edited during send, even when retyped as %s', async (next) => {
    mocks.owner = 'manual';
    let finish!: (result: TerminalSendResult) => void;
    mocks.send.mockReturnValueOnce(
      new Promise<TerminalSendResult>((resolve) => {
        finish = resolve;
      })
    );
    render(<TerminalPanel />);
    fireEvent.change(input(), { target: { value: '68 16' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.change(input(), { target: { value: '' } });
    fireEvent.change(input(), { target: { value: next } });
    await act(async () => finish({ status: 'completed', writtenBytes: 2 }));
    expect(input()).toHaveValue(next);
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input()).toHaveValue('68 16');
  });

  it('keeps the draft and permits retry after a rejected send', async () => {
    mocks.owner = 'manual';
    mocks.send.mockRejectedValueOnce(new Error('write failed'));
    render(<TerminalPanel />);
    fireEvent.change(input(), { target: { value: '68 16' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(sendButton()).not.toHaveClass('arco-btn-loading'));
    expect(input()).toHaveValue('68 16');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(input()).toHaveValue(''));
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  const setupOpenProfile = () => {
    const profile: TerminalProfile = {
      id: 'shell-profile',
      name: 'Shell profile',
      kind: 'shell',
      executable: 'old-shell.exe',
    };
    mocks.profiles = [profile];
    const id = crypto.randomUUID();
    mocks.connections = [{ id, profile, status: 'open', owner: 'manual', createdAt: 1 }];
    return id;
  };

  const saveAndConnect = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    fireEvent.change(await screen.findByDisplayValue('old-shell.exe'), { target: { value: 'new-shell.exe' } });
    fireEvent.click(screen.getByRole('button', { name: 'tools.terminal.saveAndConnect' }));
  };

  it('closes the old connection before opening the saved profile', async () => {
    const id = setupOpenProfile();
    let finishClose!: () => void;
    mocks.close.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishClose = resolve;
      })
    );
    render(<TerminalPanel />);
    await saveAndConnect();
    await waitFor(() => expect(mocks.close).toHaveBeenCalledWith({ id }));
    expect(mocks.open).not.toHaveBeenCalled();
    await act(async () => finishClose());
    await waitFor(() =>
      expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ executable: 'new-shell.exe' }))
    );
    expect(mocks.setSelectedId).toHaveBeenCalledWith('new-session');
  });

  it('refreshes connection state and reports a failure when reopening the saved profile fails', async () => {
    const id = setupOpenProfile();
    mocks.open.mockRejectedValueOnce(new Error('launch failed'));
    render(<TerminalPanel />);
    await saveAndConnect();
    await waitFor(() => expect(mocks.report).toHaveBeenCalledWith(new Error('launch failed')));
    expect(mocks.close).toHaveBeenCalledWith({ id });
    expect(mocks.refreshConnections).toHaveBeenCalled();
    expect(mocks.setSelectedId).not.toHaveBeenCalledWith('new-session');
    expect(screen.getAllByRole('button', { name: 'Shell profile' })).toHaveLength(2);
  });

  it('selects an existing session when its saved profile is clicked', () => {
    const id = setupOpenProfile();
    render(<TerminalPanel />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Shell profile' }).at(-1)!);
    expect(mocks.setSelectedId).toHaveBeenCalledWith(id);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('does not open a replacement if releasing the old connection fails', async () => {
    setupOpenProfile();
    mocks.close.mockRejectedValueOnce(new Error('close failed'));
    render(<TerminalPanel />);
    await saveAndConnect();
    await waitFor(() => expect(mocks.report).toHaveBeenCalledWith(new Error('close failed')));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.refreshConnections).toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: 'Shell profile' })).toHaveLength(2);
  });
});
