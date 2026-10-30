import { describe, expect, it } from 'vitest';
import { MergeModel } from '@/common/git/merge/mergeModel';

describe('full revision acceptance', () => {
  it.each(['trim', 'whitespace'] as const)('preserves exact selected-side bytes under %s comparison', (policy) => {
    const left = [' a', 'B'];
    const model = MergeModel.create(['a', 'b'], left, ['a', 'R'], policy);
    model.acceptRevisionForSide('left');
    expect(model.lines).toEqual(left);
    expect(model.unresolved).toEqual([]);
    expect(model.states[0]).toMatchObject({ start: 1, end: 2, resolvedLeft: true, resolvedRight: true });
    const edits = model.takeEdits();
    let text = ['a', 'b'];
    for (const edit of edits) text.splice(edit.start, edit.end - edit.start, ...edit.lines);
    expect(text).toEqual(left);
  });
});
