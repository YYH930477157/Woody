/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fullActionsWidth, useFooterLayout } from '@/renderer/components/chat/SendBox/useFooterLayout';

let resizeCallback: ResizeObserverCallback | null = null;

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {
    resizeCallback = null;
  }
}

const width = (element: HTMLElement, value: number, prop: 'offsetWidth' | 'clientWidth' | 'scrollWidth') => {
  Object.defineProperty(element, prop, { configurable: true, value });
};

/**
 * The right-side tools: a permission pill whose label shows `shown` px of text,
 * with `full` px for its full label, plus `rest` px of rigid buttons.
 */
function actionsEl({ rest, shown, full, room }: { rest: number; shown: number; full: number; room?: number }) {
  const actions = document.createElement('div');
  const label = document.createElement('span');
  label.setAttribute('data-pill-label', '');
  const text = document.createElement('span');
  text.setAttribute('data-pill-text', '');
  const fullText = document.createElement('span');
  fullText.setAttribute('data-pill-full-text', '');
  label.append(text, fullText);
  actions.append(label);
  const labelBox = Math.min(shown, room ?? shown);
  width(text, shown, 'offsetWidth');
  width(fullText, full, 'offsetWidth');
  width(label, labelBox, 'clientWidth');
  width(actions, rest + labelBox, 'offsetWidth');
  width(actions, rest + labelBox, 'scrollWidth');
  return actions;
}

/** A footer row: left tools, an optional status strip slot, the right-side tools. */
function footer(options: { row: number; left: number; strip?: number; actions: HTMLElement }) {
  const row = document.createElement('div');
  row.style.columnGap = '8px';
  const left = document.createElement('div');
  row.append(left);
  let slot: HTMLElement | null = null;
  if (options.strip !== undefined) {
    slot = document.createElement('div');
    const strip = document.createElement('div');
    width(strip, options.strip, 'offsetWidth');
    slot.append(strip);
    row.append(slot);
  }
  row.append(options.actions);
  document.body.append(row);
  width(row, options.row, 'clientWidth');
  width(left, options.left, 'offsetWidth');
  return {
    row,
    hasSlot: slot !== null,
    refs: {
      row: { current: row },
      slot: { current: slot },
      left: { current: left },
      actions: { current: options.actions },
    },
  };
}

// Measured in the app: + and draft buttons 70px; "权限 · 全自动" pill text 84px
// ("全自动" alone 40px) beside 80px of icon, caret and send button; strip 383px.
const LEFT = 70;
const REST = 80;
const FULL_LABEL = 84;
const SHORT_LABEL = 40;
const STRIP = 383;

describe('useFooterLayout', () => {
  beforeEach(() => {
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    resizeCallback = null;
  });

  it('keeps everything on one row when it fits', () => {
    const actions = actionsEl({ rest: REST, shown: FULL_LABEL, full: FULL_LABEL });
    const { refs, hasSlot } = footer({ row: 900, left: LEFT, strip: STRIP, actions });
    const { result } = renderHook(() => useFooterLayout(refs, true, hasSlot));
    expect(result.current).toEqual({ stackBottomTools: false, actionsTight: false });
  });

  it('moves the strip up first while the buttons still fit in full', () => {
    const actions = actionsEl({ rest: REST, shown: FULL_LABEL, full: FULL_LABEL });
    const { refs, hasSlot } = footer({ row: 480, left: LEFT, strip: STRIP, actions });
    const { result } = renderHook(() => useFooterLayout(refs, true, hasSlot));
    expect(result.current).toEqual({ stackBottomTools: true, actionsTight: false });
  });

  it('reports the buttons short of room once even their own row is too narrow', () => {
    // 215 - 70 - 2 * 8 = 129px for 80 + 84 = 164px of buttons in full.
    const actions = actionsEl({ rest: REST, shown: FULL_LABEL, full: FULL_LABEL, room: 49 });
    const { refs, hasSlot } = footer({ row: 215, left: LEFT, strip: STRIP, actions });
    const { result } = renderHook(() => useFooterLayout(refs, true, hasSlot));
    expect(result.current).toEqual({ stackBottomTools: true, actionsTight: true });
  });

  it('stays short of room with the prefix dropped, then recovers when the box widens', () => {
    // The pill now shows "全自动", which fits, but the full label still would not.
    const actions = actionsEl({ rest: REST, shown: SHORT_LABEL, full: FULL_LABEL });
    const { row, refs, hasSlot } = footer({ row: 215, left: LEFT, strip: STRIP, actions });
    const { result } = renderHook(() => useFooterLayout(refs, true, hasSlot));
    expect(result.current.actionsTight).toBe(true);

    width(row, 70 + 16 + 80 + 84, 'clientWidth');
    act(() => resizeCallback?.([], {} as ResizeObserver));
    expect(result.current.actionsTight).toBe(false);
  });

  it('counts one gap when the box has no status strip', () => {
    const actions = actionsEl({ rest: REST, shown: FULL_LABEL, full: FULL_LABEL });
    const fits = footer({ row: LEFT + 8 + REST + FULL_LABEL, left: LEFT, actions });
    expect(renderHook(() => useFooterLayout(fits.refs, true, fits.hasSlot)).result.current.actionsTight).toBe(false);
    document.body.innerHTML = '';

    const tight = footer({ row: LEFT + 8 + REST + FULL_LABEL - 1, left: LEFT, actions });
    expect(renderHook(() => useFooterLayout(tight.refs, true, tight.hasSlot)).result.current.actionsTight).toBe(true);
  });

  it('does nothing when disabled', () => {
    const actions = actionsEl({ rest: REST, shown: FULL_LABEL, full: FULL_LABEL });
    const { refs, hasSlot } = footer({ row: 215, left: LEFT, strip: STRIP, actions });
    const { result } = renderHook(() => useFooterLayout(refs, false, hasSlot));
    expect(result.current).toEqual({ stackBottomTools: false, actionsTight: false });
  });
});

describe('fullActionsWidth', () => {
  it('adds back what a shrunk or shortened label hides', () => {
    expect(fullActionsWidth(actionsEl({ rest: REST, shown: FULL_LABEL, full: FULL_LABEL }))).toBe(164);
    // Shrunk to 30px of label: the full width is unchanged.
    expect(fullActionsWidth(actionsEl({ rest: REST, shown: FULL_LABEL, full: FULL_LABEL, room: 30 }))).toBe(164);
    // Showing the short label: still the full label's width.
    expect(fullActionsWidth(actionsEl({ rest: REST, shown: SHORT_LABEL, full: FULL_LABEL }))).toBe(164);
  });
});
