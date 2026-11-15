import React from 'react';
import { Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { TeamAssistantOption } from '../components/assistantSelectUtils';
import { WORKFLOW_PRESETS, type WorkflowPresetId } from './presets';

export { prepareWorkflow, WorkflowPreparationError } from './prepareWorkflow';
export { WORKFLOW_ROLES, type WorkflowPresetId, type WorkflowRole } from './presets';

type Props = {
  preset?: WorkflowPresetId;
  baseId?: string;
  assistants: TeamAssistantOption[];
  disabled: boolean;
  onPresetChange: (preset?: WorkflowPresetId) => void;
  onBaseChange: (id: string) => void;
};

const WorkflowPresets: React.FC<Props> = ({ preset, baseId, assistants, disabled, onPresetChange, onBaseChange }) => {
  const { t } = useTranslation();
  return (
    <section
      data-testid='team-workflow-presets'
      className='flex flex-col gap-10px border-b border-border-2 px-20px py-12px'
    >
      <div className='flex flex-wrap items-center gap-10px'>
        <span className='text-13px font-500 text-t-secondary'>{t('team.workflow.label')}</span>
        <Select
          aria-label={t('team.workflow.label')}
          className='min-w-160px flex-1'
          value={preset ?? 'custom'}
          disabled={disabled}
          onChange={(value: string) => onPresetChange(value === 'custom' ? undefined : (value as WorkflowPresetId))}
          options={[
            { value: 'custom', label: t('team.workflow.custom') },
            ...(['feature', 'bugfix', 'review'] as const).map((id) => ({ value: id, label: t(`team.workflow.${id}`) })),
          ]}
        />
        {preset && (
          <Select
            aria-label={t('team.workflow.baseAssistant')}
            placeholder={t('team.workflow.baseAssistant')}
            className='min-w-160px flex-1'
            value={baseId}
            disabled={disabled}
            onChange={onBaseChange}
            options={assistants
              .filter((assistant) => assistant.team_selectable !== false)
              .map((assistant) => ({ value: assistant.id, label: assistant.name }))}
          />
        )}
      </div>
      {preset && (
        <>
          <div data-testid='team-workflow-stages' className='text-13px leading-20px text-t-primary'>
            {WORKFLOW_PRESETS[preset].map((role) => t(`team.workflow.roles.${role}`)).join(' → ')}
          </div>
          <div className='text-12px leading-18px text-t-tertiary'>{t('team.workflow.hint')}</div>
        </>
      )}
    </section>
  );
};

export default WorkflowPresets;
