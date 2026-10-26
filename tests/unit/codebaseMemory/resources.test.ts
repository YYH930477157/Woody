import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveCodebaseMemoryResources } from '@/process/services/codebaseMemory/resources';

describe('bundled codebase memory resource paths', () => {
  it('uses user-local cache outside a shared repository and resolves packaged assets', () => {
    const result = resolveCodebaseMemoryResources({
      resourceRoot: 'D:/Woody/resources',
      localAppData: 'C:/Users/me/AppData/Local',
      userData: 'C:/Users/me/AppData/Roaming/AionUi',
    });
    expect(result.cacheRoot).toBe(path.join('C:/Users/me/AppData/Local', 'AionUi', 'codebase-memory'));
    expect(result.binaryPath).toBe(
      path.join('D:/Woody/resources', 'bundled-mcp/codebase-memory/bin/win32-x64/codebase-memory-mcp.exe')
    );
    expect(result.skillPath).toBe(
      path.join('D:/Woody/resources', 'bundled-mcp/codebase-memory/skills/woody-codebase-memory/SKILL.md')
    );
  });
  it('falls back to the app user directory when LOCALAPPDATA is absent', () => {
    const result = resolveCodebaseMemoryResources({ resourceRoot: '/resources', userData: '/user/AionUi' });
    expect(result.cacheRoot).toBe(path.join('/user/AionUi', 'codebase-memory'));
  });
});
