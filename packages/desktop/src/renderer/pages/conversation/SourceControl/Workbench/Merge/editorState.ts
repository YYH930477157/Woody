import { MergeModel, joinText, splitText } from '@/common/git/merge/mergeModel';
import type { GitMergeDocument, GitMergeProgress } from '@/common/types/sourceControl/mergeTypes';

export type MergeEditorState = { model: MergeModel; manual: boolean };

const modelFor = (document: GitMergeDocument) =>
  MergeModel.create(
    splitText(document.stages.base.text ?? '').lines,
    splitText(document.stages.ours.text ?? '').lines,
    splitText(document.stages.theirs.text ?? '').lines
  );

/** Working content wins over recovery metadata if anything is inconsistent. */
export function createEditorState(document: GitMergeDocument): MergeEditorState {
  const model = modelFor(document);
  const progress = document.progress;
  const result = splitText(document.result ?? '').lines;
  if (
    !document.recoveryStale &&
    progress &&
    progress.states.length === model.changes.length &&
    progress.lines.join('\n') === result.join('\n') &&
    progress.states.every(
      (state) =>
        Number.isInteger(state.start) &&
        Number.isInteger(state.end) &&
        state.start >= 0 &&
        state.end >= state.start &&
        state.end <= result.length
    )
  ) {
    model.lines = [...progress.lines];
    model.states = progress.states.map((state) => ({ ...state }));
    model.contentModified = progress.contentModified;
    return { model, manual: false };
  }
  model.lines = result;
  return { model, manual: true };
}

/** Explicit user action: build a new result from the three immutable index stages. */
export function rebuildResult(document: GitMergeDocument): MergeEditorState {
  const model = modelFor(document);
  model.resolveAllChangesAutomatically();
  model.takeEdits();
  return { model, manual: false };
}

/** Free editing requires a fresh acknowledgement; old range approvals cannot stage new text. */
export function editResult(state: MergeEditorState, text: string): MergeEditorState {
  const model = state.model.clone();
  model.lines = splitText(text).lines;
  model.contentModified = true;
  return { model, manual: true };
}

export const resultText = (state: MergeEditorState, crlf: boolean) => joinText(state.model.lines, crlf);
export const progressOf = (state: MergeEditorState): GitMergeProgress | undefined =>
  state.manual
    ? undefined
    : {
        lines: [...state.model.lines],
        states: state.model.states.map((item) => ({ ...item })),
        contentModified: state.model.contentModified,
      };
