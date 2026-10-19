import { describe, expect, it } from 'vitest';
import { resolveShell } from '../../../packages/desktop/src/process/services/terminal/nativeTransport';

describe('shell selection', () => {
  it('prefers a configured executable and never silently changes it', () => {
    expect(resolveShell('D:\\tools\\pwsh.exe', { platform: 'win32', env: {}, exists: () => true })).toBe(
      'D:\\tools\\pwsh.exe'
    );
    expect(() => resolveShell('missing.exe', { platform: 'win32', env: {}, exists: () => false })).toThrow();
  });
  it('detects PowerShell 7 before the legacy fallback', () => {
    const result = resolveShell(undefined, {
      platform: 'win32',
      env: { PATH: 'D:\\ps7', SystemRoot: 'C:\\Windows' },
      exists: (p) => p === 'D:\\ps7\\pwsh.exe' || p.includes('WindowsPowerShell'),
    });
    expect(result).toBe('D:\\ps7\\pwsh.exe');
  });
  it('fails clearly when no usable local shell exists', () => {
    expect(() => resolveShell(undefined, { platform: 'win32', env: {}, exists: () => false })).toThrow();
  });
});
