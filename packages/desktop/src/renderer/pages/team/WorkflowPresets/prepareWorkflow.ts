import { ipcBridge } from '@/common';
import type { TeamAssistantInput } from '@/common/adapter/teamMapper';
import type {
  AssistantDefaultScalar,
  AssistantDetail,
  CreateAssistantRequest,
} from '@/common/types/agent/assistantTypes';
import { resolveDefaultTeamAgentModel } from '../components/teamCreateModelResolver';
import type { TeamAssistantOption } from '../components/assistantSelectUtils';
import { resolveCodebaseMemoryAccess, type CodebaseMemoryAccess } from './codebaseMemoryAccess';
import { buildWorkflowRules, WORKFLOW_PRESETS, type StagePresetId, type WorkflowRole } from './presets';

export class WorkflowPreparationError extends Error {
  constructor(
    cause: unknown,
    public readonly remainingAssistantIds: string[]
  ) {
    super('Workflow role preparation failed', { cause });
  }
}

type RoleSettings = Pick<CreateAssistantRequest, 'enabled_skills' | 'disabled_builtin_skills' | 'defaults'>;

/**
 * A role of a team made from a template: its name in the team, the rules appended to the
 * base assistant's, and skills this role has on top of the base assistant's.
 */
export type RoleSpec = { name: string; rules: string; skills?: string[] };

/** A fixed setting keeps its value; an auto one takes the last-used value, or stays auto without one. */
function fixedScalar(setting: AssistantDefaultScalar, last: string | undefined): AssistantDefaultScalar {
  const value = setting.mode === 'fixed' ? setting.value : last;
  return value ? { mode: 'fixed', value } : { mode: 'auto' };
}

const withItem = (list: string[], item: string | undefined) => (item && !list.includes(item) ? [...list, item] : list);

/**
 * What the base assistant would bring into a team, written as fixed values. A team
 * member's conversation gets no per-chat overrides, so a setting in `auto` mode comes
 * from that assistant's own last-used value; a new copy has none and would otherwise
 * start without the base assistant's tools, skills, permission and thinking level.
 */
function roleSettings(
  detail: AssistantDetail,
  model: string | undefined,
  codebaseMemory: CodebaseMemoryAccess | undefined
): RoleSettings {
  const { defaults, capabilities, preferences } = detail;
  const fixedSkills = defaults.skills.mode === 'fixed';
  // The service omits empty lists from its JSON.
  const skills = withItem(
    (fixedSkills ? capabilities.default_skill_ids : preferences.last_skill_ids) ?? [],
    codebaseMemory?.skill
  );
  const disabled = (
    (fixedSkills ? capabilities.default_disabled_builtin_skill_ids : preferences.last_disabled_builtin_skill_ids) ?? []
  ).filter((id) => id !== codebaseMemory?.skill);
  const mcps = withItem(
    (defaults.mcps.mode === 'fixed' ? defaults.mcps.value : preferences.last_mcp_ids) ?? [],
    codebaseMemory?.mcpId
  );
  return {
    enabled_skills: skills,
    disabled_builtin_skills: disabled,
    defaults: {
      model: model ? { mode: 'fixed', value: model } : defaults.model,
      permission: fixedScalar(defaults.permission, preferences.last_permission_value),
      thought_level: fixedScalar(defaults.thought_level, preferences.last_thought_level_value),
      skills: { mode: 'fixed', value: skills },
      mcps: { mode: 'fixed', value: mcps },
    },
  };
}

/**
 * Create one independent, editable copy of the base assistant per role; the first role
 * leads the team. Only this attempt’s copies are removed if preparation fails.
 */
export async function prepareRoles(params: {
  base: TeamAssistantOption;
  teamName: string;
  locale: string;
  /** The team workspace; its codebase memory, when switched on, is given to every role. */
  workspace: string;
  roles: RoleSpec[];
}): Promise<TeamAssistantInput[]> {
  const { base, teamName, locale, workspace, roles } = params;
  const createdIds: string[] = [];
  try {
    const detail = await ipcBridge.assistants.get.invoke({ id: base.id, locale });
    if (!detail?.team_selectable || !detail.engine?.agent_id) throw new Error('Assistant unavailable');
    const model = await resolveDefaultTeamAgentModel({ assistant_id: base.id, assistant_backend: base.backend });
    const settings = roleSettings(detail, model, await resolveCodebaseMemoryAccess(workspace));
    const members: TeamAssistantInput[] = [];
    // Finish each copy before starting another so rollback sees every completed mutation.
    /* eslint-disable no-await-in-loop */
    for (const [index, role] of roles.entries()) {
      const roleSkills = role.skills ?? [];
      const skills = roleSkills.reduce(withItem, settings.enabled_skills ?? []);
      const disabled = (settings.disabled_builtin_skills ?? []).filter((id) => !roleSkills.includes(id));
      const assistant = await ipcBridge.assistants.create.invoke({
        name: `${teamName.trim()} · ${role.name}`,
        agent_id: detail.engine.agent_id,
        avatar: detail.profile.avatar,
        custom_skill_names: detail.capabilities.custom_skill_names,
        ...settings,
        enabled_skills: skills,
        disabled_builtin_skills: disabled,
        defaults: { ...settings.defaults, skills: { mode: 'fixed', value: skills } },
      });
      if (!assistant?.id) throw new Error('Assistant creation failed');
      createdIds.push(assistant.id);
      const saved = await ipcBridge.fs.writeAssistantRule.invoke({
        assistant_id: assistant.id,
        content: [detail.rules.content, role.rules].filter(Boolean).join('\n\n'),
      });
      if (saved !== true) throw new Error('Role instructions were not saved');
      members.push({
        role: index === 0 ? 'leader' : 'teammate',
        assistant_name: role.name,
        assistant_id: assistant.id,
        model,
      });
    }
    /* eslint-enable no-await-in-loop */
    return members;
  } catch (error) {
    const cleanup = await Promise.allSettled(createdIds.map((id) => ipcBridge.assistants.delete.invoke({ id })));
    const remainingIds = createdIds.filter((_, index) => cleanup[index].status === 'rejected');
    throw new WorkflowPreparationError(error, remainingIds);
  }
}

/** Roles for a stage workflow: one per stage, the first stage leading. */
export async function prepareWorkflow(params: {
  preset: StagePresetId;
  base: TeamAssistantOption;
  teamName: string;
  locale: string;
  workspace: string;
  labels: Record<WorkflowRole, string>;
}): Promise<TeamAssistantInput[]> {
  const { preset, labels, ...rest } = params;
  return prepareRoles({
    ...rest,
    roles: WORKFLOW_PRESETS[preset].map((role) => ({
      name: labels[role],
      rules: buildWorkflowRules(preset, role, labels),
    })),
  });
}
