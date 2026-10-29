import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DiffPreview from '@/renderer/pages/conversation/Preview/components/viewers/DiffViewer';
import type { PreviewMetadata } from '@/renderer/pages/conversation/Preview/context/PreviewContext';

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/renderer/utils/file/previewPayload', () => ({ resolvePreviewPayload: read }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/hooks/ui/useTextSelection', () => ({ useTextSelection: () => ({ selectedText: '' }) }));
vi.mock('@/renderer/pages/conversation/Preview/components/renderers/SelectionToolbar', () => ({ default: () => null }));
vi.mock('react-syntax-highlighter', () => ({ default: ({ children }: { children: string }) => <pre>{children}</pre> }));

const patch = 'diff --git a/main.ts b/main.ts\n--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+staged\n';
const metadata: PreviewMetadata = {
  file_name: 'main.ts',
  fileRef: { kind: 'project', pe_id: 'app', relative_path: 'main.ts' },
  scmDiff: {
    request: { repository: 'repo', file: { pe_id: 'app', relative_path: 'main.ts' }, from: 'committed', to: 'staged' },
  },
};
beforeEach(() => {
  read.mockReset().mockResolvedValue({ content: 'latest working tree', oversized: false });
});
afterEach(cleanup);

describe('Git source preview', () => {
  it('reports an oversized comparison instead of claiming the file has no changes', () => {
    render(
      <DiffPreview
        content=''
        metadata={{ ...metadata, scmDiff: { ...metadata.scmDiff!, truncated: true } }}
        viewMode='preview'
      />
    );
    expect(screen.getByText('preview.oversized.title')).toBeInTheDocument();
    expect(screen.queryByText('conversation.explorer.scm.diff.empty')).not.toBeInTheDocument();
  });
  it('reads the working file even when the selected diff is staged', async () => {
    render(<DiffPreview content={patch} metadata={metadata} viewMode='source' />);
    expect(await screen.findByText('latest working tree')).toBeInTheDocument();
    expect(read).toHaveBeenCalledWith(metadata.fileRef, 'code');
    expect(screen.queryByText(/diff --git/)).not.toBeInTheDocument();
  });

  it('reads again on source selection and window focus', async () => {
    const { rerender } = render(<DiffPreview content={patch} metadata={metadata} viewMode='source' />);
    await screen.findByText('latest working tree');
    rerender(<DiffPreview content={patch} metadata={metadata} viewMode='preview' />);
    read.mockResolvedValue({ content: 'second edit', oversized: false });
    rerender(<DiffPreview content={patch} metadata={metadata} viewMode='source' />);
    await screen.findByText('second edit');
    read.mockResolvedValue({ content: 'third edit', oversized: false });
    act(() => window.dispatchEvent(new Event('focus')));
    await screen.findByText('third edit');
  });

  it('shows an unavailable notice for deleted files instead of a patch', async () => {
    read.mockRejectedValue(new Error('missing'));
    render(<DiffPreview content={patch} metadata={metadata} viewMode='source' />);
    expect(await screen.findByText('preview.refresh.failed')).toBeInTheDocument();
    expect(screen.queryByText(/diff --git/)).not.toBeInTheDocument();
  });

  it('does not display a partial source for oversized files', async () => {
    read.mockResolvedValue({ content: '', oversized: true });
    render(<DiffPreview content={patch} metadata={metadata} viewMode='source' />);
    expect(await screen.findByText('preview.oversized.title')).toBeInTheDocument();
  });

  it('keeps patch source for generic diffs', () => {
    render(<DiffPreview content={patch} viewMode='source' />);
    expect(screen.getByText(/diff --git/)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it('reads fresh source after refresh even when the staged patch did not change', async () => {
    const { rerender } = render(<DiffPreview content={patch} metadata={metadata} viewMode='source' />);
    await screen.findByText('latest working tree');
    read.mockResolvedValue({ content: 'unstaged edit after refresh', oversized: false });
    rerender(<DiffPreview content={patch} metadata={{ ...metadata }} viewMode='source' />);
    await screen.findByText('unstaged edit after refresh');
  });

  it('shows a notice instead of decoding a known binary file', async () => {
    render(
      <DiffPreview
        content=''
        metadata={{ ...metadata, scmDiff: { ...metadata.scmDiff!, binary: true } }}
        viewMode='source'
      />
    );
    await screen.findByText('conversation.explorer.scm.diff.binary');
    expect(read).not.toHaveBeenCalled();
  });

  it('ignores a slow response after selecting another file', async () => {
    let finishFirst!: (value: { content: string; oversized: boolean }) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        })
    );
    const { rerender } = render(<DiffPreview content={patch} metadata={metadata} viewMode='source' />);
    const other: PreviewMetadata = {
      ...metadata,
      fileRef: { kind: 'project', pe_id: 'app', relative_path: 'other.ts' },
    };
    rerender(<DiffPreview content={patch} metadata={other} viewMode='source' />);
    await screen.findByText('latest working tree');
    await act(async () => finishFirst({ content: 'stale first file', oversized: false }));
    await waitFor(() => expect(screen.queryByText('stale first file')).not.toBeInTheDocument());
  });
});
