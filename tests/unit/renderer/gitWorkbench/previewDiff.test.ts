import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ compare: vi.fn(), fetch: vi.fn() }));
vi.mock('@/common/adapter/ipcBridge', () => ({ gitWorkbench: { compare: { invoke: api.compare } } }));
vi.mock('@/renderer/pages/conversation/SourceControl/scmStore', () => ({ fetchScmDiff: api.fetch }));

import {
  previewDiffKey,
  readPreviewDiff,
  type PreviewDiffRequest,
} from '@/renderer/pages/conversation/SourceControl/Workbench/Diff/previewDiff';

const scope = { projectId: 'p', peId: 'r', relativePath: '' };
const workbench = {
  kind: 'workbench',
  scope,
  file: 'a.ts',
  from: { kind: 'commit', hash: 'a' },
  to: { kind: 'worktree' },
} as unknown as PreviewDiffRequest;
const webui = {
  repository: 'repo',
  file: { path: 'a.ts' },
  from: 'HEAD',
  to: 'WORKTREE',
} as unknown as PreviewDiffRequest;

beforeEach(() => vi.clearAllMocks());

describe('preview diff', () => {
  it('reads a desktop comparison through its project scope', async () => {
    api.compare.mockResolvedValue({ patch: 'p', binary: false, truncated: false });

    await expect(readPreviewDiff(workbench)).resolves.toEqual({ patch: 'p', binary: false, truncated: false });

    expect(api.compare).toHaveBeenCalledWith({
      scope,
      request: { file: 'a.ts', from: { kind: 'commit', hash: 'a' }, to: { kind: 'worktree' } },
    });
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('reads a web comparison through the repository protocol', async () => {
    api.fetch.mockResolvedValue({ patch: 'p', binary: false, truncated: true });

    await expect(readPreviewDiff(webui)).resolves.toEqual({ patch: 'p', binary: false, truncated: true });

    expect(api.compare).not.toHaveBeenCalled();
  });

  it('turns a web response with no patch into an empty one', async () => {
    api.fetch.mockResolvedValue({ patch: null, binary: true, truncated: false });

    await expect(readPreviewDiff(webui)).resolves.toEqual({ patch: '', binary: true, truncated: false });
  });

  it('surfaces a failed read', async () => {
    api.compare.mockRejectedValue(new Error('no such revision'));

    await expect(readPreviewDiff(workbench)).rejects.toThrow('no such revision');
  });

  it('gives the same comparison the same tab', () => {
    expect(previewDiffKey(workbench)).toBe(previewDiffKey({ ...workbench }));
  });

  it('gives different comparisons different tabs', () => {
    const otherFile = { ...workbench, file: 'b.ts' } as PreviewDiffRequest;
    const otherScope = { ...workbench, scope: { ...scope, peId: 'other' } } as PreviewDiffRequest;

    expect(new Set([workbench, otherFile, otherScope, webui].map(previewDiffKey)).size).toBe(4);
  });
});
