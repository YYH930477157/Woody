import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantDetail } from '@/common/types/agent/assistantTypes';

const mocks = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn(), write: vi.fn(), remove: vi.fn(), model: vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: { get: { invoke: mocks.get }, create: { invoke: mocks.create }, delete: { invoke: mocks.remove } },
    fs: { writeAssistantRule: { invoke: mocks.write } },
  },
}));
vi.mock('@renderer/pages/team/components/teamCreateModelResolver', () => ({
  resolveDefaultTeamAgentModel: mocks.model,
}));
import { prepareWorkflow, WorkflowPreparationError } from '@/renderer/pages/team/WorkflowPresets/prepareWorkflow';
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
  labels,
};
const detail = {
  team_selectable: true,
  engine: { agent_id: 'engine-1' },
  profile: {},
  rules: { content: 'Keep project conventions.' },
  defaults: {
    model: { mode: 'auto' },
    permission: { mode: 'fixed', value: 'plan' },
    thought_level: { mode: 'auto' },
    skills: { mode: 'auto', value: [] },
    mcps: { mode: 'auto', value: [] },
  },
  capabilities: {
    default_skill_ids: ['test'],
    custom_skill_names: [],
    default_disabled_builtin_skill_ids: ['disabled'],
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
  });

  it('creates six independent stages with one leader and the configured model', async () => {
    const members = await prepareWorkflow(params);
    expect(members.map(({ assistant_id, role, model }) => [assistant_id, role, model])).toEqual(
      WORKFLOW_ROLES.map((_, i) => [`copy-${i + 1}`, i === 0 ? 'leader' : 'teammate', 'configured-provider/model'])
    );
  });

  it('inherits the source engine, capabilities and permission defaults without editing it', async () => {
    await prepareWorkflow(params);
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      agent_id: 'engine-1',
      enabled_skills: ['test'],
      disabled_builtin_skills: ['disabled'],
      defaults: {
        model: { mode: 'fixed', value: 'configured-provider/model' },
        permission: { mode: 'fixed', value: 'plan' },
      },
    });
    expect(mocks.remove).not.toHaveBeenCalled();
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

  it('rejects roles outside the selected workflow', () => {
    expect(() => buildWorkflowRules('review', 'implementation', labels)).toThrow('Role is not part');
  });
});
