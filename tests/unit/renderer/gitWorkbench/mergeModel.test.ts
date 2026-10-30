import { describe, expect, it } from 'vitest';
import type { GitMergeDocument } from '@/common/types/sourceControl/mergeTypes';
import {
  createEditorState,
  rebuildResult,
  editResult,
  resultText,
  progressOf,
} from '@/renderer/pages/conversation/SourceControl/Workbench/Merge/editorState';

const stage = (text: string) => ({ oid: 'a'.repeat(40), mode: '100644', text, binary: false, deleted: false });
const document: GitMergeDocument = {
  file: 'a.txt',
  version: 'v1',
  head: 'a'.repeat(40),
  branch: 'main',
  operation: 'merge',
  stages: { base: stage('base\r\n'), ours: stage('ours\r\n'), theirs: stage('theirs\r\n') },
  result: 'my unfinished manual edit\r\n',
  binary: false,
  crlf: true,
};
describe('merge editor recovery', () => {
  it('preserves existing manual working content until explicitly rebuilt', () => {
    const state = createEditorState(document);
    expect(resultText(state, document.crlf)).toBe(document.result);
    expect(state.manual).toBe(true);
    expect(progressOf(state)).toBeUndefined();
  });
  it('restores a saved partial model including unresolved ranges', () => {
    const state = rebuildResult(document);
    state.model.replaceChange(0, 'left', true);
    const result = resultText(state, true);
    const reopened = createEditorState({ ...document, result, progress: progressOf(state) });
    expect(resultText(reopened, true)).toBe('ours\r\n');
    expect(reopened.model.unresolved).toHaveLength(0);
    expect(reopened.manual).toBe(false);
  });
  it('does not overwrite result with inconsistent saved progress', () => {
    const state = rebuildResult(document);
    const reopened = createEditorState({ ...document, progress: progressOf(state) });
    expect(reopened.manual).toBe(true);
    expect(resultText(reopened, true)).toBe(document.result);
  });
  it('manual editing invalidates previous resolved acknowledgements and preserves CRLF', () => {
    const state = rebuildResult(document);
    state.model.acceptRevisionForSide('left');
    const edited = editResult(state, 'changed\n');
    expect(resultText(edited, true)).toBe('changed\r\n');
    expect(edited.manual).toBe(true);
    expect(progressOf(edited)).toBeUndefined();
  });
});
