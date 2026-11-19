import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantDetail } from '@/common/types/agent/assistantTypes';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  model: vi.fn(),
  access: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: { get: { invoke: mocks.get }, create: { invoke: mocks.create }, delete: { invoke: mocks.remove } },
    fs: { writeAssistantRule: { invoke: mocks.write } },
  },
}));
vi.mock('@renderer/pages/team/components/teamCreateModelResolver', () => ({
  resolveDefaultTeamAgentModel: mocks.model,
}));
vi.mock('@/renderer/pages/team/WorkflowPresets/codebaseMemoryAccess', () => ({
  resolveCodebaseMemoryAccess: mocks.access,
}));
import {
  prepareRoles,
  prepareWorkflow,
  WorkflowPreparationError,
} from '@/renderer/pages/team/WorkflowPresets/prepareWorkflow';
import { buildWorkflowRules, WORKFLOW_ROLES } from '@/renderer/pages/team/WorkflowPresets/presets';

const labels = Object.fromEntries(WORKFLOW_ROLES.map((role) => [role, role])) as Record<
  (typeof WORKFLOW_ROLES)[number],
  string
>;
const params = {
  preset: 'feature' as const,
  base: { id: 'base', name: 'Base', backend: 'aionrs' },
  teamName: 'My task',
  locale: 'zh-CN',
  workspace: 'D:\\work\\project',
  labels,
};
const detail = {
  team_selectable: true,
  engine: { agent_id: 'engine-1' },
  profile: {},
  rules: { content: 'Keep project conventions.' },
  defaults: {
    model: { mode: 'auto' },
    permission: { mode: 'fixed', value: 'auto_edit' },
    thought_level: { mode: 'auto' },
    skills: { mode: 'fixed', value: ['test'] },
    mcps: { mode: 'auto', value: [] },
  },
  capabilities: {
    default_skill_ids: ['test'],
    custom_skill_names: ['mine'],
    default_disabled_builtin_skill_ids: ['disabled'],
  },
  preferences: {
    last_thought_level_value: 'high',
    last_skill_ids: ['recent'],
    last_disabled_builtin_skill_ids: [],
    last_mcp_ids: ['woody-cmake'],
  },
} satisfies Partial<AssistantDetail>;

