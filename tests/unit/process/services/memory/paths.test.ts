import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryDirectory, rustStrHash, sanitizeWorkspace } from '@process/services/memory/paths';

describe('the aionrs memory folder', () => {
  it('hashes a string exactly as Rust DefaultHasher does', () => {
    // Printed by a Rust 1.99 program: format!("{:x}", DefaultHasher over str).
    expect(rustStrHash('')).toBe('30406ea523c53def');
    expect(rustStrHash('a')).toBe('719b50b9a4f0e9f3');
    expect(rustStrHash('E:\\Code')).toBe('fa7f3f6143ffd921');
    expect(rustStrHash('中文工程')).toBe('744d2ce707a8ef96');
    expect(rustStrHash('E:\\very\\long\\path\\0123456789')).toBe('9e5eb0a19604ab5e');
    expect(rustStrHash('x'.repeat(250))).toBe('1e007262dcc4b255');
  });

  it('names a workspace folder the way aion-memory does', () => {
    expect(sanitizeWorkspace('E:\\Code')).toBe('E--Code');
    expect(sanitizeWorkspace('E:\\Code\\中文')).toBe('E--Code---');
    const long = `E:\\${'a'.repeat(250)}`;
    expect(sanitizeWorkspace(long)).toBe(`E--${'a'.repeat(197)}-${rustStrHash(long)}`);
  });

  it('lives under the config folder, or AIONRS_MEMORY_DIR when it is set', () => {
    expect(memoryDirectory('E:\\Code', 'C:\\Users\\me\\AppData\\Roaming', {})).toBe(
      path.join('C:\\Users\\me\\AppData\\Roaming', 'aionrs', 'projects', 'E--Code', 'memory')
    );
    expect(memoryDirectory('E:\\Code', 'ignored', { AIONRS_MEMORY_DIR: 'D:\\mem' })).toBe(
      path.join('D:\\mem', 'projects', 'E--Code', 'memory')
    );
  });
});
