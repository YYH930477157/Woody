import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const language = vi.hoisted(() => ({ load: vi.fn(), large: vi.fn() }));
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({ useThemeContext: () => ({ theme: 'light' }) }));
vi.mock('@/renderer/pages/conversation/Preview/theme/languageLoader', () => ({
  loadLanguageSupport: language.load,
  shouldDisableHighlighting: language.large,
}));

import { MergePane } from '@/renderer/pages/conversation/SourceControl/Workbench/Merge/MergePane';
import { deferred } from './fixtures';

const editor = () => {
  const dom = document.querySelector('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom as HTMLElement);
  if (!view) throw new Error('editor not mounted');
  return view;
};
const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');
const scrolledTo = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map(([position]) => position);

beforeAll(() => {
  // jsdom has no layout, and CodeMirror measures text as soon as it mounts.
  const rects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects = rects;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  HTMLElement.prototype.getClientRects = rects;
});
beforeEach(() => {
  language.load.mockReset();
  language.load.mockResolvedValue(undefined);
  language.large.mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('merge pane', () => {
  it('labels the pane and shows the text', async () => {
    render(<MergePane title='Ours' value='hello' file='a.ts' />);

    await waitFor(() => expect(editor().state.doc.toString()).toBe('hello'));
    expect(screen.getByRole('region', { name: 'Ours' })).toBeVisible();
  });

  it('scrolls to the first change when it opens', async () => {
    const scroll = vi.spyOn(EditorView, 'scrollIntoView');
    render(<MergePane title='Result' value={lines(500)} file='a.ts' line={300} />);

    await waitFor(() => expect(scrolledTo(scroll)).toContain(editor().state.doc.line(301).from));
  });

  it('scrolls again when the selected change moves', async () => {
    const scroll = vi.spyOn(EditorView, 'scrollIntoView');
    const view = render(<MergePane title='Result' value={lines(500)} file='a.ts' line={0} />);
    await waitFor(() => expect(editor()).toBeDefined());

    view.rerender(<MergePane title='Result' value={lines(500)} file='a.ts' line={120} />);

    await waitFor(() => expect(scrolledTo(scroll)).toContain(editor().state.doc.line(121).from));
  });

  it('stays inside the document when a change points past its end', async () => {
    const scroll = vi.spyOn(EditorView, 'scrollIntoView');
    render(<MergePane title='Result' value={lines(3)} file='a.ts' line={40} />);

    await waitFor(() => expect(scrolledTo(scroll)).toContain(editor().state.doc.line(3).from));
  });

  it('reports what the user types', async () => {
    const onChange = vi.fn();
    render(<MergePane title='Result' value='hello' file='a.ts' readOnly={false} onChange={onChange} />);
    await waitFor(() => expect(editor()).toBeDefined());

    act(() => editor().dispatch({ changes: { from: 5, insert: ' world' } }));

    expect(onChange).toHaveBeenLastCalledWith('hello world', expect.anything());
  });

  it('does not mistake accepting a change for typing', async () => {
    const onChange = vi.fn();
    const view = render(<MergePane title='Result' value='before' file='a.ts' readOnly={false} onChange={onChange} />);
    await waitFor(() => expect(editor()).toBeDefined());

    view.rerender(<MergePane title='Result' value='after' file='a.ts' readOnly={false} onChange={onChange} />);

    await waitFor(() => expect(editor().state.doc.toString()).toBe('after'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('cannot be edited while read-only', async () => {
    render(<MergePane title='Ours' value='hello' file='a.ts' />);
    await waitFor(() => expect(editor()).toBeDefined());

    expect(editor().state.readOnly).toBe(true);
    expect(document.querySelector('.cm-content')).toHaveAttribute('contenteditable', 'false');
  });

  it('skips highlighting for a very large file', async () => {
    language.large.mockReturnValue(true);
    render(<MergePane title='Ours' value='hello' file='a.ts' />);
    await waitFor(() => expect(editor()).toBeDefined());

    expect(language.load).not.toHaveBeenCalled();
  });

  it('survives a language that finishes loading after the pane closed', async () => {
    const loading = deferred<undefined>();
    language.load.mockReturnValue(loading.promise);
    const view = render(<MergePane title='Ours' value='hello' file='a.ts' />);
    await waitFor(() => expect(language.load).toHaveBeenCalled());

    view.unmount();

    await act(async () => loading.resolve(undefined));
  });
});