describe('workflow role preparation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.get.mockResolvedValue(detail);
    mocks.create.mockImplementation(async () => ({ id: `copy-${mocks.create.mock.calls.length}` }));
    mocks.write.mockResolvedValue(true);
    mocks.model.mockResolvedValue('configured-provider/model');
    mocks.remove.mockResolvedValue(undefined);
    mocks.access.mockResolvedValue(undefined);
  });

  it('creates six independent stages with one leader and the configured model', async () => {
    const members = await prepareWorkflow(params);
    expect(members.map(({ assistant_id, role, model }) => [assistant_id, role, model])).toEqual(
      WORKFLOW_ROLES.map((_, i) => [`copy-${i + 1}`, i === 0 ? 'leader' : 'teammate', 'configured-provider/model'])
    );
  });

  it('gives every copy what the source would bring into a team, fixed, without editing the source', async () => {
    await prepareWorkflow(params);
    for (const [request] of mocks.create.mock.calls) {
      expect(request).toMatchObject({
        agent_id: 'engine-1',
        custom_skill_names: ['mine'],
        // Fixed settings keep their values.
        enabled_skills: ['test'],
        disabled_builtin_skills: ['disabled'],
        defaults: {
          model: { mode: 'fixed', value: 'configured-provider/model' },
          permission: { mode: 'fixed', value: 'auto_edit' },
          skills: { mode: 'fixed', value: ['test'] },
          // Auto settings become the source's last-used values, which a team member uses.
          thought_level: { mode: 'fixed', value: 'high' },
          mcps: { mode: 'fixed', value: ['woody-cmake'] },
        },
      });
    }
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('takes auto skills from the last-used ones and leaves an unused auto setting on auto', async () => {
    mocks.get.mockResolvedValue({
      ...detail,
      defaults: {
        ...detail.defaults,
        permission: { mode: 'auto' },
        skills: { mode: 'auto' },
        mcps: { mode: 'fixed', value: ['serial'] },
      },
      preferences: { last_skill_ids: ['recent'], last_disabled_builtin_skill_ids: ['off'], last_mcp_ids: ['unused'] },
    });
    await prepareWorkflow({ ...params, preset: 'review' });
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      enabled_skills: ['recent'],
      disabled_builtin_skills: ['off'],
      defaults: {
        permission: { mode: 'auto' },
        thought_level: { mode: 'auto' },
        skills: { mode: 'fixed', value: ['recent'] },
        mcps: { mode: 'fixed', value: ['serial'] },
      },
    });
  });

  it('treats lists the service leaves out of its JSON as empty', async () => {
    mocks.get.mockResolvedValue({
      ...detail,
      defaults: { ...detail.defaults, skills: { mode: 'auto' }, mcps: { mode: 'auto' } },
      capabilities: {},
      preferences: {},
    });
    await prepareWorkflow({ ...params, preset: 'review' });
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      enabled_skills: [],
      disabled_builtin_skills: [],
      defaults: { skills: { mode: 'fixed', value: [] }, mcps: { mode: 'fixed', value: [] } },
    });
  });

  it('persists source rules and the stage handoff contract before returning members', async () => {
    await prepareWorkflow(params);
    expect(mocks.write.mock.calls[0][0]).toMatchObject({
      assistant_id: 'copy-1',
      content: expect.stringContaining('Keep project conventions.'),
    });
    expect(mocks.write.mock.calls[3][0].content).toContain('exact commands/results');
    expect(mocks.write.mock.calls[0][0].content).toContain('at most two correction cycles');
  });

  it('removes copies and rejects when saving rules returns false', async () => {
    mocks.write.mockResolvedValueOnce(false);
    await expect(prepareWorkflow(params)).rejects.toBeInstanceOf(WorkflowPreparationError);
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({ id: 'copy-1' });
  });

  it('cleans earlier roles if a later assistant cannot be created', async () => {
    mocks.create.mockResolvedValueOnce({ id: 'first-copy' }).mockRejectedValueOnce(new Error('unavailable'));
    await expect(prepareWorkflow(params)).rejects.toMatchObject({ remainingAssistantIds: [] });
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({ id: 'first-copy' });
  });

  it('reports IDs whose cleanup failed without removing the source', async () => {
    mocks.write.mockRejectedValueOnce(new Error('disk full'));
    mocks.remove.mockRejectedValueOnce(new Error('offline'));
    await expect(prepareWorkflow(params)).rejects.toMatchObject({ remainingAssistantIds: ['copy-1'] });
    expect(mocks.remove).not.toHaveBeenCalledWith({ id: 'base' });
  });

  it('does not create roles if the source is blocked or unavailable', async () => {
    mocks.get.mockResolvedValueOnce({ ...detail, team_selectable: false });
    await expect(prepareWorkflow(params)).rejects.toBeInstanceOf(WorkflowPreparationError);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not create roles when model resolution fails', async () => {
    mocks.model.mockRejectedValueOnce(new Error('missing model'));
    await expect(prepareWorkflow(params)).rejects.toBeInstanceOf(WorkflowPreparationError);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('uses only review stages for a review workflow', async () => {
    const members = await prepareWorkflow({ ...params, preset: 'review' });
    expect(members.map((member) => member.assistant_name)).toEqual(['requirements', 'review', 'delivery']);
    expect(mocks.write.mock.calls[0][0].content).toContain('report findings without starting implementation');
  });

  it('gives every role the codebase memory tools of the team workspace, once', async () => {
    mocks.access.mockResolvedValue({ mcpId: 'cbm-row', skill: 'woody-codebase-memory' });
    mocks.get.mockResolvedValue({
      ...detail,
      defaults: { ...detail.defaults, mcps: { mode: 'fixed', value: ['woody-cmake', 'cbm-row'] } },
    });
    await prepareWorkflow({ ...params, preset: 'review' });
    expect(mocks.access).toHaveBeenCalledExactlyOnceWith('D:\\work\\project');
    for (const [request] of mocks.create.mock.calls) {
      expect(request).toMatchObject({
        enabled_skills: ['test', 'woody-codebase-memory'],
        defaults: {
          skills: { mode: 'fixed', value: ['test', 'woody-codebase-memory'] },
          mcps: { mode: 'fixed', value: ['woody-cmake', 'cbm-row'] },
        },
      });
    }
  });

  it('creates any list of roles with the first one leading', async () => {
    const members = await prepareRoles({
      base: params.base,
      teamName: ' Demo ',
      locale: 'zh-CN',
      workspace: '',
      roles: [
        { name: '总管', rules: 'dispatch' },
        { name: 'Sensor 专家', rules: 'sensor' },
      ],
    });
    expect(members.map(({ role, assistant_name }) => [role, assistant_name])).toEqual([
      ['leader', '总管'],
      ['teammate', 'Sensor 专家'],
    ]);
    expect(mocks.create.mock.calls.map(([request]) => request.name)).toEqual(['Demo · 总管', 'Demo · Sensor 专家']);
    expect(mocks.write.mock.calls[1][0].content).toBe('Keep project conventions.\n\nsensor');
  });

  it('adds a role’s own skills to those of the base assistant, once', async () => {
    await prepareRoles({
      base: params.base,
      teamName: 'Demo',
      locale: 'zh-CN',
      workspace: '',
      roles: [
        { name: '总管', rules: 'dispatch' },
        { name: 'Sensor 专家', rules: 'sensor', skills: ['woody-module-expert', 'test'] },
      ],
    });
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      enabled_skills: ['test'],
      defaults: { skills: { mode: 'fixed', value: ['test'] } },
    });
    expect(mocks.create.mock.calls[1][0]).toMatchObject({
      enabled_skills: ['test', 'woody-module-expert'],
      defaults: { skills: { mode: 'fixed', value: ['test', 'woody-module-expert'] } },
    });
  });

  it('removes role and codebase-memory skills from disabled_builtin_skills while keeping others disabled', async () => {
    mocks.access.mockResolvedValue({ mcpId: 'cbm-row', skill: 'woody-codebase-memory' });
    mocks.get.mockResolvedValue({
      ...detail,
      capabilities: {
        ...detail.capabilities,
        default_disabled_builtin_skill_ids: ['disabled', 'woody-codebase-memory', 'woody-module-expert'],
      },
    });
    await prepareRoles({
      base: params.base,
      teamName: 'Demo',
      locale: 'zh-CN',
      workspace: 'D:\\work\\project',
      roles: [
        { name: '总管', rules: 'dispatch' },
        { name: 'Sensor 专家', rules: 'sensor', skills: ['woody-module-expert'] },
      ],
    });
    expect(mocks.create.mock.calls[0][0].disabled_builtin_skills).toEqual(['disabled', 'woody-module-expert']);
    expect(mocks.create.mock.calls[1][0].disabled_builtin_skills).toEqual(['disabled']);
  });

  it('rejects roles outside the selected workflow', () => {
    expect(() => buildWorkflowRules('review', 'implementation', labels)).toThrow('Role is not part');
  });
});

