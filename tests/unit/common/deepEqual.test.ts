/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { deepEqual } from '../../../packages/desktop/src/common/utils/deepEqual';

describe('deepEqual', () => {
  it('ignores property order and object identity', () => {
    expect(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(deepEqual([], [])).toBe(true);
    expect(deepEqual({ a: undefined }, {})).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });

  it('keeps arrays and objects distinct', () => {
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual({ a: [1] }, { a: { 0: 1 } })).toBe(false);
  });

  it('compares primitives and nullish values strictly', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(1, '1')).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(undefined, {})).toBe(false);
    expect(deepEqual(NaN, NaN)).toBe(true);
    expect(deepEqual(0, -0)).toBe(false);
  });

  it('reports a changed nested value instead of falling back to JSON text comparison', () => {
    const saved = { mode: 'auto', encoding: 'auto', powershellPath: '' };
    expect(deepEqual(saved, { powershellPath: '', encoding: 'auto', mode: 'auto' })).toBe(true);
    expect(deepEqual(saved, { ...saved, encoding: 'utf-8' })).toBe(false);
  });
});
