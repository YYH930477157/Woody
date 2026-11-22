/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatStatusBar from '@/renderer/components/chat/ChatStatusBar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en-US' },
  }),
}));

const resizeCallbacks: ResizeObserverCallback[] = [];

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const fireResize = () => {
  act(() => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });
};

// Layout stand-in: the labelled strip is 383px wide; each of the three labels is
// 48px; compact drops the labels, their 4px gaps and 6px of each segment gap.
const FULL = 383;
const LABEL = 48;
const COMPACT = FULL - 3 * LABEL - 3 * 4 - 3 * 6;
let slotWidth = 0;

function defineLayout() {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('chat-status-bar')) return this.dataset.compact ? COMPACT : FULL;
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.dataset.testid === 'slot') return slotWidth;
      if (this.hasAttribute('data-status-label')) return this.closest('[data-compact]') ? 0 : LABEL;
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-status-label') ? LABEL : 0;
    },
  });
}

const usage = {
  input_tokens: 12000,
  output_tokens: 320,
  cache_creation_tokens: 0,
  cache_read_tokens: 9000,
  context_usage: 12320,
  context_provider_reported: true,
  context_window: 200000,
  duration_ms: 1500,
};

function renderBar(width: number) {
  slotWidth = width;
  return render(
    <div data-testid='slot'>
      <ChatStatusBar
        running={false}
        startedAtMs={null}
        firstTokenAtMs={null}
        finalElapsedMs={1500}
        usageStats={usage}
        getLiveTextLength={() => 0}
      />
    </div>
  );
}

describe('ChatStatusBar width', () => {
  beforeEach(() => {
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    defineLayout();
  });
  afterEach(() => {
    resizeCallbacks.length = 0;
    delete (HTMLElement.prototype as Partial<HTMLElement>).offsetWidth;
    delete (HTMLElement.prototype as Partial<HTMLElement>).clientWidth;
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollWidth;
  });

  it('shows labels when the strip fits', () => {
    const { container } = renderBar(500);
    expect(container.querySelector('.chat-status-bar')?.getAttribute('data-compact')).toBeNull();
    expect(container.textContent).toContain('Speed');
    expect(container.textContent).toContain('75%');
  });

  it('drops the labels but keeps speed, cache and time in a narrow column', () => {
    const { container } = renderBar(250);
    const bar = container.querySelector('.chat-status-bar');
    expect(bar?.getAttribute('data-compact')).toBe('true');
    expect(bar?.textContent).toContain('213.3 tok/s');
    expect(bar?.textContent).toContain('75%');
    expect(bar?.textContent).toContain('1.5s');
  });

  it('settles at the exact edge instead of flipping', () => {
    const { container } = renderBar(FULL);
    const bar = () => container.querySelector('.chat-status-bar')?.getAttribute('data-compact');
    expect(bar()).toBeNull();
    fireResize();
    expect(bar()).toBeNull();

    slotWidth = FULL - 1;
    fireResize();
    expect(bar()).toBe('true');
    // Measured while compact, the full width is still 383, so it stays compact.
    fireResize();
    expect(bar()).toBe('true');

    slotWidth = FULL;
    fireResize();
    expect(bar()).toBeNull();
  });
});
