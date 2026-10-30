import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fileHistory: vi.fn(),
  blame: vi.fn(),
  readRevision: vi.fn(),
  diff: vi.fn(),
}));
const openPreview = vi.hoisted(() => vi.fn());

vi.mock('@/common/adapter/ipcBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/common/adapter/ipcBridge')>();
  return {
    ...actual,
    gitWorkbench: Object.fromEntries(Object.entries(api).map(([key, invoke]) => [key, { invoke }])),
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ openPreview }),
}));

import { FileHistory } from '@/renderer/pages/conversation/SourceControl/Workbench/History/FileHistory';
import { commit, page } from './fixtures';

const scope = { projectId: 'p', peId: 'root', relativePath: 'src' };
const key = (name: string) => `conversation.gitWorkbench.fileHistory.${name}`;

beforeEach(() => {
  vi.resetAllMocks();
  api.fileHistory.mockResolvedValue(page([commit('a'.repeat(40), 'Change file')]));
  api.blame.mockResolvedValue([
    { line: 1, hash: 'a'.repeat(40), committed: true, author: 'Ada', content: 'const value = 1;' },
  ]);
  api.readRevision.mockResolvedValue({ exists: true, binary: false, content: 'historical source' });
  api.diff.mockResolvedValue({ patch: '+historical source', binary: false });
});

afterEach(cleanup);

describe('file history and blame', () => {
  it('opens a selected historical revision in Woody preview with a read-only file reference', async () => {
    render(<FileHistory scope={scope} file='src/a.ts' onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Change file/ }));
    await waitFor(() => expect(openPreview).toHaveBeenCalledTimes(1));
    expect(api.readRevision).toHaveBeenCalledWith({
      scope,
      anchor: { kind: 'revision', revision: 'a'.repeat(40) },
      file: 'src/a.ts',
    });
    expect(openPreview).toHaveBeenCalledWith(
      'historical source',
      'code',
      expect.objectContaining({ editable: false, file_name: 'a.ts' })
    );
    expect(await screen.findByText('+historical source')).toBeVisible();
  });

  it('shows retryable file history failures', async () => {
    api.fileHistory.mockRejectedValueOnce(new Error('history unavailable'));
    render(<FileHistory scope={scope} file='src/a.ts' onClose={vi.fn()} />);

    expect(await screen.findByText('history unavailable')).toBeVisible();
    expect(screen.getByRole('button', { name: 'common.retry' })).toBeVisible();
  });

  it('shows blame rows from the same repository scope', async () => {
    render(<FileHistory scope={scope} file='src/a.ts' onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('tab', { name: key('blame') }));

    expect(await screen.findByText('const value = 1;')).toBeVisible();
    expect(screen.getAllByText('Ada').length).toBeGreaterThanOrEqual(1);
    expect(api.blame).toHaveBeenCalledWith({ scope, file: 'src/a.ts' });
  });
});
