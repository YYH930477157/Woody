import { describe, expect, it, vi } from 'vitest';
import type { IMcpServer, ISessionMcpServer } from '@/common/config/storage';
import {
  createCodebaseMemorySkillEnsurer,
  prepareCodebaseMemorySession,
} from '@/common/adapter/codebaseMemory/session';
import { toGuidSkillOption } from '@/renderer/pages/guid/utils/skillOptions';

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
  it('does not import a skill the user switched off, but keeps the tools', async () => {
    const deps = makeDeps();
    const result = await prepareCodebaseMemorySession({ ...input(), excludedSkills: ['woody-codebase-memory'] }, deps);
    expect(deps.ensureSkill).not.toHaveBeenCalled();
    expect(result.skills).toEqual([]);
    expect(result.servers.map((s) => s.id)).toEqual(['other', 'cbm']);
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

describe('keeping the bundled architecture skill current', () => {
  const library = (installed: boolean) => ({
    list: vi.fn().mockResolvedValue(installed ? [{ name: 'woody-codebase-memory' }] : []),
    importSkill: vi.fn().mockResolvedValue('woody-codebase-memory'),
  });
  it('replaces an older imported copy once per run, then trusts the library', async () => {
    const skills = library(true);
    const ensure = createCodebaseMemorySkillEnsurer(skills);
    await expect(ensure('D:/skills/SKILL.md')).resolves.toBe('woody-codebase-memory');
    await expect(ensure('D:/skills/SKILL.md')).resolves.toBe('woody-codebase-memory');
    expect(skills.importSkill).toHaveBeenCalledExactlyOnceWith('D:/skills/SKILL.md');
  });
  it('imports again when the skill was removed from the library', async () => {
    const skills = library(true);
    const ensure = createCodebaseMemorySkillEnsurer(skills);
    await ensure('D:/skills/SKILL.md');
    skills.list.mockResolvedValue([]);
    await ensure('D:/skills/SKILL.md');
    expect(skills.importSkill).toHaveBeenCalledTimes(2);
  });
  it('keeps the installed copy when the refresh fails', async () => {
    const skills = library(true);
    skills.importSkill.mockRejectedValue(new Error('disk full'));
    await expect(createCodebaseMemorySkillEnsurer(skills)('D:/skills/SKILL.md')).resolves.toBe('woody-codebase-memory');
  });
  it('fails when the skill can be neither imported nor found', async () => {
    const skills = library(false);
    skills.importSkill.mockRejectedValue(new Error('disk full'));
    await expect(createCodebaseMemorySkillEnsurer(skills)('D:/skills/SKILL.md')).rejects.toThrow('disk full');
  });
});

const skill = (name: string, source: 'builtin' | 'custom', is_auto_inject: boolean) => ({
  name,
  description: name,
  source,
  is_auto_inject,
});

describe('codebase memory skill on the new-chat page', () => {
  it('starts checked like an auto skill, so switching it off is an explicit opt-out', () => {
    expect(toGuidSkillOption(skill('woody-codebase-memory', 'custom', false)).isAuto).toBe(true);
  });
  it('leaves other skills as they were', () => {
    expect(toGuidSkillOption(skill('officecli', 'builtin', false)).isAuto).toBe(false);
    expect(toGuidSkillOption(skill('cron', 'builtin', true)).isAuto).toBe(true);
    expect(toGuidSkillOption(skill('mine', 'custom', true)).isAuto).toBe(false);
  });
});
