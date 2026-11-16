import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { Message, Modal } from '@arco-design/web-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamWorktreeInfo } from '@/common/types/sourceControl/operationTypes';

const { git, workbench } = vi.hoisted(() => {
  const mocks = {
    inspect: vi.fn(),
    create: vi.fn(),
    discard: vi.fn(),
    describe: vi.fn(),
    merge: vi.fn(),
    remove: vi.fn(),
  };
  return {
    git: mocks,
    workbench: {
      teamWorktreeInspect: { invoke: mocks.inspect },
      teamWorktreeCreate: { invoke: mocks.create },
      teamWorktreeDiscard: { invoke: mocks.discard },
      teamWorktreeDescribe: { invoke: mocks.describe },
      teamWorktreeMerge: { invoke: mocks.merge },
      teamWorktreeRemove: { invoke: mocks.remove },
    },
  };
});
vi.mock('@/common', () => ({ ipcBridge: { gitWorkbench: workbench } }));
vi.mock('@/common/adapter/ipcBridge', () => ({ gitWorkbench: workbench }));
vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));

import IsolatedWorkspaceOption, { useIsolatedWorkspace } from '@/renderer/pages/team/IsolatedWorkspace';
import { TeamWorktreeBar } from '@/renderer/pages/conversation/SourceControl/Workbench/Operations/TeamWorktreeBar';

const source = { root: 'D:\\work\\project', branch: 'main', head: 'abc', dirty: false };
const created = {
  workspace: 'D:\\work\\project-feature\\src',
  worktree: 'D:\\work\\project-feature',
  branch: 'team/feature',
  base: 'main',
};

let prepare: ((name: string) => Promise<unknown>) | undefined;
let discard: (() => void) | undefined;
const Harness: React.FC<{ workspace: string }> = ({ workspace }) => {
  const state = useIsolatedWorkspace(workspace);
  prepare = state.prepare;
  discard = state.discard;
  return (
    <div>
      <IsolatedWorkspaceOption state={state} disabled={false} />
      <span data-testid='enabled'>{String(state.enabled)}</span>
    </div>
  );
};

