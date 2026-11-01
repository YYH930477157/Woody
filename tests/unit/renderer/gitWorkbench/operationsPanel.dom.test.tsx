import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  operate: vi.fn(),
  cancel: vi.fn(),
  refs: vi.fn(),
  refresh: vi.fn(),
  progress: undefined as undefined | ((event: unknown) => void),
}));
vi.mock('@/common/adapter/ipcBridge', () => ({
  gitWorkbench: {
    operate: { invoke: api.operate },
    cancel: { invoke: api.cancel },
    refs: { invoke: api.refs },
    operationProgress: {
      on: (listener: (event: unknown) => void) => {
        api.progress = listener;
        return () => {};
      },
    },
  },
}));
vi.mock('@/renderer/pages/conversation/SourceControl/scmStore', () => ({ refreshRepo: api.refresh }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { Operations } from '@/renderer/pages/conversation/SourceControl/Workbench/Operations';
import { deferred } from './fixtures';

const scope = { projectId: 'p', peId: 'root', relativePath: '' };
const head = 'a'.repeat(40);
const label = (key: string) => `conversation.gitWorkbench.operations.${key}`;
const ref = (name: string, type: string, overrides = {}) => ({
  name,
  fullName: `refs/${type}/${name}`,
  type,
  hash: `${name}-hash`,
  current: false,
  ...overrides,
});
const main = ref('main', 'local', { current: true });
const remote = { name: 'origin', fetchUrl: 'https://example.com/repo.git' };
const stash = { ref: 'stash@{0}', hash: 'stash-hash', subject: 'WIP on main' };
const worktree = { path: '/repo', branch: 'main', head, locked: false };

let inspected: Record<string, unknown>;
let lists: { remotes: unknown[]; stashes: unknown[]; worktrees: unknown[] };
let results: Record<string, unknown>;

const button = (name: string) => screen.getByRole('button', { name });
const action = (name: string) => button(label(name));
const openTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));
const ran = (kind: string) =>
  api.operate.mock.calls.map(([call]) => call.request).filter((request) => request.kind === kind);
const open = async (onBusyChange?: (busy: boolean) => void) => {
  const view = render(<Operations scope={scope} repoId='repo' onBusyChange={onBusyChange} />);
  await waitFor(() => expect(button('common.refresh')).toBeEnabled());
  await waitFor(() => expect(api.operate).toHaveBeenCalledTimes(4));
  await waitFor(() => expect(document.querySelector('.arco-tag')).toHaveTextContent(/.+/));
  return view;
};
const pickRef = async (name: string) => {
  fireEvent.click(screen.getByLabelText(label('reference')).querySelector('.arco-select-view') as HTMLElement);
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(`^${name}`) }));
};
const named = (value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name: label('name') }), { target: { value } });
const confirmDialog = () => within(screen.getByRole('dialog'));
const confirm = () => fireEvent.click(confirmDialog().getByRole('button', { name: label('confirm') }));

