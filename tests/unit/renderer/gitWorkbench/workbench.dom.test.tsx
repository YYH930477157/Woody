import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitCommitDetails, GitCommitDiff, GitHistoryPage } from '@/common/types/sourceControl/workbenchTypes';
import { commit, deferred, page, repository } from './fixtures';

const api = vi.hoisted(() => ({
  history: vi.fn(),
  refs: vi.fn(),
  details: vi.fn(),
  diff: vi.fn(),
  operate: vi.fn(),
  cancel: vi.fn(),
  mergeList: vi.fn(),
  mergeRead: vi.fn(),
  mergeSave: vi.fn(),
  mergeFinish: vi.fn(),
  runtime: vi.fn(),
}));
vi.mock('@/common/adapter/ipcBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/common/adapter/ipcBridge')>();
  return {
    ...actual,
    gitWorkbench: Object.fromEntries(Object.entries(api).map(([key, invoke]) => [key, { invoke }])),
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/SourceControl/scmTransport', () => ({ initScmRuntime: vi.fn() }));
vi.mock('@/renderer/pages/conversation/SourceControl/ScmPanel', () => ({
  ScmPanel: () => <div>Existing checked changes</div>,
}));

import { Workbench } from '@/renderer/pages/conversation/SourceControl/Workbench';
import {
  configureScmStore,
  resetScmStoreForTest,
  setSelectedRepo,
} from '@/renderer/pages/conversation/SourceControl/scmStore';
import {
  openScmUi,
  resetScmUiStoreForTest,
  setScmSelectedRepo,
} from '@/renderer/pages/conversation/SourceControl/scmUiStore';

const key = (name: string) => `conversation.gitWorkbench.${name}`;
const open = async () => {
  const mounted = render(<Workbench projectId='project' />);
  const entry = screen.getByRole('button', { name: key('history') });
  await waitFor(() => expect(entry).toBeEnabled());
  await act(async () => {
    fireEvent.click(entry);
  });
  return mounted;
};

beforeEach(() => {
  vi.resetAllMocks();
  resetScmStoreForTest();
  localStorage.clear();
  resetScmUiStoreForTest();
  configureScmStore({
    listRepositories: async () => ({ repositories: [repository('repo-a'), repository('repo-b')] }),
    subscribe: async () => ({ statuses: [] }),
    unsubscribe: () => {},
    status: vi.fn(),
    diff: vi.fn(),
    act: vi.fn(),
  });
  api.history.mockResolvedValue(page([commit('a', 'First commit', ['b']), commit('b', 'Older commit')]));
  api.operate.mockResolvedValue({ state: 'complete', output: '', data: { head: 'a'.repeat(40), branch: 'main' } });
  api.refs.mockResolvedValue([
    { fullName: 'refs/heads/main', name: 'main', type: 'local', hash: 'a', current: true, ahead: 0, behind: 0 },
  ]);
  api.details.mockImplementation(async ({ hash }: { hash: string }) => ({
    hash,
    body: `Message ${hash}`,
    files: [{ path: `${hash}.ts`, status: 'M' }],
  }));
  api.diff.mockImplementation(async ({ file }: { file: string }) => ({ patch: `+change ${file}`, binary: false }));
  api.runtime.mockResolvedValue({
    available: true,
    source: 'bundled',
    version: '2.56.0',
    capabilities: { updateRefs: true, memoryHistoryEdit: true },
  });
});
afterEach(cleanup);

describe('native Git workbench history', () => {
  it('freezes selection, filters and tabs while preparing and confirming a rewrite', async () => {
    const message = deferred<GitCommitDetails>();
    api.details.mockReturnValue(message.promise);
    await open();
    await screen.findByRole('button', { name: /First commit/ });
    fireEvent.click(screen.getAllByRole('checkbox', { name: key('rewrite.select') })[0]);
    fireEvent.click(screen.getByRole('button', { name: key('rewrite.reword') }));
    await waitFor(() => expect(api.details).toHaveBeenCalled());
    expect(screen.getByRole('textbox', { name: key('search') })).toBeDisabled();
    expect(screen.getAllByRole('checkbox', { name: key('rewrite.select') })[1]).toBeDisabled();
    expect(screen.getByRole('tab', { name: key('operations.title') })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => message.resolve({ hash: 'a', body: 'original', files: [] }));
    await screen.findByRole('textbox', { name: key('rewrite.message') });
    expect(screen.getByRole('textbox', { name: key('search') })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: key('search') })).toBeEnabled());
    expect(api.operate.mock.calls.every(([arg]) => arg.request.kind === 'inspect')).toBe(true);
  });

  it('confirms the displayed commit and keeps history mounted while its mutation runs', async () => {
    const pending = deferred<{ state: string; output: string }>();
    api.operate.mockImplementation(async ({ request }) =>
      request.kind === 'cherry-pick'
        ? pending.promise
        : { state: 'complete', output: '', data: { head: 'c'.repeat(40), branch: 'main' } }
    );
    await open();
    fireEvent.click(await screen.findByRole('button', { name: /First commit/ }));
    const cherryPick = await screen.findByRole('button', { name: key('operations.cherry-pick') });
    await waitFor(() => expect(cherryPick).toBeEnabled());
    fireEvent.change(screen.getByRole('textbox', { name: key('search') }), { target: { value: 'pending query' } });
    fireEvent.click(cherryPick);
    expect(api.operate.mock.calls.some(([arg]) => arg.request.kind === 'cherry-pick')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: key('operations.title') })).toHaveAttribute('aria-disabled', 'true')
    );
    expect(api.operate).toHaveBeenCalledWith({
      scope: expect.any(Object),
      request: {
        kind: 'cherry-pick',
        target: 'a',
        expectedHead: 'c'.repeat(40),
        expectedBranch: 'main',
        confirmed: true,
      },
    });
    expect(screen.getByRole('textbox', { name: key('search') })).toBeDisabled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(cherryPick).toBeInTheDocument();
    expect(cherryPick).toBeDisabled();
    await act(async () => pending.resolve({ state: 'complete', output: 'picked' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: key('operations.title') })).not.toHaveAttribute('aria-disabled', 'true')
    );
    expect(await screen.findByText('picked')).toBeInTheDocument();
  });
  it('retains an active operation until it completes and then reloads history', async () => {
    const pending = deferred<{ state: string; output: string }>();
    api.operate.mockImplementation(async ({ request }) =>
      request.kind === 'fetch'
        ? pending.promise
        : {
            state: 'complete',
            output: '',
            data:
              request.kind === 'inspect'
                ? { head: 'a'.repeat(40), branch: 'main' }
                : request.kind === 'remote.list'
                  ? { remotes: [{ name: 'origin', fetchUrl: 'local', pushUrl: 'local' }] }
                  : {},
          }
    );
    await open();
    fireEvent.click(screen.getByRole('tab', { name: key('operations.title') }));
    fireEvent.click(screen.getByRole('tab', { name: key('operations.remote.list') }));
    const fetch = await screen.findByRole('button', { name: key('operations.fetch') });
    await waitFor(() => expect(fetch).toBeEnabled());
    fireEvent.click(fetch);
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: key('history') })).toHaveAttribute('aria-disabled', 'true')
    );
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeInTheDocument();
    await act(async () => pending.resolve({ state: 'complete', output: 'fetched' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: key('history') })).not.toHaveAttribute('aria-disabled', 'true')
    );
    api.history.mockClear();
    fireEvent.click(screen.getByRole('tab', { name: key('history') }));
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
  });
  it('combines a typing burst into one history request', async () => {
    await open();
    await screen.findByText('First commit');
    api.history.mockClear();
    const search = screen.getByRole('textbox', { name: key('search') });
    for (const value of ['f', 'fi', 'fix']) fireEvent.change(search, { target: { value } });
    expect(api.history).not.toHaveBeenCalled();
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
    expect(api.history).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ text: 'fix' }) })
    );
  });
  it('keeps history unavailable in WebUI without issuing native reads', async () => {
    const desktopApi = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined });
    try {
      render(<Workbench projectId='project' />);
      await screen.findByText('Existing checked changes');
      expect(screen.queryByRole('button', { name: key('history') })).not.toBeInTheDocument();
      expect(api.history).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'electronAPI', { configurable: true, value: desktopApi });
    }
  });

  it('sends author, path and calendar date filters while hiding graph connections', async () => {
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: key('author') }), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByRole('textbox', { name: key('path') }), { target: { value: 'src/index.ts' } });
    const since = screen.getByPlaceholderText(key('since'));
    fireEvent.change(since, { target: { value: '2026-10-01' } });
    fireEvent.keyDown(since, { key: 'Enter', code: 'Enter', keyCode: 13 });
    const until = screen.getByPlaceholderText(key('until'));
    fireEvent.change(until, { target: { value: '2026-10-30' } });
    fireEvent.keyDown(until, { key: 'Enter', code: 'Enter', keyCode: 13 });
    await waitFor(() =>
      expect(api.history).toHaveBeenLastCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({
            author: 'Ada',
            path: 'src/index.ts',
            since: '2026-10-01',
            until: '2026-10-30',
          }),
        })
      )
    );
    expect(document.querySelectorAll('[data-graph-edge]')).toHaveLength(0);
  });

  it('restores repository filters after switching repositories and closing the window', async () => {
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: key('author') }), { target: { value: 'Ada' } });
    fireEvent.click(await screen.findByRole('button', { name: /main/ }));
    act(() => setSelectedRepo('repo-b'));
    expect(screen.getByRole('textbox', { name: key('author') })).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox', { name: key('search') }), { target: { value: 'Other repo' } });
    act(() => setSelectedRepo('repo-a'));
    expect(screen.getByRole('textbox', { name: key('author') })).toHaveValue('Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: key('history') }));
    });
    await waitFor(() =>
      expect(api.history).toHaveBeenLastCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({ author: 'Ada', ref: 'refs/heads/main', text: undefined }),
        })
      )
    );
  });

  it('keeps filters isolated between projects sharing repository identities', async () => {
    const mounted = await open();
    fireEvent.change(screen.getByRole('textbox', { name: key('search') }), { target: { value: 'Project one' } });
    mounted.rerender(<Workbench projectId='other-project' />);
    expect(await screen.findByRole('textbox', { name: key('search') })).toHaveValue('');
    mounted.rerender(<Workbench projectId='project' />);
    expect(await screen.findByRole('textbox', { name: key('search') })).toHaveValue('Project one');
  });

  it('ignores malformed and oversized saved filters while retaining valid values', async () => {
    localStorage.setItem(
      'scm-history-filters:["project","repo-a","nested"]',
      JSON.stringify({
        version: 1,
        filters: { text: 'Saved search', author: { invalid: true }, path: 'x'.repeat(4096), since: '2026-02-31' },
      })
    );
    await open();
    expect(screen.getByRole('textbox', { name: key('search') })).toHaveValue('Saved search');
    expect(screen.getByRole('textbox', { name: key('author') })).toHaveValue('');
    expect(api.history).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ author: undefined, path: undefined, since: undefined }),
      })
    );
  });

  it('continues filtering when browser preference storage cannot be read or written', async () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage denied');
    });
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage full');
    });
    try {
      await open();
      fireEvent.change(screen.getByRole('textbox', { name: key('author') }), { target: { value: 'Ada' } });
      await waitFor(() =>
        expect(api.history).toHaveBeenLastCalledWith(
          expect.objectContaining({ query: expect.objectContaining({ author: 'Ada' }) })
        )
      );
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });

  it('clears filters and starts a new snapshot when refreshing', async () => {
    api.history.mockResolvedValue({ ...page([commit('a', 'First commit')]), snapshot: 'old-snapshot' });
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: key('author') }), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: key('clearFilters') }));
    fireEvent.click(screen.getByRole('button', { name: 'common.refresh' }));
    await waitFor(() =>
      expect(api.history).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: expect.objectContaining({ author: undefined, skip: 0, snapshot: undefined }) })
      )
    );
    expect(screen.getByRole('textbox', { name: key('author') })).toHaveValue('');
  });

  it('passes the initial page snapshot to older-page requests', async () => {
    api.history.mockResolvedValueOnce({
      ...page([commit('a', 'First commit', ['b'])], true, 1),
      snapshot: 'stable-refs',
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: key('loadMore') }));
    await waitFor(() =>
      expect(api.history).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: expect.objectContaining({ skip: 1, snapshot: 'stable-refs' }) })
      )
    );
  });

  it('warns when a displayed diff is truncated', async () => {
    api.diff.mockResolvedValue({ patch: '+partial patch', binary: false, truncated: true });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: /First commit/ }));
    fireEvent.click(await screen.findByRole('button', { name: /a.ts/ }));
    expect(await screen.findByText(key('truncatedDiff'))).toBeInTheDocument();
  });

  it('opens the same restored repository as the Changes view', async () => {
    openScmUi('project');
    setScmSelectedRepo('repo-b');
    await open();
    await waitFor(() =>
      expect(api.history).toHaveBeenCalledWith(
        expect.objectContaining({ scope: { projectId: 'project', peId: 'repo-b', relativePath: 'nested' } })
      )
    );
  });

  it('retains checked changes and opens scoped history with commit details and file diff', async () => {
    await open();
    expect(screen.getByText('Existing checked changes')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /First commit/ }));
    expect(await screen.findByText('Message a')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /a.ts/ }));
    expect(await screen.findByText('+change a.ts')).toBeInTheDocument();
    expect(api.history).toHaveBeenCalledWith({
      scope: { projectId: 'project', peId: 'repo-a', relativePath: 'nested' },
      query: expect.objectContaining({ skip: 0 }),
    });
  });

  it('drops old repository history after the shared SCM selection changes', async () => {
    const old = deferred<GitHistoryPage>();
    api.history.mockReturnValueOnce(old.promise).mockResolvedValue(page([commit('new', 'New repository')]));
    await open();
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
    act(() => setSelectedRepo('repo-b'));
    expect(await screen.findByRole('button', { name: /New repository/ })).toBeInTheDocument();
    await act(async () => old.resolve(page([commit('old', 'Old repository')])));
    expect(screen.queryByRole('button', { name: /Old repository/ })).not.toBeInTheDocument();
  });

  it('clears old rows and drops late responses when a search changes', async () => {
    const old = deferred<GitHistoryPage>();
    api.history.mockReturnValueOnce(old.promise).mockResolvedValue(page([commit('match', 'Search match')]));
    await open();
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('textbox', { name: key('search') }), { target: { value: 'search' } });
    expect(await screen.findByRole('button', { name: /Search match/ })).toBeInTheDocument();
    await act(async () => old.resolve(page([commit('old', 'Outdated match')])));
    expect(screen.queryByRole('button', { name: /Outdated match/ })).not.toBeInTheDocument();
  });

  it('drops stale details and stale diff when another commit is selected', async () => {
    const oldDetails = deferred<GitCommitDetails>();
    api.details.mockReturnValueOnce(oldDetails.promise);
    await open();
    fireEvent.click(await screen.findByRole('button', { name: /First commit/ }));
    fireEvent.click(screen.getByRole('button', { name: /Older commit/ }));
    expect(await screen.findByText('Message b')).toBeInTheDocument();
    await act(async () => oldDetails.resolve({ hash: 'a', body: 'Stale message', files: [] }));
    expect(screen.queryByText('Stale message')).not.toBeInTheDocument();
    const oldDiff = deferred<GitCommitDiff>();
    api.diff.mockReturnValueOnce(oldDiff.promise);
    fireEvent.click(screen.getByRole('button', { name: /b.ts/ }));
    fireEvent.click(screen.getByRole('button', { name: /First commit/ }));
    await screen.findByText('Message a');
    await act(async () => oldDiff.resolve({ patch: 'Outdated patch', binary: false }));
    expect(screen.queryByText('Outdated patch')).not.toBeInTheDocument();
  });

  it('shows a history failure and reloads on retry', async () => {
    api.history.mockRejectedValueOnce(new Error('Repository unavailable'));
    await open();
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Repository unavailable');
    fireEvent.click(within(error).getByRole('button', { name: 'common.retry' }));
    expect(await screen.findByRole('button', { name: /First commit/ })).toBeInTheDocument();
  });

  it('shows detail and diff failures with independent retry actions', async () => {
    api.details.mockRejectedValueOnce(new Error('Cannot read details'));
    await open();
    fireEvent.click(await screen.findByRole('button', { name: /First commit/ }));
    let error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Cannot read details');
    fireEvent.click(within(error).getByRole('button', { name: 'common.retry' }));
    api.diff.mockRejectedValueOnce(new Error('Cannot read patch'));
    fireEvent.click(await screen.findByRole('button', { name: /a.ts/ }));
    error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Cannot read patch');
    fireEvent.click(within(error).getByRole('button', { name: 'common.retry' }));
    expect(await screen.findByText('+change a.ts')).toBeInTheDocument();
  });

  it('keeps graph lanes continuous when older commits load and hides edges for text filters', async () => {
    api.history
      .mockResolvedValueOnce(page([commit('a', 'First commit', ['b'])], true, 1))
      .mockResolvedValueOnce(page([commit('b', 'Older commit')], false, 2));
    await open();
    await screen.findByRole('button', { name: /First commit/ });
    fireEvent.click(screen.getByRole('button', { name: key('loadMore') }));
    await screen.findByRole('button', { name: /Older commit/ });
    expect(document.querySelectorAll('[data-graph-edge]')).toHaveLength(2);
    api.history.mockResolvedValue(page([commit('a', 'Filtered commit', ['b']), commit('b', 'Older match')]));
    fireEvent.change(screen.getByRole('textbox', { name: key('search') }), { target: { value: 'filter' } });
    await screen.findByRole('button', { name: /Filtered commit/ });
    expect(document.querySelectorAll('[data-graph-edge]')).toHaveLength(0);
  });

  it('filters by a branch, preserves graph topology, and refreshes the selected filter', async () => {
    await open();
    fireEvent.click(await screen.findByRole('button', { name: /main/ }));
    await waitFor(() =>
      expect(api.history).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: expect.objectContaining({ ref: 'refs/heads/main', skip: 0 }) })
      )
    );
    expect(document.querySelectorAll('[data-graph-edge]')).toHaveLength(2);
    api.history.mockResolvedValue(page([commit('new', 'Fresh branch commit')]));
    fireEvent.click(screen.getByRole('button', { name: 'common.refresh' }));
    expect(await screen.findByRole('button', { name: /Fresh branch commit/ })).toBeInTheDocument();
  });

  it('shows an empty history without keeping old commit details after filtering', async () => {
    await open();
    fireEvent.click(await screen.findByRole('button', { name: /First commit/ }));
    await screen.findByText('Message a');
    api.history.mockResolvedValue(page([]));
    fireEvent.change(screen.getByRole('textbox', { name: key('search') }), { target: { value: 'absent' } });
    expect(await screen.findByText(key('empty'))).toBeInTheDocument();
    expect(screen.queryByText('Message a')).not.toBeInTheDocument();
  });

  it('retries branch loading without discarding the loaded commits', async () => {
    api.refs.mockRejectedValueOnce(new Error('Cannot list branches'));
    await open();
    const error = await screen.findByRole('alert');
    fireEvent.click(within(error).getByRole('button', { name: 'common.retry' }));
    expect(await screen.findByRole('button', { name: /main/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /First commit/ })).toBeInTheDocument();
  });

  it('drops a previous file diff when a second file is selected', async () => {
    api.details.mockResolvedValue({
      hash: 'a',
      body: 'Two files',
      files: [
        { path: 'first.ts', status: 'M' },
        { path: 'second.ts', status: 'A' },
      ],
    });
    const old = deferred<GitCommitDiff>();
    api.diff.mockReturnValueOnce(old.promise);
    await open();
    fireEvent.click(await screen.findByRole('button', { name: /First commit/ }));
    fireEvent.click(await screen.findByRole('button', { name: /first.ts/ }));
    fireEvent.click(screen.getByRole('button', { name: /second.ts/ }));
    expect(await screen.findByText('+change second.ts')).toBeInTheDocument();
    await act(async () => old.resolve({ patch: 'Obsolete first patch', binary: false }));
    expect(screen.queryByText('Obsolete first patch')).not.toBeInTheDocument();
  });

  it('explains binary files instead of rendering an empty text diff', async () => {
    api.diff.mockResolvedValue({ patch: '', binary: true });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: /First commit/ }));
    fireEvent.click(await screen.findByRole('button', { name: /a.ts/ }));
    expect(await screen.findByText(key('binary'))).toBeInTheDocument();
  });
});