beforeEach(() => {
  for (const mock of Object.values(git)) mock.mockReset();
  git.inspect.mockResolvedValue(source);
  git.create.mockResolvedValue({ state: 'complete', worktree: created });
  git.discard.mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('separate workspace option', () => {
  it('appears only for a folder inside a Git repository', async () => {
    git.inspect.mockResolvedValueOnce(null);
    const { rerender } = render(<Harness workspace='E:\Docs' />);
    await waitFor(() => expect(git.inspect).toHaveBeenCalledWith({ path: 'E:\\Docs' }));
    expect(screen.queryByTestId('team-isolated-workspace')).toBeNull();
    rerender(<Harness workspace='' />);
    expect(screen.queryByTestId('team-isolated-workspace')).toBeNull();
    rerender(<Harness workspace='D:\work\project\src' />);
    expect(await screen.findByTestId('team-isolated-workspace')).toHaveTextContent('team.create.isolated.hint');
  });

  it('warns about uncommitted changes and cannot be turned on without a branch', async () => {
    git.inspect.mockResolvedValueOnce({ ...source, dirty: true });
    const { rerender } = render(<Harness workspace='D:\work\project' />);
    fireEvent.click(await screen.findByRole('switch'));
    expect(screen.getByTestId('enabled')).toHaveTextContent('true');
    expect(screen.getByText('team.create.isolated.dirty')).toBeInTheDocument();
    git.inspect.mockResolvedValueOnce({ ...source, branch: null });
    rerender(<Harness workspace='D:\work\other' />);
    await screen.findByText('team.create.isolated.detached');
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByTestId('enabled')).toHaveTextContent('false');
  });

  it('reuses a prepared worktree for the same folder and replaces it for another one', async () => {
    const { rerender } = render(<Harness workspace='D:\work\project\src' />);
    await screen.findByTestId('team-isolated-workspace');
    let first: unknown;
    await act(async () => {
      first = await prepare!('Feature');
    });
    expect(first).toMatchObject(created);
    await act(async () => {
      await prepare!('Feature');
    });
    expect(git.create).toHaveBeenCalledExactlyOnceWith({ path: 'D:\\work\\project\\src', name: 'Feature' });
    expect(screen.getByText(/team\.create\.isolated\.prepared/)).toHaveTextContent('team/feature');

    rerender(<Harness workspace='D:\work\project' />);
    await act(async () => {
      await prepare!('Feature');
    });
    expect(git.discard).toHaveBeenCalledWith({ path: created.worktree });
    expect(git.create).toHaveBeenCalledTimes(2);
  });

  it('reports why a worktree could not be made, and removes an unused one on close', async () => {
    render(<Harness workspace='D:\work\project' />);
    await screen.findByTestId('team-isolated-workspace');
    git.create.mockResolvedValueOnce({ state: 'blocked', reason: 'detached', output: 'HEAD is detached' });
    await expect(prepare!('Feature')).rejects.toMatchObject({ reason: 'detached' });
    await act(async () => {
      await prepare!('Feature');
    });
    act(() => discard!());
    expect(git.discard).toHaveBeenCalledWith({ path: created.worktree });
  });
});

const info: TeamWorktreeInfo = {
  worktree: 'D:\\work\\project-feature',
  branch: 'team/feature',
  base: 'main',
  baseExists: true,
  ahead: 2,
  behind: 1,
  dirty: false,
  operation: null,
};
const scope = { projectId: 'p1', peId: 'pe1', relativePath: '' };

describe('team workspace bar in the Git panel', () => {
  it('shows nothing for an ordinary repository', async () => {
    git.describe.mockResolvedValue(null);
    render(<TeamWorktreeBar scope={scope} />);
    await waitFor(() => expect(git.describe).toHaveBeenCalledWith({ scope }));
    expect(screen.queryByTestId('team-worktree-bar')).toBeNull();
  });

  it('merges into the base branch and explains a conflict', async () => {
    git.describe.mockResolvedValue(info);
    git.merge.mockResolvedValueOnce({ state: 'conflict', reason: 'resolveInWorktree', output: '', files: ['a.c'] });
    render(<TeamWorktreeBar scope={scope} />);
    expect(await screen.findByTestId('team-worktree-bar')).toHaveTextContent('"ahead":2');
    fireEvent.click(screen.getByRole('button', { name: /teamWorktree\.merge/ }));
    expect(await screen.findByText(/teamWorktree\.conflict/)).toHaveTextContent('a.c');
    expect(git.merge).toHaveBeenCalledWith({ scope });
    git.merge.mockResolvedValueOnce({ state: 'complete', reason: 'merged', output: '' });
    fireEvent.click(screen.getByRole('button', { name: /teamWorktree\.merge/ }));
    expect(await screen.findByText(/teamWorktree\.merged/)).toBeInTheDocument();
  });

  it('cannot merge with uncommitted changes or nothing new', async () => {
    git.describe.mockResolvedValueOnce({ ...info, dirty: true });
    const { unmount } = render(<TeamWorktreeBar scope={scope} />);
    expect(await screen.findByText('conversation.gitWorkbench.teamWorktree.dirty')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /teamWorktree\.merge/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /teamWorktree\.remove/ })).toBeDisabled();
    unmount();
    git.describe.mockResolvedValueOnce({ ...info, ahead: 0 });
    render(<TeamWorktreeBar scope={scope} />);
    expect(await screen.findByRole('button', { name: /teamWorktree\.merge/ })).toBeDisabled();
  });

  it('asks before deleting, warning about unmerged commits', async () => {
    let config: Parameters<typeof Modal.confirm>[0] | undefined;
    vi.spyOn(Modal, 'confirm').mockImplementation((value) => {
      config = value;
      return { close: () => {}, update: () => {} } as unknown as ReturnType<typeof Modal.confirm>;
    });
    const success = vi.spyOn(Message, 'success').mockImplementation(() => () => {});
    git.describe.mockResolvedValue(info);
    git.remove.mockResolvedValue({ state: 'complete', reason: 'removed', output: '' });
    render(<TeamWorktreeBar scope={scope} />);
    fireEvent.click(await screen.findByRole('button', { name: /teamWorktree\.remove/ }));
    render(<>{config?.content}</>);
    expect(screen.getByText(/teamWorktree\.removeUnmerged/)).toHaveTextContent('"count":2');
    await act(async () => {
      await config?.onOk?.();
    });
    expect(git.remove).toHaveBeenCalledWith({ scope, discard: true });
    expect(success).toHaveBeenCalledWith(expect.stringContaining('teamWorktree.removed'));
  });
});
