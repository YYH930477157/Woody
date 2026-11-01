import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  historyList: vi.fn(),
  historyStatus: vi.fn(),
  historyCompare: vi.fn(),
  historyRestore: vi.fn(),
  historyLabel: vi.fn(),
}));
vi.mock('@/common/adapter/ipcBridge', () => ({
  gitStorage: Object.fromEntries(Object.entries(api).map(([key, invoke]) => [key, { invoke }])),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { LocalHistory } from '@/renderer/pages/conversation/SourceControl/Workbench/Storage/LocalHistory';
import { deferred } from './fixtures';

const scope = { projectId: 'p', peId: 'r', relativePath: '' };
const text = (key: string) => `conversation.gitWorkbench.storage.${key}`;
const event = { id: 'e', createdAt: 1, label: 'before refactor', files: [{ path: 'src/a.ts' }] };
const base64 = (value: string | number[]) =>
  Buffer.from(typeof value === 'string' ? value : Uint8Array.from(value)).toString('base64');
const side = (value: string | number[], fingerprint = 'fp') => ({
  exists: true,
  fingerprint,
  size: value.length,
  contentBase64: base64(value),
});
const button = (name: string) => screen.getByRole('button', { name });
const dialog = () => within(screen.getByRole('dialog'));
const openFile = async () => {
  render(<LocalHistory scope={scope} />);
  fireEvent.click(await screen.findByRole('button', { name: 'src/a.ts' }));
  await screen.findByRole('button', { name: text('restoreFile') });
};
const restore = () => {
  fireEvent.click(button(text('restoreFile')));
  fireEvent.click(dialog().getByRole('button', { name: 'common.confirm' }));
};

beforeEach(() => {
  api.historyList.mockResolvedValue([event]);
  api.historyStatus.mockResolvedValue({ recording: true, limited: false, errors: [] });
  api.historyCompare.mockResolvedValue({ before: side('old text', 'old'), current: side('new text', 'new') });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('local history', () => {
  it('explains an empty history', async () => {
    api.historyList.mockResolvedValue([]);
    render(<LocalHistory scope={scope} />);

    expect(await screen.findByText(text('noHistory'))).toBeVisible();
  });

  it('shows when each change was recorded, and its label', async () => {
    render(<LocalHistory scope={scope} />);

    expect(await screen.findByText(/before refactor/)).toBeVisible();
  });

  it('keeps the events on screen while they reload', async () => {
    await openFile();
    const reload = deferred<unknown>();
    api.historyList.mockReturnValue(reload.promise);

    fireEvent.click(button('common.refresh'));

    await waitFor(() => expect(api.historyList).toHaveBeenCalledTimes(2));
    expect(button('src/a.ts')).toBeVisible();
    expect(screen.queryByRole('status')).toBeNull();
    reload.resolve([event]);
  });

  it('shows a recording error once, however often it repeats', async () => {
    api.historyStatus.mockResolvedValue({
      recording: true,
      limited: false,
      errors: ['disk full', 'disk full', 'disk full', 'locked'],
    });
    render(<LocalHistory scope={scope} />);

    expect(await screen.findAllByText('disk full')).toHaveLength(1);
    expect(screen.getByText('locked')).toBeVisible();
  });

  it('says when recording is limited', async () => {
    api.historyStatus.mockResolvedValue({ recording: true, limited: true, errors: [] });
    render(<LocalHistory scope={scope} />);

    expect(await screen.findByText(text('recordingLimited'))).toBeVisible();
  });

  it('offers a retry when history cannot be read', async () => {
    api.historyList.mockRejectedValue(new Error('store unavailable'));
    render(<LocalHistory scope={scope} />);

    expect(await screen.findByText('store unavailable')).toBeVisible();
    api.historyList.mockResolvedValue([event]);
    fireEvent.click(button('common.retry'));

    expect(await screen.findByRole('button', { name: 'src/a.ts' })).toBeVisible();
  });
});

describe('comparing a recorded version', () => {
  it('shows both versions side by side', async () => {
    await openFile();

    expect(screen.getByText('old text')).toBeVisible();
    expect(screen.getByText('new text')).toBeVisible();
    expect(api.historyCompare).toHaveBeenCalledWith({ scope, request: { id: 'e', path: 'src/a.ts' } });
  });

  it('decodes text in any language', async () => {
    api.historyCompare.mockResolvedValue({ before: side('修复登录'), current: side('日本語 ✓') });
    await openFile();

    expect(screen.getByText('修复登录')).toBeVisible();
    expect(screen.getByText('日本語 ✓')).toBeVisible();
  });

  it('says when a side does not exist', async () => {
    api.historyCompare.mockResolvedValue({
      before: side('old text'),
      current: { exists: false, fingerprint: 'missing', size: 0 },
    });
    await openFile();

    expect(screen.getByText(text('missing'))).toBeVisible();
  });

  it.each([
    ['a NUL byte', [65, 0, 66]],
    ['bytes that are not UTF-8', [0xff, 0xfe, 0xfd]],
  ])('treats %s as binary instead of showing garbage', async (_name, bytes) => {
    api.historyCompare.mockResolvedValue({ before: side(bytes), current: side('new text') });
    await openFile();

    expect(screen.getByText('conversation.gitWorkbench.binary')).toBeVisible();
  });

  it('shows an empty file as empty, not as missing', async () => {
    api.historyCompare.mockResolvedValue({ before: side(''), current: side('new text') });
    await openFile();

    expect(screen.queryByText(text('missing'))).toBeNull();
  });

  it('offers a retry when the comparison fails', async () => {
    api.historyCompare.mockRejectedValue(new Error('File exceeds storage size limit'));
    render(<LocalHistory scope={scope} />);
    fireEvent.click(await screen.findByRole('button', { name: 'src/a.ts' }));

    expect(await screen.findByText('File exceeds storage size limit')).toBeVisible();
    api.historyCompare.mockResolvedValue({ before: side('old text'), current: side('new text') });
    fireEvent.click(button('common.retry'));

    expect(await screen.findByText('old text')).toBeVisible();
  });
});

describe('restoring a recorded version', () => {
  it('names the file and restores only after confirming', async () => {
    await openFile();
    fireEvent.click(button(text('restoreFile')));

    expect(dialog().getByText('src/a.ts')).toBeVisible();
    expect(api.historyRestore).not.toHaveBeenCalled();
    fireEvent.click(dialog().getByRole('button', { name: 'common.confirm' }));

    await waitFor(() =>
      expect(api.historyRestore).toHaveBeenCalledWith({
        scope,
        request: { id: 'e', paths: ['src/a.ts'], expected: { 'src/a.ts': 'new' } },
      })
    );
  });

  it('does nothing when the confirmation is cancelled', async () => {
    await openFile();
    fireEvent.click(button(text('restoreFile')));
    fireEvent.click(dialog().getByRole('button', { name: 'common.cancel' }));

    expect(api.historyRestore).not.toHaveBeenCalled();
  });

  it('reloads the comparison and the list afterwards', async () => {
    await openFile();
    api.historyRestore.mockResolvedValue({ restored: ['src/a.ts'] });
    api.historyCompare.mockResolvedValue({ before: side('old text'), current: side('old text', 'old') });
    restore();

    await waitFor(() => expect(screen.getAllByText('old text')).toHaveLength(2));
    expect(api.historyList).toHaveBeenCalledTimes(2);
  });

  it('shows the refusal in the dialog when the file changed meanwhile', async () => {
    await openFile();
    api.historyRestore.mockRejectedValue(new Error('File changed since it was compared'));
    restore();

    expect(await dialog().findByText('File changed since it was compared')).toBeVisible();
    expect(screen.getAllByText('File changed since it was compared')).toHaveLength(1);
  });

  it('locks the list and reports busy while restoring', async () => {
    const onBusyChange = vi.fn();
    const restoring = deferred<unknown>();
    api.historyRestore.mockReturnValue(restoring.promise);
    render(<LocalHistory scope={scope} onBusyChange={onBusyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'src/a.ts' }));
    await screen.findByRole('button', { name: text('restoreFile') });

    restore();

    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByRole('button', { name: 'src/a.ts', hidden: true })).toBeDisabled();
    restoring.resolve({ restored: [] });
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });
});

describe('history labels', () => {
  it('needs a label, then clears the field', async () => {
    render(<LocalHistory scope={scope} />);
    const field = await screen.findByRole('textbox', { name: text('label') });
    expect(button(text('addLabel'))).toBeDisabled();

    fireEvent.change(field, { target: { value: 'checkpoint' } });
    fireEvent.click(button(text('addLabel')));

    await waitFor(() => expect(api.historyLabel).toHaveBeenCalledWith({ scope, label: 'checkpoint' }));
    await waitFor(() => expect(field).toHaveValue(''));
  });

  it('keeps the label when saving it fails', async () => {
    api.historyLabel.mockRejectedValue(new Error('disk full'));
    render(<LocalHistory scope={scope} />);
    const field = await screen.findByRole('textbox', { name: text('label') });
    fireEvent.change(field, { target: { value: 'checkpoint' } });
    fireEvent.click(button(text('addLabel')));

    expect(await screen.findByText('disk full')).toBeVisible();
    expect(field).toHaveValue('checkpoint');
  });
});
