import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  mergeList: vi.fn(),
  mergeRead: vi.fn(),
  mergeSave: vi.fn(),
  mergeFinish: vi.fn(),
  refs: vi.fn(),
  operate: vi.fn(),
  refreshRepo: vi.fn(),
}));
vi.mock('@/common/adapter/ipcBridge', () => ({
  gitWorkbench: {
    mergeList: { invoke: api.mergeList },
    mergeRead: { invoke: api.mergeRead },
    mergeSave: { invoke: api.mergeSave },
    mergeFinish: { invoke: api.mergeFinish },
    refs: { invoke: api.refs },
    operate: { invoke: api.operate },
    cancel: { invoke: vi.fn() },
    operationProgress: { on: () => () => {} },
  },
}));
vi.mock('@/renderer/pages/conversation/SourceControl/scmStore', () => ({ refreshRepo: api.refreshRepo }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/SourceControl/Workbench/Merge/MergePane', () => ({
  MergePane: ({
    title,
    value,
    line,
    onChange,
  }: {
    title: string;
    value: string;
    line?: number;
    onChange?: (value: string) => void;
  }) => (
    <textarea aria-label={title} data-line={line} value={value} onChange={(event) => onChange?.(event.target.value)} />
  ),
}));

import { Merge } from '@/renderer/pages/conversation/SourceControl/Workbench/Merge';

const scope = { projectId: 'p', peId: 'r', relativePath: '' };
const head = 'a'.repeat(40);
const label = (key: string) => `conversation.gitWorkbench.merge.${key}`;
const button = (key: string) => screen.getByRole('button', { name: label(key) });
const stage = { oid: head, mode: '100644', text: 'line\n', binary: false, deleted: false };
const conflictIn = (file: string) => ({
  file,
  version: 'v1',
  head,
  branch: 'main',
  operation: 'merge',
  stages: { base: stage, ours: { ...stage, text: 'ours\n' }, theirs: { ...stage, text: 'theirs\n' } },
  result: 'working\n',
  crlf: false,
  binary: false,
});

let operation: string | undefined;
let outcome: unknown;
const operationsRan = () =>
  api.operate.mock.calls.map(([call]) => call.request).filter((request) => request.kind.startsWith('history.'));

