import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ operate: vi.fn(), details: vi.fn(), refresh: vi.fn() }));
vi.mock('@/common/adapter/ipcBridge', () => ({
  gitWorkbench: { operate: { invoke: api.operate }, details: { invoke: api.details } },
}));
vi.mock('@/renderer/pages/conversation/SourceControl/scmStore', () => ({ refreshRepo: api.refresh }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { RewriteActions } from '@/renderer/pages/conversation/SourceControl/Workbench/Merge/RewriteActions';
const scope = { projectId: 'p', peId: 'root', relativePath: '' };
const a = 'a'.repeat(40),
  b = 'b'.repeat(40);
const props = () => ({ scope, repoId: 'repo', hashes: [a], onBusyChange: vi.fn(), onCompleted: vi.fn() });
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  api.operate.mockImplementation(async ({ request }) =>
    request.kind === 'inspect'
      ? { state: 'complete', output: '', data: { head: b, branch: 'main' } }
      : { state: 'complete', output: 'done' }
  );
  api.details.mockImplementation(async ({ hash }) => ({ hash, body: `original ${hash}`, files: [] }));
  api.refresh.mockResolvedValue(undefined);
});
describe('history rewrite confirmation', () => {
  it('prevents an empty message and duplicate confirmations from starting a rewrite twice', async () => {
    let finish!: (value: unknown) => void;
    api.operate.mockImplementation(({ request }) =>
      request.kind === 'inspect'
        ? Promise.resolve({ state: 'complete', output: '', data: { head: b, branch: 'main' } })
        : new Promise((resolve) => {
            finish = resolve;
          })
    );
    const p = props();
    render(<RewriteActions {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.gitWorkbench.rewrite.reword' }));
    const message = await screen.findByRole('textbox', { name: 'conversation.gitWorkbench.rewrite.message' });
    const confirm = screen.getByRole('button', { name: 'common.confirm' });
    fireEvent.change(message, { target: { value: '  ' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(message, { target: { value: 'new message' } });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(api.operate.mock.calls.filter(([value]) => value.request.kind === 'history.reword')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'conversation.gitWorkbench.rewrite.reword' })).toBeDisabled();
    await act(async () => finish({ state: 'conflict', output: 'resolve conflicts' }));
    expect(p.onCompleted).toHaveBeenCalledWith({ state: 'conflict', output: 'resolve conflicts' });
    expect(p.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('loads the full message and only sends the frozen reword request on confirmation', async () => {
    const p = props();
    render(<RewriteActions {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.gitWorkbench.rewrite.reword' }));
    const message = await screen.findByRole('textbox', { name: 'conversation.gitWorkbench.rewrite.message' });
    expect(message).toHaveValue(`original ${a}`);
    expect(api.operate.mock.calls.every(([value]) => value.request.kind === 'inspect')).toBe(true);
    fireEvent.change(message, { target: { value: '修复\n\nexact $ text' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));
    await waitFor(() => expect(p.onCompleted).toHaveBeenCalled());
    expect(api.operate).toHaveBeenLastCalledWith({
      scope,
      request: {
        kind: 'history.reword',
        commit: a,
        message: '修复\n\nexact $ text',
        expectedHead: b,
        expectedBranch: 'main',
        confirmed: true,
      },
    });
  });
  it('gates multiple-commit actions and sends the chosen immutable hashes for fixup', async () => {
    const p = props();
    const { rerender } = render(<RewriteActions {...p} />);
    expect(screen.getByRole('button', { name: 'conversation.gitWorkbench.rewrite.fixup' })).toBeDisabled();
    rerender(<RewriteActions {...p} hashes={[b, a]} />);
    expect(screen.getByRole('button', { name: 'conversation.gitWorkbench.rewrite.reword' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'conversation.gitWorkbench.rewrite.fixup' }));
    fireEvent.click(await screen.findByRole('button', { name: 'common.confirm' }));
    await waitFor(() => expect(p.onCompleted).toHaveBeenCalled());
    expect(api.operate).toHaveBeenLastCalledWith({
      scope,
      request: { kind: 'history.fixup', commits: [b, a], expectedHead: b, expectedBranch: 'main', confirmed: true },
    });
  });
  it('does not offer confirmation when the message read fails', async () => {
    api.details.mockRejectedValue(new Error('cannot read message'));
    render(<RewriteActions {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.gitWorkbench.rewrite.reword' }));
    await screen.findByText('cannot read message');
    expect(screen.queryByRole('button', { name: 'common.confirm' })).toBeNull();
  });
  it('ignores target preparation after unmount', async () => {
    let resolve!: (value: unknown) => void;
    api.details.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const p = props();
    const { unmount } = render(<RewriteActions {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.gitWorkbench.rewrite.reword' }));
    await waitFor(() => expect(api.details).toHaveBeenCalled());
    unmount();
    await act(async () => resolve({ hash: a, body: 'late', files: [] }));
    expect(p.onCompleted).not.toHaveBeenCalled();
    expect(p.onBusyChange).toHaveBeenLastCalledWith(false);
  });
});
