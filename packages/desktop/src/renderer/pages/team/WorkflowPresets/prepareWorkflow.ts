import { ipcBridge } from '@/common';
import type { TeamAssistantInput } from '@/common/adapter/teamMapper';
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
    const members: TeamAssistantInput[] = [];
    // Finish each copy before starting another so rollback sees every completed mutation.
    /* eslint-disable no-await-in-loop */
    for (const [index, role] of WORKFLOW_PRESETS[preset].entries()) {
      const assistant = await ipcBridge.assistants.create.invoke({
        name: `${teamName.trim()} · ${labels[role]}`,
        agent_id: detail.engine.agent_id,
        avatar: detail.profile.avatar,
        enabled_skills: detail.capabilities.default_skill_ids,
        custom_skill_names: detail.capabilities.custom_skill_names,
        disabled_builtin_skills: detail.capabilities.default_disabled_builtin_skill_ids,
        defaults: { ...detail.defaults, model: model ? { mode: 'fixed', value: model } : detail.defaults.model },
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