beforeEach(() => {
  operation = undefined;
  outcome = { state: 'complete', output: '' };
  api.refs.mockResolvedValue([]);
  api.refreshRepo.mockResolvedValue(undefined);
  api.mergeRead.mockImplementation(async ({ file }) => conflictIn(file));
  api.mergeSave.mockImplementation(async ({ request }) => ({ ...conflictIn(request.file), version: 'v2' }));
  api.mergeFinish.mockResolvedValue({ state: 'complete', output: '' });
  api.operate.mockImplementation(async ({ request }) => {
    if (request.kind.startsWith('history.')) return outcome;
    return { state: 'complete', output: '', data: { head, branch: 'main', operation } };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const open = async ({ files, active }: { files: string[]; active?: string }, onBusyChange = vi.fn()) => {
  operation = active;
  api.mergeList.mockResolvedValue({ files });
  const view = render(<Merge scope={scope} repoId='repo' onBusyChange={onBusyChange} />);
  await screen.findByRole('button', { name: 'common.refresh' });
  await waitFor(() => expect(api.operate).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByRole('button', { name: 'common.refresh' })).toBeEnabled());
  return { ...view, onBusyChange };
};
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));

describe('merge panel', () => {
  it('says there is nothing to resolve', async () => {
    await open({ files: [] });

    expect(await screen.findByText(label('empty'))).toBeVisible();
    expect(screen.queryByRole('button', { name: label('abort') })).toBeNull();
  });

  it('says when every conflict is resolved', async () => {
    await open({ files: [], active: 'merge' });

    expect(await screen.findByText(label('ready'))).toBeVisible();
    await waitFor(() => expect(button('continue')).toBeEnabled());
  });

  it('holds Continue back while a conflict remains, but always allows Abort', async () => {
    await open({ files: ['a.txt'], active: 'rebase' });

    await screen.findByRole('textbox', { name: /merge.result/ });
    expect(button('continue')).toBeDisabled();
    expect(button('abort')).toBeEnabled();
  });

  it.each([
    ['continue', 'confirmContinue', 'history.continue'],
    ['abort', 'confirmAbort', 'history.abort'],
  ])('asks before %s and sends the state it showed', async (action, warning, kind) => {
    await open({ files: [], active: 'merge' });
    await waitFor(() => expect(button(action)).toBeEnabled());
    fireEvent.click(button(action));

    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(label(warning))).toBeVisible();
    expect(dialog.getByText(`merge · ${head}`)).toBeVisible();
    expect(operationsRan()).toEqual([]);

    confirm();

    await waitFor(() =>
      expect(operationsRan()).toEqual([
        { kind, operation: 'merge', expectedHead: head, expectedBranch: 'main', confirmed: true },
      ])
    );
    await waitFor(() => expect(api.mergeList).toHaveBeenCalledTimes(2));
  });

  it('does nothing when the confirmation is cancelled', async () => {
    await open({ files: [], active: 'merge' });
    await waitFor(() => expect(button('abort')).toBeEnabled());
    fireEvent.click(button('abort'));
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    expect(operationsRan()).toEqual([]);
  });

  it('explains a blocked operation in the panel', async () => {
    outcome = { state: 'blocked', reason: 'unresolvedConflicts', output: 'Resolve all conflicts before continuing' };
    await open({ files: [], active: 'merge' });
    await waitFor(() => expect(button('continue')).toBeEnabled());
    fireEvent.click(button('continue'));
    confirm();

    expect(await screen.findByText('conversation.gitWorkbench.operations.reasons.unresolvedConflicts')).toBeVisible();
  });

  it('opens the next conflict once a file is finished', async () => {
    await open({ files: ['a.txt', 'b.txt'], active: 'merge' });
    await screen.findByRole('textbox', { name: /merge.result/ });
    api.mergeList.mockResolvedValue({ files: ['b.txt'] });

    fireEvent.click(button('useOurs'));
    confirm();

    expect(await screen.findByText('b.txt', { selector: 'strong' })).toBeVisible();
    expect(api.mergeFinish).toHaveBeenCalledOnce();
  });

  it('reports the last conflict done and offers Continue', async () => {
    await open({ files: ['a.txt'], active: 'merge' });
    await screen.findByRole('textbox', { name: /merge.result/ });
    api.mergeList.mockResolvedValue({ files: [] });

    fireEvent.click(button('useTheirs'));
    confirm();

    expect(await screen.findByText(label('ready'))).toBeVisible();
    await waitFor(() => expect(button('continue')).toBeEnabled());
  });

  it('locks navigation while the result has unsaved edits', async () => {
    const { onBusyChange } = await open({ files: ['a.txt'], active: 'merge' });
    const result = await screen.findByRole('textbox', { name: /merge.result/ });

    fireEvent.change(result, { target: { value: 'edited' } });

    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByRole('button', { name: 'common.refresh' })).toBeDisabled();
    expect(button('abort')).toBeDisabled();
    expect(document.querySelector('.arco-select')).toHaveClass('arco-select-disabled');

    fireEvent.click(button('save'));

    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
    expect(button('abort')).toBeEnabled();
  });

  it('releases navigation when it closes', async () => {
    const { onBusyChange, unmount } = await open({ files: ['a.txt'], active: 'merge' });
    fireEvent.change(await screen.findByRole('textbox', { name: /merge.result/ }), { target: { value: 'edited' } });
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));

    unmount();

    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('shows why conflicts could not be listed, and recovers on retry', async () => {
    api.mergeList.mockRejectedValue(new Error('not a repository'));
    render(<Merge scope={scope} repoId='repo' onBusyChange={vi.fn()} />);

    expect(await screen.findByText('not a repository')).toBeVisible();
    api.mergeList.mockResolvedValue({ files: [] });
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));

    expect(await screen.findByText(label('empty'))).toBeVisible();
  });
});