beforeEach(() => {
  inspected = { head, branch: 'main' };
  lists = { remotes: [remote], stashes: [stash], worktrees: [worktree] };
  results = {};
  api.progress = undefined;
  api.refs.mockResolvedValue([main, ref('dev', 'local'), ref('origin/main', 'remotes'), ref('v1', 'tags')]);
  api.refresh.mockResolvedValue(undefined);
  api.cancel.mockResolvedValue({ cancelled: true });
  api.operate.mockImplementation(async ({ request }) => {
    if (request.kind === 'inspect') return { state: 'complete', output: '', data: inspected };
    if (request.kind === 'remote.list') return { state: 'complete', output: '', data: { remotes: lists.remotes } };
    if (request.kind === 'stash.list') return { state: 'complete', output: '', data: { stashes: lists.stashes } };
    if (request.kind === 'worktree.list')
      return { state: 'complete', output: '', data: { worktrees: lists.worktrees } };
    const result = results[request.kind];
    if (result instanceof Error) throw result;
    return result ?? { state: 'complete', output: '' };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('repository state', () => {
  it('shows the branch', async () => {
    await open();

    expect(document.querySelector('.arco-tag')).toHaveTextContent('main');
  });

  it('shows a short hash on a detached HEAD', async () => {
    inspected = { head, branch: null };
    await open();

    expect(screen.getByText('a'.repeat(10))).toBeVisible();
  });

  it('says when a repository has no commits, and only allows what works without one', async () => {
    inspected = { head: null, branch: null };
    api.refs.mockResolvedValue([]);
    await open();
    named('first');

    expect(screen.getByText(label('noHead'))).toBeVisible();
    expect(action('branch.create')).toBeDisabled();
    expect(action('tag.create')).toBeDisabled();
  });

  it('names an operation that is still in progress', async () => {
    inspected = { head, branch: 'main', operation: 'rebase' };
    await open();

    expect(screen.getByText(/activeOperation.*rebase/)).toBeVisible();
  });

  it('offers a retry when the repository cannot be read', async () => {
    api.operate.mockImplementationOnce(async () => ({ state: 'error', output: 'not a git repository' }));
    render(<Operations scope={scope} repoId='repo' />);

    expect(await screen.findByText('not a git repository')).toBeVisible();
    fireEvent.click(button('common.retry'));

    await waitFor(() => expect(document.querySelector('.arco-tag')).toHaveTextContent('main'));
  });
});

describe('branches and tags', () => {
  it('protects the current branch from switching and deleting', async () => {
    await open();

    expect(action('branch.switch')).toBeDisabled();
    expect(action('branch.delete')).toBeDisabled();
  });

  it('allows switching to and deleting another local branch', async () => {
    await open();
    await pickRef('dev');

    expect(action('branch.switch')).toBeEnabled();
    expect(action('branch.delete')).toBeEnabled();
    fireEvent.click(action('branch.switch'));

    await waitFor(() =>
      expect(ran('branch.switch')).toEqual([{ kind: 'branch.switch', name: 'dev', expectedHead: head }])
    );
  });

  it('treats a remote branch as read-only', async () => {
    await open();
    await pickRef('origin/main');
    named('anything');

    expect(action('branch.switch')).toBeDisabled();
    expect(action('branch.rename')).toBeDisabled();
    expect(action('branch.delete')).toBeDisabled();
    expect(action('tag.delete')).toBeDisabled();
  });

  it('deletes an annotated tag by the tag object, not its commit', async () => {
    api.refs.mockResolvedValue([main, ref('v1', 'tag', { objectHash: 'tag-object' })]);
    await open();
    await pickRef('v1');
    fireEvent.click(action('tag.delete'));
    confirm();

    await waitFor(() =>
      expect(ran('tag.delete')).toEqual([
        { kind: 'tag.delete', name: 'v1', expectedRef: 'tag-object', confirmed: true },
      ])
    );
  });

  it('needs a name, and trims it', async () => {
    await open();
    expect(action('branch.create')).toBeDisabled();
    named('   ');
    expect(action('branch.create')).toBeDisabled();

    named('  feature  ');
    fireEvent.click(action('branch.create'));

    await waitFor(() =>
      expect(ran('branch.create')).toEqual([
        { kind: 'branch.create', name: 'feature', startPoint: 'main-hash', expectedHead: head },
      ])
    );
  });

  it('starts a new branch from the selected reference', async () => {
    await open();
    await pickRef('dev');
    named('feature');
    fireEvent.click(action('branch.create'));

    await waitFor(() => expect(ran('branch.create')[0].startPoint).toBe('dev-hash'));
  });

  it('clears the name once it has been used', async () => {
    await open();
    named('feature');
    fireEvent.click(action('branch.create'));

    await waitFor(() => expect(screen.getByRole('textbox', { name: label('name') })).toHaveValue(''));
  });

  it('keeps the name when Git refuses it, so it can be corrected', async () => {
    results['branch.create'] = { state: 'blocked', reason: 'invalidName', output: 'bad name' };
    await open();
    named('bad..name');
    fireEvent.click(action('branch.create'));

    expect(await screen.findByText(label('reasons.invalidName'))).toBeVisible();
    expect(screen.getByRole('textbox', { name: label('name') })).toHaveValue('bad..name');
  });

  it('shows both names before renaming', async () => {
    await open();
    await pickRef('dev');
    named('renamed');
    fireEvent.click(action('branch.rename'));

    expect(confirmDialog().getByText('dev → renamed')).toBeVisible();
    expect(ran('branch.rename')).toEqual([]);
    confirm();

    await waitFor(() => expect(ran('branch.rename')).toHaveLength(1));
  });

  it('runs nothing when a confirmation is cancelled', async () => {
    await open();
    await pickRef('dev');
    fireEvent.click(action('branch.delete'));
    fireEvent.click(confirmDialog().getByRole('button', { name: 'common.cancel' }));

    expect(ran('branch.delete')).toEqual([]);
  });

  it('falls back to another reference after the selected one disappears', async () => {
    await open();
    await pickRef('dev');
    api.refs.mockResolvedValue([main]);
    fireEvent.click(action('branch.delete'));
    confirm();

    await waitFor(() => expect(action('branch.delete')).toBeDisabled());
    expect(screen.getByLabelText(label('reference'))).toHaveTextContent('main');
  });
});

describe('remotes', () => {
  const remotes = async () => {
    await open();
    openTab(label('remote.list'));
  };

  it('fetches without asking, because it changes nothing locally', async () => {
    await remotes();
    fireEvent.click(action('fetch'));

    await waitFor(() => expect(ran('fetch')).toEqual([{ kind: 'fetch', remote: 'origin' }]));
  });

  it('shows where a push will go before running it', async () => {
    await remotes();
    fireEvent.click(action('push'));

    expect(confirmDialog().getByText('main → origin')).toBeVisible();
    expect(ran('push')).toEqual([]);
    confirm();

    await waitFor(() =>
      expect(ran('push')).toEqual([
        { kind: 'push', remote: 'origin', branch: 'main', expectedHead: head, confirmed: true },
      ])
    );
  });

  it('cannot pull or push from a detached HEAD', async () => {
    inspected = { head, branch: null };
    await remotes();

    expect(action('pull')).toBeDisabled();
    expect(action('push')).toBeDisabled();
    expect(action('fetch')).toBeEnabled();
  });

  it('needs a remote to do anything remote', async () => {
    lists.remotes = [];
    await remotes();

    for (const kind of ['fetch', 'pull', 'push', 'remote.remove']) expect(action(kind)).toBeDisabled();
  });

  it('needs both a name and an address to add a remote', async () => {
    await remotes();
    const name = screen.getByRole('textbox', { name: label('name') });
    const url = screen.getByRole('textbox', { name: label('url') });

    fireEvent.change(name, { target: { value: 'upstream' } });
    expect(action('remote.add')).toBeDisabled();
    fireEvent.change(url, { target: { value: ' https://example.com/up.git ' } });
    fireEvent.click(action('remote.add'));

    await waitFor(() =>
      expect(ran('remote.add')).toEqual([{ kind: 'remote.add', name: 'upstream', url: 'https://example.com/up.git' }])
    );
    await waitFor(() => expect(url).toHaveValue(''));
    expect(name).toHaveValue('');
  });

  it('does not carry a branch name into the remote form', async () => {
    await open();
    named('feature');
    openTab(label('remote.list'));

    expect(screen.getByRole('textbox', { name: label('name') })).toHaveValue('');
  });

  it('checks the address it showed before changing or removing a remote', async () => {
    await remotes();
    fireEvent.click(action('remote.remove'));
    confirm();

    await waitFor(() =>
      expect(ran('remote.remove')).toEqual([
        { kind: 'remote.remove', name: 'origin', expectedUrl: remote.fetchUrl, confirmed: true },
      ])
    );
  });
});

describe('remote progress', () => {
  it('shows the phase and percent of the running operation only', async () => {
    const fetched = deferred<unknown>();
    results.fetch = fetched.promise;
    await open();
    openTab(label('remote.list'));
    fireEvent.click(action('fetch'));
    await waitFor(() => expect(ran('fetch')).toHaveLength(1));
    const { operationId } = api.operate.mock.calls.at(-1)?.[0] ?? {};

    act(() => api.progress?.({ operationId: 'another', phase: 'writing', percent: 90 }));
    expect(screen.queryByText(label('progress.writing'))).toBeNull();

    act(() => api.progress?.({ operationId, phase: 'receiving', percent: 42 }));
    expect(screen.getByText(label('progress.receiving'))).toBeVisible();
    expect(screen.getByText('42%')).toBeVisible();

    fetched.resolve({ state: 'complete', output: '' });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('offers Cancel while a remote operation runs, and locks everything else', async () => {
    const onBusyChange = vi.fn();
    const fetched = deferred<unknown>();
    results.fetch = fetched.promise;
    await open(onBusyChange);
    openTab(label('remote.list'));
    fireEvent.click(action('fetch'));

    fireEvent.click(await screen.findByRole('button', { name: 'common.cancel' }));
    expect(api.cancel).toHaveBeenCalledOnce();
    expect(action('pull')).toBeDisabled();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);

    fetched.resolve({ state: 'cancelled', output: '' });
    expect(await screen.findByText(label('outcomes.cancelled'))).toBeVisible();
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });

  it('has no Cancel for a local operation', async () => {
    const created = deferred<unknown>();
    results['branch.create'] = created.promise;
    await open();
    named('feature');
    fireEvent.click(action('branch.create'));

    expect(await screen.findByRole('status')).toHaveTextContent(label('running'));
    expect(screen.queryByRole('button', { name: 'common.cancel' })).toBeNull();
    created.resolve({ state: 'complete', output: '' });
  });

  it('releases the panel when it closes mid-operation', async () => {
    const onBusyChange = vi.fn();
    results.fetch = deferred<unknown>().promise;
    const { unmount } = await open(onBusyChange);
    openTab(label('remote.list'));
    fireEvent.click(action('fetch'));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));

    unmount();

    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(api.cancel).toHaveBeenCalledOnce();
  });
});

describe('stashes', () => {
  const stashes = async () => {
    await open();
    openTab(label('stash.list'));
  };

  it('includes untracked files by default, and can leave them out', async () => {
    await stashes();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByRole('textbox', { name: label('message') }), { target: { value: 'for later' } });
    fireEvent.click(action('stash.save'));

    await waitFor(() =>
      expect(ran('stash.save')).toEqual([
        { kind: 'stash.save', message: 'for later', includeUntracked: false, expectedHead: head },
      ])
    );
  });

  it('saves without a description, which is optional in Git', async () => {
    await stashes();
    fireEvent.click(action('stash.save'));

    expect(await screen.findByText(label('outcomes.complete'))).toBeVisible();
  });

  it('clears the description after saving', async () => {
    await stashes();
    const message = screen.getByRole('textbox', { name: label('message') });
    fireEvent.change(message, { target: { value: 'for later' } });
    fireEvent.click(action('stash.save'));

    await waitFor(() => expect(message).toHaveValue(''));
  });

  it('shows the patch of a stash, and says when it is cut short', async () => {
    results['stash.show'] = { state: 'complete', output: '', data: { patch: 'diff --git a/a b/a', truncated: true } };
    await stashes();
    fireEvent.click(action('stash.show'));

    expect(await screen.findByText('diff --git a/a b/a')).toBeVisible();
    expect(screen.getByText('conversation.gitWorkbench.truncatedDiff')).toBeVisible();
  });

  it('applies without asking, but confirms what removes the stash', async () => {
    await stashes();
    fireEvent.click(action('stash.apply'));
    await waitFor(() => expect(ran('stash.apply')).toHaveLength(1));

    fireEvent.click(action('stash.pop'));
    expect(confirmDialog().getByText('stash@{0}')).toBeVisible();
    expect(ran('stash.pop')).toEqual([]);
    fireEvent.click(confirmDialog().getByRole('button', { name: 'common.cancel' }));

    fireEvent.click(action('stash.drop'));
    confirm();
    await waitFor(() =>
      expect(ran('stash.drop')).toEqual([
        { kind: 'stash.drop', ref: 'stash@{0}', expectedRef: 'stash-hash', confirmed: true },
      ])
    );
  });

  it('lists the files that conflict after applying', async () => {
    results['stash.apply'] = { state: 'conflict', output: 'CONFLICT', files: ['src/a.ts', 'src/b.ts'] };
    await stashes();
    fireEvent.click(action('stash.apply'));

    expect(await screen.findByText(label('outcomes.conflict'))).toBeVisible();
    expect(screen.getByText('src/a.ts')).toBeVisible();
    expect(screen.getByText('src/b.ts')).toBeVisible();
  });
});

describe('outcomes', () => {
  it('replaces raw Git text with an explanation when there is one', async () => {
    results['branch.create'] = { state: 'blocked', reason: 'refChanged', output: 'fatal: internal text' };
    await open();
    named('x');
    fireEvent.click(action('branch.create'));

    expect(await screen.findByText(label('reasons.refChanged'))).toBeVisible();
    expect(screen.queryByText('fatal: internal text')).toBeNull();
  });

  it('keeps Git`s text when it is all there is', async () => {
    results['branch.create'] = { state: 'error', output: 'fatal: something unusual' };
    await open();
    named('x');
    fireEvent.click(action('branch.create'));

    expect(await screen.findByText('fatal: something unusual')).toBeVisible();
  });

  it('reports a failed call the same way as a failed operation', async () => {
    results['branch.create'] = new Error('host went away');
    await open();
    named('x');
    fireEvent.click(action('branch.create'));

    expect(await screen.findByText('host went away')).toBeVisible();
    expect(screen.getByRole('button', { name: 'common.refresh' })).toBeEnabled();
  });

  it('refreshes the changes list after every action, even a failed one', async () => {
    results['branch.create'] = { state: 'error', output: 'no' };
    await open();
    named('x');
    fireEvent.click(action('branch.create'));

    await waitFor(() => expect(api.refresh).toHaveBeenCalledWith('repo'));
  });
});

describe('worktrees', () => {
  it('lists each one and marks locked ones', async () => {
    lists.worktrees = [worktree, { path: '/repo-detached', head, locked: true }];
    await open();
    openTab(label('worktree.list'));

    expect(await screen.findByText('/repo-detached')).toBeVisible();
    expect(screen.getByText('a'.repeat(10))).toBeVisible();
    expect(screen.getByText(label('locked'))).toBeVisible();
  });
});
