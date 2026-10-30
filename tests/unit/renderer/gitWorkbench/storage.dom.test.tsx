import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
  shelfList: vi.fn(),
  shelfRead: vi.fn(),
  shelfApply: vi.fn(),
  historyList: vi.fn(),
  historyStatus: vi.fn(),
  historyCompare: vi.fn(),
  historyRestore: vi.fn(),
}));
vi.mock('@/common/adapter/ipcBridge', () => ({
  gitStorage: Object.fromEntries(Object.entries(api).map(([key, invoke]) => [key, { invoke }])),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { Shelves } from '@/renderer/pages/conversation/SourceControl/Workbench/Storage/Shelves';
import { LocalHistory } from '@/renderer/pages/conversation/SourceControl/Workbench/Storage/LocalHistory';
const scope = { projectId: 'p', peId: 'r', relativePath: '' };
const label = (key: string) => `conversation.gitWorkbench.storage.${key}`;
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('storage views', () => {
  it('keeps the shelf visible after an apply conflict', async () => {
    api.shelfList.mockResolvedValue([
      {
        id: 's',
        name: 'Saved edits',
        createdAt: 1,
        deleted: false,
        files: [{ path: 'a', status: 'M', binary: false }],
      },
    ]);
    api.shelfRead.mockResolvedValue({ patch: 'diff --git a/a b/a' });
    api.shelfApply.mockResolvedValue({ applied: false, conflicts: true, message: 'Conflict retained' });
    render(<Shelves scope={scope} paths={[]} />);
    fireEvent.click(await screen.findByText('Saved edits'));
    fireEvent.click(await screen.findByRole('button', { name: label('apply') }));
    expect(await screen.findByText('Conflict retained')).toBeVisible();
    expect(screen.getByText('Saved edits')).toBeVisible();
  });
  it('sends the displayed file fingerprint only after restore confirmation', async () => {
    api.historyList.mockResolvedValue([{ id: 'e', createdAt: 1, kind: 'save', files: [{ path: 'a', after: 'old' }] }]);
    api.historyStatus.mockResolvedValue({ recording: true, limited: false, errors: [], fileCount: 1 });
    api.historyCompare.mockResolvedValue({
      before: { exists: true, contentBase64: 'b2xk', size: 3, fingerprint: 'old' },
      current: { exists: true, contentBase64: 'bmV3', size: 3, fingerprint: 'current' },
    });
    api.historyRestore.mockResolvedValue({ restored: ['a'], recoveryId: 'recovery' });
    render(<LocalHistory scope={scope} />);
    fireEvent.click(await screen.findByRole('button', { name: /a$/ }));
    fireEvent.click(await screen.findByRole('button', { name: label('restoreFile') }));
    expect(api.historyRestore).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'common.confirm' }));
    await waitFor(() =>
      expect(api.historyRestore).toHaveBeenCalledWith({
        scope,
        request: { id: 'e', paths: ['a'], expected: { a: 'current' } },
      })
    );
  });
  it('shows bounded recording and per-file read failures without hiding history', async () => {
    api.historyList.mockResolvedValue([]);
    api.historyStatus.mockResolvedValue({
      recording: true,
      limited: true,
      errors: ['Unable to enumerate src'],
      fileCount: 2000,
    });
    render(<LocalHistory scope={scope} />);

    expect(await screen.findByText(label('recordingLimited'))).toBeVisible();
    expect(screen.getByText('Unable to enumerate src')).toBeVisible();
  });
  it('shows a retryable load failure for local history', async () => {
    api.historyList.mockRejectedValueOnce(new Error('history permission denied'));
    api.historyList.mockResolvedValueOnce([]);
    api.historyStatus.mockResolvedValue({ recording: true, limited: false, errors: [], fileCount: 0 });
    render(<LocalHistory scope={scope} />);

    expect(await screen.findByText('history permission denied')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    await waitFor(() => expect(api.historyList).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(label('noHistory'))).toBeVisible();
  });
});
