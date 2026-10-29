import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
const api = vi.hoisted(() => ({ confirm: vi.fn(), conversation: vi.fn() }));
vi.mock('@/common', () => ({ ipcBridge: { conversation: { get: { invoke: api.conversation } } } }));
vi.mock('@/renderer/components/workspace/WorkspaceManager/lifecycle', () => ({
  confirmWorkspaceLeave: api.confirm,
  registerWorkspaceDiscardGuard: () => () => {},
}));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => null,
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('@/renderer/services/i18n', () => ({ default: { t: (key: string) => key } }));
import WorkspaceNavigationGuard from '@/renderer/components/workspace/WorkspaceManager/WorkspaceNavigationGuard';
import { setCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { selectWorkspace } from '@/renderer/components/workspace/workspaceSelection';
afterEach(() => {
  cleanup();
  setCurrentProject(null);
  selectWorkspace(null);
  vi.clearAllMocks();
});
const mount = () => {
  setCurrentProject('p');
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
        ],
      },
    ],
    { initialEntries: ['/settings/model', '/conversation/current'], initialIndex: 1 }
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
});
