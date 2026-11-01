import React from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';

const api = vi.hoisted(() => ({ get: vi.fn(), track: vi.fn(), capture: vi.fn(), desktop: vi.fn(() => true) }));
vi.mock('@/common', () => ({
  ipcBridge: {
    project: { get: { invoke: api.get } },
    gitStorage: { historyTrack: { invoke: api.track }, historyCapture: { invoke: api.capture } },
  },
}));
vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: api.desktop }));

import {
  recordProjectSave,
  useProjectHistory,
} from '@/renderer/pages/conversation/SourceControl/Workbench/Storage/useProjectHistory';
import { deferred } from './fixtures';

const project = (roots: [string, string][]) => ({
  project_id: 'p',
  explorer: {
    entries: roots.map(([pe_id, runtime_status]) => ({ pe_id, display_path: `/${pe_id}`, runtime_status })),
  },
});
const mount = (initialId: string | null = 'p') =>
  renderHook(({ id }) => useProjectHistory(id), {
    initialProps: { id: initialId },
    wrapper: ({ children }) => <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>,
  });
const tracked = () => api.track.mock.calls.map(([request]) => request.projectId);
const file = { kind: 'project', pe_id: 'r', relative_path: 'src/a.ts' } as const;

beforeEach(() => {
  api.desktop.mockReturnValue(true);
  api.get.mockResolvedValue(project([['r', 'available']]));
  api.track.mockResolvedValue(undefined);
  api.capture.mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  cleanup();
  // Leaving a project queues one last tracking call; let it finish before the next test counts calls.
  await recordProjectSave('p', file);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('project history recording', () => {
  it('starts for the open project', async () => {
    mount();

    await waitFor(() => expect(tracked()).toContain('p'));
  });

  it('stops when the window leaves the project', async () => {
    const view = mount();
    await waitFor(() => expect(tracked()).toContain('p'));

    view.unmount();

    await waitFor(() => expect(tracked().at(-1)).toBeNull());
  });

  it('follows a change of project in order', async () => {
    const view = mount();
    await waitFor(() => expect(api.get).toHaveBeenCalled());

    view.rerender({ id: 'q' });

    await waitFor(() => expect(tracked().at(-1)).toBe('q'));
    expect(tracked().indexOf(null)).toBeLessThan(tracked().lastIndexOf('q'));
  });

  it('does not touch the backend outside the desktop app', async () => {
    api.desktop.mockReturnValue(false);
    mount();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.get).not.toHaveBeenCalled();
    expect(api.track).not.toHaveBeenCalled();
  });

  it('keeps going after one tracking call fails', async () => {
    api.track.mockRejectedValueOnce(new Error('offline'));
    const view = mount();
    await waitFor(() => expect(console.error).toHaveBeenCalled());

    view.rerender({ id: 'q' });

    await waitFor(() => expect(tracked().at(-1)).toBe('q'));
  });
});

describe('recording a save', () => {
  it('records the saved file', async () => {
    await recordProjectSave('p', file);

    expect(api.capture).toHaveBeenCalledWith({
      scope: { projectId: 'p', peId: 'r', relativePath: '' },
      request: { paths: ['src/a.ts'], kind: 'save' },
    });
  });

  it('waits for recording to start first, so the save has a baseline', async () => {
    const starting = deferred<undefined>();
    api.track.mockReturnValueOnce(starting.promise);
    mount();
    await waitFor(() => expect(api.track).toHaveBeenCalled());

    const saving = recordProjectSave('p', file);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.capture).not.toHaveBeenCalled();

    starting.resolve(undefined);
    await saving;
    expect(api.capture).toHaveBeenCalledOnce();
  });

  it('records a save even if starting failed', async () => {
    api.track.mockRejectedValueOnce(new Error('offline'));
    mount();
    await waitFor(() => expect(api.track).toHaveBeenCalled());

    await recordProjectSave('p', file);

    expect(api.capture).toHaveBeenCalledOnce();
  });

  it.each([
    ['no project', null, file],
    ['a file outside any project', 'p', { kind: 'absolute', path: '/tmp/a' }],
  ])('ignores %s', async (_name, projectId, target) => {
    await recordProjectSave(projectId, target as never);

    expect(api.capture).not.toHaveBeenCalled();
  });

  it('does nothing outside the desktop app', async () => {
    api.desktop.mockReturnValue(false);

    await recordProjectSave('p', file);

    expect(api.capture).not.toHaveBeenCalled();
  });
});
