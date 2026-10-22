/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Compare JSON-shaped data structurally so property order and object identity cannot change the result.
 * Only records and arrays are inspected; every other non-primitive compares by reference.
 */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (Array.isArray(right)) return false;
  const source = left as Record<string, unknown>;
  const target = right as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== Object.keys(target).length) return false;
  return keys.every((key) => Object.hasOwn(target, key) && deepEqual(source[key], target[key]));
}