describe('conflict editor', () => {
  const opened = async (document: object = {}) => {
    api.mergeRead.mockResolvedValue({ ...conflictIn('a.txt'), ...document });
    await open({ files: ['a.txt'], active: 'merge' });
    return screen.findByRole('textbox', { name: /merge.result/ });
  };
  const rebuild = () => {
    fireEvent.click(button('rebuild'));
    confirm();
  };

  it('finishes without a review once the last conflict has a side', async () => {
    await opened();
    rebuild();
    expect(button('finish')).toBeDisabled();

    fireEvent.click(button('acceptTheirsChange'));

    expect(screen.getByText(/merge.remaining.*0/)).toBeVisible();
    expect(button('acceptOursChange')).toBeDisabled();
    expect(button('finish')).toBeEnabled();
    expect(screen.getByRole('textbox', { name: /merge.result/ })).toHaveValue('theirs\n');
  });

  it('opens a file with Git conflict markers at the first one', async () => {
    const result = await opened({ result: 'one\ntwo\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n' });

    expect(result).toHaveAttribute('data-line', '2');
  });

  it('lines up both sides on the first real conflict, past changes Git merged by itself', async () => {
    await opened({
      stages: {
        base: { ...stage, text: 'a\nb\nc\nd\n' },
        ours: { ...stage, text: 'A\nb\nours\nd\n' },
        theirs: { ...stage, text: 'a\nb\ntheirs\nd\n' },
      },
    });

    expect(screen.getByRole('textbox', { name: /merge.ours/ })).toHaveAttribute('data-line', '2');
    expect(screen.getByRole('textbox', { name: /merge.theirs/ })).toHaveAttribute('data-line', '2');
  });

  it('keeps the chosen change when the user picks another one', async () => {
    await opened({
      stages: {
        base: { ...stage, text: 'a\nb\nc\nd\n' },
        ours: { ...stage, text: 'A\nb\nours\nd\n' },
        theirs: { ...stage, text: 'a\nb\ntheirs\nd\n' },
      },
    });
    rebuild();

    fireEvent.click(screen.getByLabelText(label('change')).querySelector('.arco-select-view') as HTMLElement);
    fireEvent.click(await screen.findByRole('option', { name: /inserted|modified/ }));

    expect(screen.getByRole('textbox', { name: /merge.ours/ })).toHaveAttribute('data-line', '0');
  });

  it('leaves the view alone while the user edits above the conflict', async () => {
    const result = await opened({ result: 'one\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n' });

    fireEvent.change(result, { target: { value: 'new line\none\n<<<<<<< HEAD\nours\n' } });

    expect(result).toHaveAttribute('data-line', '1');
  });

  it('has nowhere to jump in a file with no markers', async () => {
    const result = await opened({ result: 'clean\n' });

    expect(result).not.toHaveAttribute('data-line');
  });

  it('follows the selected change once the result is tracked', async () => {
    const result = await opened({ result: '<<<<<<< HEAD\n' });
    rebuild();

    expect(result).toHaveAttribute('data-line', '0');
  });

  it('asks for a fresh review once the accepted result is edited by hand', async () => {
    const result = await opened();
    rebuild();
    fireEvent.click(button('acceptOursChange'));

    fireEvent.change(result, { target: { value: 'typed\n' } });

    expect(button('finish')).toBeDisabled();
    expect(screen.getByText(label('manual'))).toBeVisible();
    expect(screen.queryByRole('button', { name: label('acceptOursChange') })).toBeNull();
  });

  it('discards edits back to the loaded result after confirmation', async () => {
    const result = await opened();
    fireEvent.change(result, { target: { value: 'typed\n' } });
    expect(screen.getByText(label('unsaved'))).toBeVisible();

    fireEvent.click(button('discard'));
    expect(result).toHaveValue('typed\n');
    confirm();

    expect(result).toHaveValue('working\n');
    expect(screen.queryByText(label('unsaved'))).toBeNull();
  });

  it('shows Git`s reason and keeps the result when staging is refused', async () => {
    api.mergeFinish.mockResolvedValue({ state: 'blocked', output: 'Git index is locked; recovery retained' });
    const result = await opened();
    fireEvent.change(result, { target: { value: 'typed\n' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button('finish'));
    confirm();

    expect(await screen.findByText('Git index is locked; recovery retained')).toBeVisible();
    expect(result).toHaveValue('typed\n');
    expect(screen.getByText(label('unsaved'))).toBeVisible();
    expect(api.mergeList).toHaveBeenCalledOnce();
  });

  it('still says something when staging fails without any output', async () => {
    api.mergeFinish.mockResolvedValue({ state: 'error', output: '' });
    await opened();
    fireEvent.click(button('useOurs'));
    confirm();

    expect(await screen.findByText('conversation.gitWorkbench.operations.outcomes.error')).toBeVisible();
  });

  it('reports a failed call to stage the result', async () => {
    api.mergeFinish.mockRejectedValue(new Error('host went away'));
    await opened();
    fireEvent.click(button('deleteFile'));
    confirm();

    expect(await screen.findByText('host went away')).toBeVisible();
    expect(button('deleteFile')).toBeEnabled();
  });

  it('moves on even if refreshing the changes list fails afterwards', async () => {
    api.refreshRepo.mockRejectedValue(new Error('status failed'));
    await opened();
    api.mergeList.mockResolvedValue({ files: [] });
    fireEvent.click(button('useOurs'));
    confirm();

    expect(await screen.findByText(label('ready'))).toBeVisible();
    expect(api.mergeFinish).toHaveBeenCalledOnce();
  });

  it('never offers a text result for a binary file', async () => {
    api.mergeRead.mockResolvedValue({ ...conflictIn('a.txt'), binary: true, result: null });
    await open({ files: ['a.txt'], active: 'merge' });

    await screen.findByText(label('binary'));
    expect(button('finish')).toBeDisabled();
    expect(button('save')).toBeDisabled();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('marks a side that deleted the file', async () => {
    await opened({ stages: { ...conflictIn('a.txt').stages, theirs: { ...stage, text: null, deleted: true } } });

    expect(screen.getByRole('textbox', { name: `${label('theirs')} · ${label('deleted')}` })).toBeVisible();
  });

  it('explains that the sides swap during a rebase', async () => {
    await opened({ operation: 'rebase' });

    expect(screen.getByText(label('rebaseSides'))).toBeVisible();
  });

  it('warns when saved progress no longer matches the file', async () => {
    await opened({ recoveryStale: true });

    expect(screen.getByText(label('recoveryStale'))).toBeVisible();
  });

  it('shows which line ending the result will be written with', async () => {
    await opened({ crlf: true });

    expect(screen.getByRole('textbox', { name: `${label('result')} · CRLF` })).toBeVisible();
  });

  it('offers a retry when the file cannot be read', async () => {
    api.mergeRead.mockRejectedValue(new Error('File exceeds size limit'));
    await open({ files: ['a.txt'], active: 'merge' });

    expect(await screen.findByText('File exceeds size limit')).toBeVisible();
    api.mergeRead.mockResolvedValue(conflictIn('a.txt'));
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));

    expect(await screen.findByRole('textbox', { name: /merge.result/ })).toHaveValue('working\n');
  });
});
