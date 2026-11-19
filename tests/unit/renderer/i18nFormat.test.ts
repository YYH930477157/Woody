/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  formatByteRate,
  formatByteSize,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  formatTime,
  resolveFormatLocale,
} from '@/renderer/services/i18n/format';

// A fixed instant so the assertions below are not clock-dependent:
// 2025-08-17T11:06:40Z.
const INSTANT = Date.UTC(2025, 7, 17, 11, 6, 40);

describe('resolveFormatLocale', () => {
  it('passes through a supported language tag', () => {
    expect(resolveFormatLocale('en-US')).toBe('en-US');
    expect(resolveFormatLocale('zh-CN')).toBe('zh-CN');
  });

  it('narrows any other tag to one of the two shipped languages', () => {
    // The host OS locale is routinely something AionUi does not ship.
    expect(resolveFormatLocale('zh-HK')).toBe('zh-CN');
    expect(resolveFormatLocale('de_AT')).toBe('en-US');
  });

  it('falls back to the default language for unknown or empty input', () => {
    expect(resolveFormatLocale('kl-GL')).toBe('en-US');
    expect(resolveFormatLocale('')).toBe('en-US');
    expect(resolveFormatLocale(undefined)).toBe('en-US');
    expect(resolveFormatLocale(null)).toBe('en-US');
  });
});

describe('formatNumber', () => {
  it('formats in the app language, never in a host locale AionUi does not ship', () => {
    expect(formatNumber(12.6, 'en-US', { minimumFractionDigits: 1 })).toBe('12.6');
    expect(formatNumber(12.6, 'zh-CN', { minimumFractionDigits: 1 })).toBe('12.6');
    // A German host would write 12,6; the app shows English instead.
    expect(formatNumber(12.6, 'de-DE', { minimumFractionDigits: 1 })).toBe('12.6');
  });

  it('groups thousands', () => {
    expect(formatNumber(1234567, 'en-US')).toBe('1,234,567');
    expect(formatNumber(1234567, 'zh-CN')).toBe('1,234,567');
  });
});

describe('formatCurrency', () => {
  it('renders the amount in the app language', () => {
    expect(formatCurrency(0.42, 'USD', 'en-US', { maximumFractionDigits: 4 })).toBe('$0.42');
    // Chinese marks a foreign dollar amount with its country.
    expect(formatCurrency(0.42, 'USD', 'zh-CN', { maximumFractionDigits: 4 })).toBe('US$0.42');
  });

  it('keeps sub-cent precision up to four fraction digits', () => {
    expect(formatCurrency(1.2345, 'USD', 'en-US', { maximumFractionDigits: 4 })).toBe('$1.2345');
  });

  it('falls back to "<amount> <code>" when the currency code is not renderable', () => {
    // A two-letter code is not a well-formed ISO 4217 currency, so
    // Intl.NumberFormat throws rather than rendering it.
    expect(formatCurrency(0.42, 'US', 'en-US', { maximumFractionDigits: 4 })).toBe('0.4200 US');
    expect(formatCurrency(0.42, 'US', 'zh-CN', { maximumFractionDigits: 4 })).toBe('0.4200 US');
  });
});

describe('formatDateTime / formatDate / formatTime', () => {
  it('formats a timestamp in the app language', () => {
    const en = formatDateTime(INSTANT, 'en-US', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
    const zh = formatDateTime(INSTANT, 'zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
    expect(en).toBe('8/17/2025');
    expect(zh).toBe('2025/8/17');
  });

  it('reproduces toLocaleString() defaults when no options are given', () => {
    const date = new Date(INSTANT);
    expect(formatDateTime(INSTANT, 'zh-CN')).toBe(date.toLocaleString('zh-CN'));
    expect(formatDate(INSTANT, 'zh-CN')).toBe(date.toLocaleDateString('zh-CN'));
    expect(formatTime(INSTANT, 'zh-CN')).toBe(date.toLocaleTimeString('zh-CN'));
  });

  it('ignores the host locale entirely', () => {
    // Whatever the runner's locale is, an explicit language wins.
    const de = formatDateTime(INSTANT, 'de-DE', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
    expect(de).toBe('8/17/2025');
  });
});

describe('formatByteSize / formatByteRate', () => {
  it('picks binary units and one fraction digit by default', () => {
    expect(formatByteSize(0, 'en-US')).toBe('0 B');
    expect(formatByteSize(512, 'en-US')).toBe('512 B');
    expect(formatByteSize(12_800, 'en-US')).toBe('12.5 KB');
    expect(formatByteSize(3.5 * 1024 * 1024, 'en-US')).toBe('3.5 MB');
    expect(formatByteSize(2 * 1024 ** 3, 'en-US')).toBe('2 GB');
  });

  it('formats sizes and rates in Chinese the same way', () => {
    expect(formatByteSize(12_800, 'zh-CN')).toBe('12.5 KB');
    expect(formatByteRate(12_800, 'zh-CN')).toBe('12.5 KB/s');
  });

  it('honours the requested precision', () => {
    expect(formatByteSize(1024 * 1024 * 1.0002, 'en-US', 4)).toBe('1.0002 MB');
    expect(formatByteSize(1024 * 1024 * 1.0002, 'en-US', 1)).toBe('1 MB');
  });
});
