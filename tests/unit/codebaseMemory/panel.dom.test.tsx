import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodebaseMemoryStatus } from '@/common/types/codebaseMemory/types';
import CodebaseMemoryPanel from '@/renderer/pages/conversation/CodebaseMemory';

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), start: vi.fn(), cancel: vi.fn(), openLens: vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: { codebaseMemory: Object.fromEntries(Object.entries(api).map(([key, invoke]) => [key, { invoke }])) },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const key = (name: string) => `conversation.codebaseMemory.${name}`;
const status = (repoPath = 'D:/one', extra: Partial<CodebaseMemoryStatus> = {}): CodebaseMemoryStatus => ({
  repoPath,
  config: { version: 1, enabled: false, mode: 'fast' },
  available: true,
  phase: 'idle',
  log: '',
  ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockImplementation(async ({ repoPath }) => status(repoPath));
  api.save.mockImplementation(async ({ repoPath, config }) => status(repoPath, { config }));
  api.start.mockResolvedValue(
    status('D:/one', { phase: 'running', config: { version: 1, enabled: true, mode: 'fast' } })
  );
  api.cancel.mockResolvedValue(status('D:/one', { phase: 'cancelled' }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('project architecture panel', () => {
  it('opens Lens for the selected initialized folder and prevents duplicate clicks', async () => {
    const ready = status('D:/two', { phase: 'succeeded', config: { version: 1, enabled: true, mode: 'fast' } });
    api.get.mockResolvedValue(ready);
    const opening = deferred<CodebaseMemoryStatus>();
    api.openLens.mockReturnValue(opening.promise);
    render(<CodebaseMemoryPanel repoPaths={{ two: 'D:/two' }} />);
    const button = await screen.findByRole('button', { name: key('openLens') });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.openLens).toHaveBeenCalledExactlyOnceWith({ repoPath: 'D:/two' });
    await act(async () => opening.resolve(ready));
    expect(screen.getByText(key('phase.succeeded'))).toBeInTheDocument();
  });
  it('shows Lens launch errors and permits retry', async () => {
    api.get.mockResolvedValue(
      status('D:/one', { phase: 'succeeded', config: { version: 1, enabled: true, mode: 'fast' } })
    );
    api.openLens.mockRejectedValue(new Error('Lens startup timed out'));
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    const button = await screen.findByRole('button', { name: key('openLens') });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByText('Lens startup timed out')).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });
  it.each(['idle', 'running', 'failed', 'cancelled'] as const)(
    'requires a completed index before opening Lens (%s)',
    async (phase) => {
      api.get.mockResolvedValue(status('D:/one', { phase, config: { version: 1, enabled: true, mode: 'fast' } }));
      render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
      expect(await screen.findByRole('button', { name: key('openLens') })).toBeDisabled();
      expect(api.openLens).not.toHaveBeenCalled();
    }
  );
  it('does not save on mount or enable indexing until the changed config is explicitly saved', async () => {
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    const toggle = await screen.findByRole('switch');
    expect(screen.getByRole('button', { name: key('start') })).toBeDisabled();
    fireEvent.click(toggle);
    expect(api.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: key('start') })).not.toBeDisabled());
  });
  it('shows missing bundled executable and prevents indexing', async () => {
    api.get.mockResolvedValue(status('D:/one', { available: false }));
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    expect(await screen.findByText(key('unavailable'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: key('start') })).toBeDisabled();
  });
  it('keeps invalid config errors visible and prevents overwriting an unreadable config', async () => {
    api.get.mockRejectedValue(new Error('Invalid configuration'));
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    expect(await screen.findByText('Invalid configuration')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
    expect(api.save).not.toHaveBeenCalled();
  });
  it('shows start failures without a success status', async () => {
    api.get.mockResolvedValue(status('D:/one', { config: { version: 1, enabled: true, mode: 'fast' } }));
    api.start.mockRejectedValue(new Error('Native index failed'));
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    await waitFor(() => expect(screen.getByRole('button', { name: key('start') })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: key('start') }));
    expect(await screen.findByText('Native index failed')).toBeInTheDocument();
    expect(screen.queryByText(key('phase.succeeded'))).not.toBeInTheDocument();
  });
  it('cancels a running job and prevents duplicate actions', async () => {
    api.get.mockResolvedValue(status('D:/one', { phase: 'running', log: 'Parsing source' }));
    const cancellation = deferred<CodebaseMemoryStatus>();
    api.cancel.mockReturnValue(cancellation.promise);
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    const cancel = await screen.findByRole('button', { name: 'common.cancel' });
    fireEvent.click(cancel);
    fireEvent.click(cancel);
    expect(api.cancel).toHaveBeenCalledTimes(1);
    await act(async () => cancellation.resolve(status('D:/one', { phase: 'cancelled' })));
    expect(await screen.findByText(key('phase.cancelled'))).toBeInTheDocument();
  });
  it('ignores a stale folder response after the project roots change', async () => {
    const old = deferred<CodebaseMemoryStatus>();
    api.get.mockImplementation(({ repoPath }) =>
      repoPath === 'D:/one' ? old.promise : Promise.resolve(status(repoPath, { log: 'Second folder' }))
    );
    const view = render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    view.rerender(<CodebaseMemoryPanel repoPaths={{ two: 'D:/two' }} />);
    const output = await screen.findByRole('button', { name: key('output') });
    expect(output).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(output);
    expect(await screen.findByText('Second folder')).toBeInTheDocument();
    await act(async () => old.resolve(status('D:/one', { log: 'Stale folder' })));
    expect(screen.queryByText('Stale folder')).not.toBeInTheDocument();
  });
  it('polls a running job when hidden and stops after unmount', async () => {
    vi.useFakeTimers();
    api.get.mockResolvedValue(status('D:/one', { phase: 'running' }));
    const view = render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} visible={false} />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(api.get.mock.calls.length).toBeGreaterThan(1);
    view.unmount();
    const count = api.get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(api.get).toHaveBeenCalledTimes(count);
  });
  it('does not invoke desktop APIs in the browser', () => {
    const original = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined });
    try {
      render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
      expect(screen.getByText(key('desktopOnly'))).toBeInTheDocument();
      expect(api.get).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'electronAPI', { configurable: true, value: original });
    }
  });
  it('clears a read error after a successful reload', async () => {
    api.get.mockRejectedValueOnce(new Error('Unreadable config'));
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    await screen.findByText('Unreadable config');
    fireEvent.click(screen.getByRole('button', { name: key('reload') }));
    await waitFor(() => expect(screen.queryByText('Unreadable config')).not.toBeInTheDocument());
  });
  it('preserves an explicit disabled setting when saved', async () => {
    api.get.mockResolvedValue(status('D:/one', { config: { version: 1, enabled: true, mode: 'full' } }));
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked());
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        repoPath: 'D:/one',
        config: { version: 1, enabled: false, mode: 'full' },
      })
    );
    expect(screen.getByRole('button', { name: key('start') })).toBeDisabled();
  });
  it('retains unsaved edits and reports a failed save', async () => {
    api.save.mockRejectedValue(new Error('Permission denied'));
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    await waitFor(() => expect(screen.getByRole('switch')).not.toBeDisabled());
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(await screen.findByText('Permission denied')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByRole('button', { name: key('start') })).toBeDisabled();
  });
  it('accepts a saved configuration while retaining an earlier index failure', async () => {
    api.save.mockImplementation(async ({ repoPath, config }) =>
      status(repoPath, { config, phase: 'failed', error: 'Previous index failed' })
    );
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    await waitFor(() => expect(screen.getByRole('switch')).not.toBeDisabled());
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('combobox', { name: key('mode') }));
    fireEvent.click(await screen.findByText(key('modes.full')));
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await screen.findByText('Previous index failed');
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByRole('combobox', { name: key('mode') })).toHaveTextContent(key('modes.full'));
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
  });
  it('uses the folder chosen in the multi-root selector', async () => {
    api.get.mockImplementation(async ({ repoPath }) => status(repoPath, { log: `${repoPath} output` }));
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one', two: 'D:/two' }} />);
    fireEvent.click(await screen.findByRole('button', { name: key('output') }));
    await screen.findByText('D:/one output');
    fireEvent.click(screen.getByRole('combobox', { name: key('folder') }));
    fireEvent.click(await screen.findByText('D:/two'));
    fireEvent.click(await screen.findByRole('button', { name: key('output') }));
    expect(await screen.findByText('D:/two output')).toBeInTheDocument();
    expect(screen.queryByText('D:/one output')).not.toBeVisible();
  });
  it('does not let a stale poll overwrite a newer start response', async () => {
    vi.useFakeTimers();
    const old = deferred<CodebaseMemoryStatus>();
    api.get
      .mockResolvedValueOnce(status('D:/one', { config: { version: 1, enabled: true, mode: 'fast' } }))
      .mockReturnValueOnce(old.promise);
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    fireEvent.click(screen.getByRole('button', { name: key('start') }));
    await act(async () => {});
    await act(async () => old.resolve(status('D:/one', { phase: 'idle' })));
    expect(screen.getByText(key('phase.running'))).toBeInTheDocument();
  });
  it('loads a hidden panel during React effect replay without getting stuck', async () => {
    render(
      <React.StrictMode>
        <CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} visible={false} />
      </React.StrictMode>
    );
    expect(await screen.findByText(key('phase.idle'))).toBeInTheDocument();
  });
  it('does not show previous success when a later update fails', async () => {
    api.get.mockResolvedValue(
      status('D:/one', {
        phase: 'succeeded',
        summary: 'Old successful index',
        config: { version: 1, enabled: true, mode: 'fast' },
      })
    );
    api.start.mockRejectedValue(new Error('Update failed'));
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    await screen.findByText(key('phase.succeeded'));
    fireEvent.click(screen.getByRole('button', { name: key('start') }));
    await screen.findByText('Update failed');
    expect(screen.queryByText(key('phase.succeeded'))).not.toBeInTheDocument();
    expect(screen.queryByText('Old successful index')).not.toBeInTheDocument();
  });
  it('hides previous success when starting resolves with an error', async () => {
    const previous = status('D:/one', {
      phase: 'succeeded',
      summary: 'Previous index summary',
      config: { version: 1, enabled: true, mode: 'fast' },
    });
    api.get.mockResolvedValue(previous);
    api.start.mockResolvedValue({ ...previous, error: 'Index lock is busy' });
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    await screen.findByText(key('phase.succeeded'));
    fireEvent.click(screen.getByRole('button', { name: key('start') }));
    await screen.findByText('Index lock is busy');
    expect(screen.queryByText(key('phase.succeeded'))).not.toBeInTheDocument();
    expect(screen.queryByText('Previous index summary')).not.toBeInTheDocument();
  });
  it('hides success and summary when a polled status contains an error', async () => {
    api.get.mockResolvedValue(
      status('D:/one', { phase: 'succeeded', error: 'Indexer unavailable', summary: 'Obsolete summary' })
    );
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one' }} />);
    await screen.findByText('Indexer unavailable');
    expect(screen.queryByText(key('phase.succeeded'))).not.toBeInTheDocument();
    expect(screen.queryByText('Obsolete summary')).not.toBeInTheDocument();
  });
  it('continues polling a running folder after another folder is selected', async () => {
    vi.useFakeTimers();
    api.get.mockImplementation(async ({ repoPath }) =>
      status(repoPath, { phase: repoPath === 'D:/one' ? 'running' : 'idle' })
    );
    render(<CodebaseMemoryPanel repoPaths={{ one: 'D:/one', two: 'D:/two' }} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('combobox', { name: key('folder') }));
    fireEvent.click(screen.getByText('D:/two'));
    await act(async () => {});
    const previous = api.get.mock.calls.filter(([arg]) => arg.repoPath === 'D:/one').length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(api.get.mock.calls.filter(([arg]) => arg.repoPath === 'D:/one').length).toBeGreaterThan(previous);
  });
});
