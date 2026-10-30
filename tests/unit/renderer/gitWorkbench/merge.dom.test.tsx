import React from 'react';
import { act, cleanup, renderHook, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), finish: vi.fn(), refresh: vi.fn() }));
vi.mock('@/common/adapter/ipcBridge', () => ({
  gitWorkbench: {
    mergeRead: { invoke: api.read },
    mergeSave: { invoke: api.save },
    mergeFinish: { invoke: api.finish },
  },
}));
vi.mock('@/renderer/pages/conversation/SourceControl/scmStore', () => ({ refreshRepo: api.refresh }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/SourceControl/Workbench/Merge/MergePane', () => ({
  MergePane: ({
    title,
    value,
    readOnly,
    onChange,
  }: {
    title: string;
    value: string;
    readOnly: boolean;
    onChange?: (value: string) => void;
  }) => (
    <textarea
      aria-label={title}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));
import { useMergeEditor } from '@/renderer/pages/conversation/SourceControl/Workbench/Merge/useMergeEditor';
import { ConflictEditor } from '@/renderer/pages/conversation/SourceControl/Workbench/Merge/ConflictEditor';
const scope = { projectId: 'p', peId: 'root', relativePath: '' };
const stage = { oid: 'a'.repeat(40), mode: '100644', text: 'base\r\n', binary: false, deleted: false };
const document = {
  file: 'a.txt',
  version: 'v1',
  head: 'a'.repeat(40),
  branch: 'main',
  operation: 'merge',
  stages: { base: stage, ours: { ...stage, text: 'ours\r\n' }, theirs: { ...stage, text: 'theirs\r\n' } },
  result: 'partial\r\n',
  crlf: true,
  binary: false,
};
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  api.read.mockResolvedValue(document);
  api.refresh.mockResolvedValue(undefined);
  api.save.mockImplementation(async ({ request }) => ({ ...document, ...request, version: 'v2' }));
  api.finish.mockResolvedValue({ state: 'complete', output: '' });
});
describe('merge editor lifecycle', () => {
  it('offers a failed-save recovery draft explicitly without replacing current working content on open', async () => {
    api.read.mockResolvedValue({ ...document, recoveryResult: 'valuable failed-save draft\r\n' });
    render(<ConflictEditor scope={scope} repoId='repo' file='a.txt' onFinished={vi.fn()} onBusyChange={vi.fn()} />);
    const recover = await screen.findByRole('button', { name: 'conversation.gitWorkbench.merge.recover' });
    expect(screen.getByRole('textbox', { name: /merge.result/ })).toHaveValue('partial\n');
    fireEvent.click(recover);
    expect(api.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));
    expect(screen.getByRole('textbox', { name: /merge.result/ })).toHaveValue('valuable failed-save draft\n');
    expect(screen.getByRole('button', { name: 'conversation.gitWorkbench.merge.finish' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'conversation.gitWorkbench.merge.save' }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        scope,
        request: { file: 'a.txt', version: 'v1', result: 'valuable failed-save draft\r\n', progress: undefined },
      })
    );
  });
  it('requires review and confirmation to stage manual content, and clears review after another edit', async () => {
    render(<ConflictEditor scope={scope} repoId='repo' file='a.txt' onFinished={vi.fn()} onBusyChange={vi.fn()} />);
    const finish = await screen.findByRole('button', { name: 'conversation.gitWorkbench.merge.finish' });
    expect(finish).toBeDisabled();
    const reviewed = screen.getByRole('checkbox');
    fireEvent.click(reviewed);
    expect(finish).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: /merge.result/ }), { target: { value: 'new manual edit' } });
    expect(reviewed).not.toBeChecked();
    expect(finish).toBeDisabled();
    fireEvent.click(reviewed);
    fireEvent.click(finish);
    expect(api.finish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));
    await waitFor(() => expect(api.finish).toHaveBeenCalledOnce());
  });
  it('locks navigation for unsaved edits and unlocks after saving without staging', async () => {
    const onBusyChange = vi.fn();
    render(
      <ConflictEditor scope={scope} repoId='repo' file='a.txt' onFinished={vi.fn()} onBusyChange={onBusyChange} />
    );
    const editor = await screen.findByRole('textbox', { name: /merge.result/ });
    fireEvent.change(editor, { target: { value: 'changed' } });
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: 'conversation.gitWorkbench.merge.save' }));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
    expect(api.finish).not.toHaveBeenCalled();
  });
  it('offers binary side selection without a lossy text editor', async () => {
    api.read.mockResolvedValue({
      ...document,
      binary: true,
      result: null,
      stages: {
        base: { ...stage, binary: true, text: null },
        ours: { ...stage, binary: true, text: null },
        theirs: { ...stage, deleted: true, text: null },
      },
    });
    render(<ConflictEditor scope={scope} repoId='repo' file='a.txt' onFinished={vi.fn()} onBusyChange={vi.fn()} />);
    const useTheirs = await screen.findByRole('button', { name: 'conversation.gitWorkbench.merge.useTheirs' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(useTheirs);
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));
    await waitFor(() =>
      expect(api.finish).toHaveBeenCalledWith({
        scope,
        request: { file: 'a.txt', version: 'v1', resolution: 'theirs', confirmed: true },
      })
    );
  });
  it('saves only the selected document, retains CRLF and uses the returned version to finish', async () => {
    const done = vi.fn();
    const { result } = renderHook(() => useMergeEditor(scope, 'repo', 'a.txt', done));
    await waitFor(() => expect(result.current.document).toBeDefined());
    act(() => result.current.edit('mine\n'));
    expect(result.current.dirty).toBe(true);
    await act(() => result.current.save());
    expect(api.save).toHaveBeenCalledWith({
      scope,
      request: { file: 'a.txt', version: 'v1', result: 'mine\r\n', progress: undefined },
    });
    expect(api.finish).not.toHaveBeenCalled();
    expect(result.current.dirty).toBe(false);
    await act(() => result.current.finish('result', true));
    expect(api.finish).toHaveBeenCalledWith({
      scope,
      request: {
        file: 'a.txt',
        version: 'v2',
        result: 'mine\r\n',
        resolution: 'result',
        reviewedManual: true,
        confirmed: true,
      },
    });
    expect(done).toHaveBeenCalledOnce();
  });
  it('keeps unsaved edits and blocks duplicate saves when the backend rejects a stale version', async () => {
    let reject!: (reason: Error) => void;
    api.save.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const { result } = renderHook(() => useMergeEditor(scope, 'repo', 'a.txt', vi.fn()));
    await waitFor(() => expect(result.current.document).toBeDefined());
    act(() => result.current.edit('mine'));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.save();
    });
    await act(() => result.current.save());
    expect(api.save).toHaveBeenCalledOnce();
    await act(async () => {
      reject(new Error('stale snapshot'));
      await pending;
    });
    expect(result.current.dirty).toBe(true);
    expect(result.current.text).toBe('mine');
    expect(result.current.error).toBe('stale snapshot');
  });
  it('ignores a delayed file read after changing files', async () => {
    let finish!: (value: unknown) => void;
    api.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const { result, rerender } = renderHook(({ file }) => useMergeEditor(scope, 'repo', file, vi.fn()), {
      initialProps: { file: 'a.txt' },
    });
    rerender({ file: 'b.txt' });
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
    await act(async () => {
      finish({ ...document, result: 'old' });
    });
    expect(result.current.text).toBe('partial\n');
  });
});
