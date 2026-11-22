/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, type RefObject, useContext, useLayoutEffect, useState } from 'react';

export type SendBoxFooterState = {
  /**
   * The right-side tools would not fit with their labels in full. Pills drop
   * the least informative part of their label then, such as the "权限 · "
   * prefix next to the shield icon, before their text starts to shrink.
   */
  actionsTight: boolean;
};

const ROOMY: SendBoxFooterState = { actionsTight: false };

export const SendBoxFooterContext = createContext<SendBoxFooterState>(ROOMY);

/** Footer state for tools rendered inside a send box; roomy anywhere else. */
export const useSendBoxFooter = (): SendBoxFooterState => useContext(SendBoxFooterContext);

export type FooterRefs = {
  /** The footer row holding the left tools, the bottom tools and the right-side tools. */
  row: RefObject<HTMLElement | null>;
  /** The bottom tools slot (the status strip); absent when there are none. */
  slot: RefObject<HTMLElement | null>;
  left: RefObject<HTMLElement | null>;
  actions: RefObject<HTMLElement | null>;
};

export type FooterLayout = SendBoxFooterState & {
  /** The status strip moves to a line of its own above the buttons. */
  stackBottomTools: boolean;
};

/**
 * Width of the right-side tools with every pill label in full and unclipped.
 * A pill that shrank, or shows a shortened label, adds back the difference
 * between its full text and the room its label has now. So the result does
 * not depend on which form is showing, and the layout cannot flip back and forth.
 */
export function fullActionsWidth(actions: HTMLElement): number {
  let width = Math.max(actions.offsetWidth, actions.scrollWidth);
  for (const label of Array.from(actions.querySelectorAll<HTMLElement>('[data-pill-label]'))) {
    const text =
      label.querySelector<HTMLElement>('[data-pill-full-text]') ?? label.querySelector<HTMLElement>('[data-pill-text]');
    if (text) width += Math.max(0, text.offsetWidth - label.clientWidth);
  }
  return width;
}

/**
 * Lays out a narrow send box footer, giving way in this order: the status strip
 * moves to its own line, then pills drop label prefixes, then pill text shrinks
 * (CSS). The left buttons never shrink, so nothing overlaps them.
 */
export function useFooterLayout(refs: FooterRefs, enabled: boolean, hasSlot: boolean): FooterLayout {
  const [layout, setLayout] = useState<FooterLayout>({ stackBottomTools: false, actionsTight: false });
  const { row: rowRef, slot: slotRef, left: leftRef, actions: actionsRef } = refs;

  useLayoutEffect(() => {
    const row = rowRef.current;
    const actions = actionsRef.current;
    if (!enabled || !row || !actions) {
      setLayout((current) =>
        current.stackBottomTools || current.actionsTight ? { stackBottomTools: false, actionsTight: false } : current
      );
      return;
    }
    const measure = () => {
      const slot = slotRef.current;
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      const left = leftRef.current?.offsetWidth ?? 0;
      let strip = 0;
      if (slot) for (const child of Array.from(slot.children)) strip += (child as HTMLElement).offsetWidth;
      const full = fullActionsWidth(actions);
      const gaps = slot ? 2 * gap : gap;
      // The strip shares the button row only beside the tools in full.
      const stackBottomTools = strip > 0 && strip > row.clientWidth - left - full - gaps;
      const room = row.clientWidth - left - gaps - (stackBottomTools ? 0 : strip);
      const actionsTight = full > room + 0.5;
      setLayout((current) =>
        current.stackBottomTools === stackBottomTools && current.actionsTight === actionsTight
          ? current
          : { stackBottomTools, actionsTight }
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;

    const resize = new ResizeObserver(measure);
    for (const element of [row, leftRef.current, actions]) {
      if (element) resize.observe(element);
    }
    // The strip appears once usage arrives and changes width with its numbers.
    const slot = slotRef.current;
    const observeStrip = () => {
      if (slot) for (const child of Array.from(slot.children)) resize.observe(child);
    };
    observeStrip();
    const mutations = new MutationObserver(() => {
      observeStrip();
      measure();
    });
    if (slot) mutations.observe(slot, { childList: true });
    // A pill can change its text (another mode) without changing its clipped size.
    mutations.observe(actions, { childList: true, subtree: true, characterData: true });
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, [enabled, hasSlot, rowRef, slotRef, leftRef, actionsRef]);

  return layout;
}
