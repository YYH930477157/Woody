import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
const api = vi.hoisted(() => ({ confirm: vi.fn(), conversation: vi.fn(), desktop: vi.fn(() => true) }));
vi.mock('@/common', () => ({ ipcBridge: { conversation: { get: { invoke: api.conversation } } } }));
vi.mock('@/renderer/components/workspace/WorkspaceManager/lifecycle', () => ({
  confirmWorkspaceLeave: api.confirm,
  isWorkspaceDecisionOpen: () => true,
  registerWorkspaceDiscardGuard: () => () => {},
}));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => null,
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: api.desktop }));
vi.mock('@/renderer/services/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@arco-design/web-react', () => ({ Message: { error: vi.fn() } }));
import { Message } from '@arco-design/web-react';
import WorkspaceNavigationGuard from '@/renderer/components/workspace/WorkspaceManager/WorkspaceNavigationGuard';
import { setCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { selectWorkspace } from '@/renderer/components/workspace/workspaceSelection';
afterEach(() => {
  cleanup();
  setCurrentProject(null);
  selectWorkspace(null);
  vi.clearAllMocks();
  api.desktop.mockReturnValue(true);
});
const mount = (start = '/conversation/current') => {
  if (start !== '/guid') setCurrentProject('p');
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <WorkspaceNavigationGuard />
            <Outlet />
          </>
        ),
        children: [
          { path: '/conversation/:id', element: <div>Conversation</div> },
          { path: '/settings/model', element: <div>Settings</div> },
          { path: '/guid', element: <div>New chat</div> },
        ],
      },
    ],
    { initialEntries: ['/settings/model', start], initialIndex: 1 }
  );
  render(<RouterProvider router={router} />);
  return router;
};
describe('workspace router guard', () => {
  it('cancels browser back without unmounting the current conversation', async () => {
    api.confirm.mockResolvedValue(false);
    const router = mount();
    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith('p'));
    expect(router.state.location.pathname).toBe('/conversation/current');
    expect(screen.getByText('Conversation')).toBeTruthy();
  });
  it('permits another conversation in the same workspace without a prompt', async () => {
    api.conversation.mockResolvedValue({ project_id: 'p' });
    const router = mount();
    await act(async () => {
      await router.navigate('/conversation/next');
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/conversation/next'));
    expect(api.confirm).not.toHaveBeenCalled();
  });
  it('registers a native close guard and preserves cancellation', async () => {
    api.confirm.mockResolvedValue(false);
    mount();
    const guard = (window as Window & { __confirmWorkspaceClose: () => Promise<boolean> }).__confirmWorkspaceClose;
    expect(await guard()).toBe(false);
  });
  it('tells the host whether a decision is on screen, then stops when unmounted', () => {
    mount();
    const host = window as Window & { __workspaceDecisionOpen?: () => boolean };
    expect(host.__workspaceDecisionOpen?.()).toBe(true);
    cleanup();
    expect(host.__workspaceDecisionOpen).toBeUndefined();
  });
  const go = (router: ReturnType<typeof mount>, path: string | number) =>
    act(async () => {
      await router.navigate(path as string);
    });
  it('lets navigation through once the user decides to leave', async () => {
    api.confirm.mockResolvedValue(true);
    const router = mount();
    await go(router, '/settings/model');
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/model'));
    expect(screen.getByText('Settings')).toBeTruthy();
  });
  it('asks when another conversation belongs to a different workspace', async () => {
    api.conversation.mockResolvedValue({ project_id: 'other' });
    api.confirm.mockResolvedValue(false);
    const router = mount();
    await go(router, '/conversation/next');
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith('p'));
    expect(router.state.location.pathname).toBe('/conversation/current');
  });
  it('stays and reports it when the destination cannot be checked', async () => {
    api.conversation.mockRejectedValue(new Error('backend unavailable'));
    const router = mount();
    await go(router, '/conversation/next');
    await waitFor(() => expect(Message.error).toHaveBeenCalledWith('conversation.managedWorkspace.failed'));
    expect(router.state.location.pathname).toBe('/conversation/current');
    api.confirm.mockResolvedValue(true);
    await go(router, '/settings/model');
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/model'));
  });
  it('guards the selected workspace from the new chat page', async () => {
    api.confirm.mockResolvedValue(false);
    selectWorkspace({ project_id: 's' } as never);
    const router = mount('/guid');
    await go(router, '/settings/model');
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith('s'));
    expect(router.state.location.pathname).toBe('/guid');
  });
  it('asks nothing when no workspace is involved', async () => {
    const router = mount('/guid');
    await go(router, '/settings/model');
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/model'));
    expect(api.confirm).not.toHaveBeenCalled();
  });
  it('asks nothing for a change that stays on the same page', async () => {
    const router = mount();
    await go(router, '/conversation/current?tab=files');
    await waitFor(() => expect(router.state.location.search).toBe('?tab=files'));
    expect(api.confirm).not.toHaveBeenCalled();
  });
  it('leaves web sessions unguarded, as they have no native close', async () => {
    api.desktop.mockReturnValue(false);
    const router = mount();
    await go(router, '/settings/model');
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/model'));
    expect(api.confirm).not.toHaveBeenCalled();
    expect((window as Window & { __confirmWorkspaceClose?: unknown }).__confirmWorkspaceClose).toBeUndefined();
  });
  it('checks both the open and the selected workspace on native close', async () => {
    api.confirm.mockResolvedValue(true);
    selectWorkspace({ project_id: 's' } as never);
    mount();
    const guard = (window as Window & { __confirmWorkspaceClose: () => Promise<boolean> }).__confirmWorkspaceClose;
    expect(await guard()).toBe(true);
    expect(api.confirm.mock.calls.map(([id]) => id)).toEqual(['p', 's']);
  });
  it('closes without asking twice when both are the same workspace', async () => {
    api.confirm.mockResolvedValue(true);
    selectWorkspace({ project_id: 'p' } as never);
    mount();
    const guard = (window as Window & { __confirmWorkspaceClose: () => Promise<boolean> }).__confirmWorkspaceClose;
    expect(await guard()).toBe(true);
    expect(api.confirm).toHaveBeenCalledOnce();
  });
});
