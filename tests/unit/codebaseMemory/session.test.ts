import { describe, expect, it, vi } from 'vitest';
import type { IMcpServer, ISessionMcpServer } from '@/common/config/storage';
import { prepareCodebaseMemorySession } from '@/common/adapter/codebaseMemory/session';

const server = {
  id: 'cbm',
  name: 'woody-codebase-memory',
  enabled: true,
  builtin: true,
  transport: { type: 'stdio', command: 'node', args: ['generic.cjs'] },
} as IMcpServer;
const other = { id: 'other', name: 'other', transport: { type: 'stdio', command: 'node' } } as ISessionMcpServer;
const makeDeps = () => ({
  resolve: vi.fn().mockResolvedValue({
    enabled: true,
    transport: { type: 'stdio', command: 'node', args: ['bound.cjs'], env: { WOODY_CBM_REPO: 'D:/repo' } },
    skillPath: 'D:/skills/SKILL.md',
  }),
  ensureSkill: vi.fn().mockResolvedValue('woody-codebase-memory'),
});
const input = () => ({
  repoPath: 'D:/repo',
  catalog: [server],
  servers: [other],
  selectedIds: undefined as string[] | undefined,
  skillSelection: undefined as string[] | undefined,
  excludedSkills: [] as string[],
});

describe('project architecture session preparation', () => {
  it('binds the project transport and selects the skill without losing other tools', async () => {
    const result = await prepareCodebaseMemorySession(input(), makeDeps());
    expect(result.servers.map((s) => s.id)).toEqual(['other', 'cbm']);
    expect(result.servers[1].transport).toMatchObject({ env: { WOODY_CBM_REPO: 'D:/repo' } });
    expect(result.skills).toEqual(['woody-codebase-memory']);
  });
  it('respects an explicit empty MCP selection without reading the project', async () => {
    const deps = makeDeps();
    const result = await prepareCodebaseMemorySession({ ...input(), selectedIds: [] }, deps);
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(result.servers).toEqual([other]);
  });
  it('replaces a generic explicitly selected server, never leaves an unbound duplicate', async () => {
    const result = await prepareCodebaseMemorySession(
      { ...input(), selectedIds: ['cbm'], servers: [other, server] },
      makeDeps()
    );
    expect(result.servers).toHaveLength(2);
    expect(result.servers[1].transport).toMatchObject({ args: ['bound.cjs'] });
  });
  it('removes the generic tool when the project is disabled', async () => {
    const deps = makeDeps();
    deps.resolve.mockResolvedValue({ enabled: false });
    const result = await prepareCodebaseMemorySession({ ...input(), servers: [server] }, deps);
    expect(result.servers).toEqual([]);
    expect(deps.ensureSkill).not.toHaveBeenCalled();
  });
  it('respects disabled global MCP registration', async () => {
    const deps = makeDeps();
    await prepareCodebaseMemorySession({ ...input(), catalog: [{ ...server, enabled: false }] }, deps);
    expect(deps.resolve).not.toHaveBeenCalled();
  });
  it('does not import a skill explicitly deselected or excluded', async () => {
    for (const selection of [{ skillSelection: [] }, { excludedSkills: ['woody-codebase-memory'] }]) {
      const deps = makeDeps();
      const result = await prepareCodebaseMemorySession({ ...input(), ...selection }, deps);
      expect(deps.ensureSkill).not.toHaveBeenCalled();
      expect(result.skills).toEqual([]);
    }
  });
  it('reports invalid project configuration rather than creating an incorrectly bound session', async () => {
    const deps = makeDeps();
    deps.resolve.mockRejectedValue(new Error('Invalid project configuration'));
    await expect(prepareCodebaseMemorySession(input(), deps)).rejects.toThrow('Invalid project configuration');
  });
  it('refuses a partial enable result without transport', async () => {
    const deps = makeDeps();
    deps.resolve.mockResolvedValue({ enabled: true });
    await expect(prepareCodebaseMemorySession(input(), deps)).rejects.toThrow();
  });
  it('does not auto attach outside a project', async () => {
    const deps = makeDeps();
    expect((await prepareCodebaseMemorySession({ ...input(), repoPath: '' }, deps)).servers).toEqual([other]);
    expect(deps.resolve).not.toHaveBeenCalled();
  });
});