describe('workflow role rules', () => {
  it('make the leader confirm requirements, then dispatch each stage with its handoff', () => {
    const rules = buildWorkflowRules('feature', 'requirements', labels);
    expect(rules).toContain('(v2)');
    expect(rules).toContain('end your turn to wait for confirmation');
    expect(rules).toContain('put the complete handoff it needs in the task description');
    // A pre-created dependent task would wake its owner before the handoff exists.
    expect(rules).toContain('Do not create later-stage tasks in advance');
    expect(rules).toContain('a task marked completed is not a handoff');
    expect(rules).toContain('do not propose or create extra teammates');
    expect(rules).not.toContain('with dependencies when supported');
  });

  it('only stop a review for confirmation when its target is unclear, and never loop into implementation', () => {
    const rules = buildWorkflowRules('review', 'requirements', labels);
    expect(rules).toContain('If the review target or scope is unclear');
    expect(rules).not.toContain('wait for confirmation');
    expect(rules).not.toContain('correction cycles');
    expect(rules).toContain('report findings without starting implementation');
  });

  it('tell members their task carries the handoff and the leader needs theirs as a message', () => {
    const rules = buildWorkflowRules('bugfix', 'testing', labels);
    expect(rules).toContain('Your task description carries the handoff');
    expect(rules).toContain('Send your complete handoff to the leader');
    expect(rules).not.toContain('workflow leader');
  });
});
