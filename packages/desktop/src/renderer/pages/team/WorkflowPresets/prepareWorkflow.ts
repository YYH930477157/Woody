import { ipcBridge } from '@/common';
import type { TeamAssistantInput } from '@/common/adapter/teamMapper';
import type {
  AssistantDefaultScalar,
  AssistantDetail,
  CreateAssistantRequest,
} from '@/common/types/agent/assistantTypes';
import { resolveDefaultTeamAgentModel } from '../components/teamCreateModelResolver';
import type { TeamAssistantOption } from '../components/assistantSelectUtils';
import { buildWorkflowRules, WORKFLOW_PRESETS, type WorkflowPresetId, type WorkflowRole } from './presets';

export class WorkflowPreparationError extends Error {
  constructor(
    cause: unknown,
    public readonly remainingAssistantIds: string[]
  ) {
    super('Workflow role preparation failed', { cause });
  }
}

type RoleSettings = Pick<CreateAssistantRequest, 'enabled_skills' | 'disabled_builtin_skills' | 'defaults'>;

/** A fixed setting keeps its value; an auto one takes the last-used value, or stays auto without one. */
function fixedScalar(setting: AssistantDefaultScalar, last: string | undefined): AssistantDefaultScalar {
  const value = setting.mode === 'fixed' ? setting.value : last;
  return value ? { mode: 'fixed', value } : { mode: 'auto' };
}

/**
 * What the base assistant would bring into a team, written as fixed values. A team
 * member's conversation gets no per-chat overrides, so a setting in `auto` mode comes
 * from that assistant's own last-used value; a new copy has none and would otherwise
 * start without the base assistant's tools, skills, permission and thinking level.
 */
function roleSettings(detail: AssistantDetail, model: string | undefined): RoleSettings {
  const { defaults, capabilities, preferences } = detail;
  const fixedSkills = defaults.skills.mode === 'fixed';
  // The service omits empty lists from its JSON.
  const skills = (fixedSkills ? capabilities.default_skill_ids : preferences.last_skill_ids) ?? [];
  const disabled =
    (fixedSkills ? capabilities.default_disabled_builtin_skill_ids : preferences.last_disabled_builtin_skill_ids) ?? [];
  const mcps = (defaults.mcps.mode === 'fixed' ? defaults.mcps.value : preferences.last_mcp_ids) ?? [];
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

/** Create independent editable roles; remove only this attempt’s copies if preparation fails. */
export async function prepareWorkflow(params: {
  preset: WorkflowPresetId;
  base: TeamAssistantOption;
  teamName: string;
  locale: string;
  labels: Record<WorkflowRole, string>;
}): Promise<TeamAssistantInput[]> {
  const { preset, base, teamName, locale, labels } = params;
  const createdIds: string[] = [];
  try {
    const detail = await ipcBridge.assistants.get.invoke({ id: base.id, locale });
    if (!detail?.team_selectable || !detail.engine?.agent_id) throw new Error('Assistant unavailable');
    const model = await resolveDefaultTeamAgentModel({ assistant_id: base.id, assistant_backend: base.backend });
    const settings = roleSettings(detail, model);
    const members: TeamAssistantInput[] = [];
    // Finish each copy before starting another so rollback sees every completed mutation.
    /* eslint-disable no-await-in-loop */
    for (const [index, role] of WORKFLOW_PRESETS[preset].entries()) {
      const assistant = await ipcBridge.assistants.create.invoke({
        name: `${teamName.trim()} · ${labels[role]}`,
        agent_id: detail.engine.agent_id,
        avatar: detail.profile.avatar,
        custom_skill_names: detail.capabilities.custom_skill_names,
        ...settings,
      });
      if (!assistant?.id) throw new Error('Assistant creation failed');
      createdIds.push(assistant.id);
      const saved = await ipcBridge.fs.writeAssistantRule.invoke({
        assistant_id: assistant.id,
        content: [detail.rules.content, buildWorkflowRules(preset, role, labels)].filter(Boolean).join('\n\n'),
      });
      if (saved !== true) throw new Error('Role instructions were not saved');
      members.push({
        role: index === 0 ? 'leader' : 'teammate',
        assistant_name: labels[role],
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
