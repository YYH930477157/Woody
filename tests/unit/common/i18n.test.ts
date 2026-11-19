/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { normalizeLanguageCode, DEFAULT_LANGUAGE } from '@/common/config/i18n';

describe('i18n', () => {
  describe('normalizeLanguageCode', () => {
    it('passes through exact supported tags', () => {
      expect(normalizeLanguageCode('en-US')).toBe('en-US');
      expect(normalizeLanguageCode('zh-CN')).toBe('zh-CN');
    });

    it('normalizes underscores to hyphens', () => {
      expect(normalizeLanguageCode('zh_CN')).toBe('zh-CN');
      expect(normalizeLanguageCode('en_US')).toBe('en-US');
    });

    it('resolves every Chinese variant to Simplified Chinese', () => {
      for (const tag of ['zh', 'zh-TW', 'zh-HK', 'zh_HK', 'zh-Hant', 'zh-Hant-HK', 'zh-SG'])
        expect(normalizeLanguageCode(tag), tag).toBe('zh-CN');
    });

    it('resolves the languages AionUi no longer ships to English', () => {
      for (const tag of ['ja-JP', 'ko', 'de-DE', 'de_AT', 'fa-IR', 'ru', 'pt-BR', 'en-GB'])
        expect(normalizeLanguageCode(tag), tag).toBe('en-US');
    });

    it('falls back to the default language for unsupported codes', () => {
      expect(normalizeLanguageCode('it')).toBe(DEFAULT_LANGUAGE);
      expect(normalizeLanguageCode('')).toBe(DEFAULT_LANGUAGE);
    });
  });
});
