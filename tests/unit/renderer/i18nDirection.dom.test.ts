/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { applyDocumentDirection, directionForLanguage, isRtlLanguage } from '@/renderer/services/i18n/direction';

describe('isRtlLanguage / directionForLanguage', () => {
  it('lays out both shipped languages, and anything that falls back to them, left to right', () => {
    for (const lang of ['en-US', 'zh-CN', 'zh-TW', 'fa-IR', 'fa', 'ja-JP']) {
      expect(isRtlLanguage(lang), lang).toBe(false);
      expect(directionForLanguage(lang), lang).toBe('ltr');
    }
  });

  it('defaults to LTR for missing input', () => {
    expect(isRtlLanguage(undefined)).toBe(false);
    expect(isRtlLanguage(null)).toBe(false);
    expect(directionForLanguage(undefined)).toBe('ltr');
  });
});

describe('applyDocumentDirection', () => {
  it('sets dir and the normalized language tag on <html>', () => {
    applyDocumentDirection('zh_CN');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('zh-CN');
    // A language AionUi no longer ships is shown in English.
    applyDocumentDirection('fa-IR');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en-US');
  });
});
