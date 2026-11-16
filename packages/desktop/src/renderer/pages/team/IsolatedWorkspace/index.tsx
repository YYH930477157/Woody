import React from 'react';
import { Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { IsolatedWorkspaceState } from './useIsolatedWorkspace';

export { IsolatedWorkspaceError, useIsolatedWorkspace, type IsolatedWorkspaceState } from './useIsolatedWorkspace';

/**
 * The "separate workspace" row of the team form: a label cell and a field cell for its
 * two-column grid. Shown only when the chosen folder is inside a Git repository.
 */
const IsolatedWorkspaceOption: React.FC<{ state: IsolatedWorkspaceState; disabled: boolean }> = ({
  state,
  disabled,
}) => {
  const { t } = useTranslation();
  const { source, prepared } = state;
  if (!source) return null;
  const note = !source.head
    ? t('team.create.isolated.noCommits')
    : !source.branch
      ? t('team.create.isolated.detached')
      : t('team.create.isolated.hint', { branch: source.branch });
  return (
    <>
      <div className='text-14px font-500 leading-21px text-t-secondary'>{t('team.create.isolated.label')}</div>
      <div data-testid='team-isolated-workspace' className='flex flex-col gap-4px min-w-0'>
        <div className='flex items-center gap-8px min-w-0'>
          <Switch
            size='small'
            aria-label={t('team.create.isolated.label')}
            checked={state.enabled}
            disabled={disabled || !state.available || Boolean(prepared)}
            onChange={state.setEnabled}
          />
          <span className='text-12px leading-18px text-t-tertiary min-w-0'>{note}</span>
        </div>
        {state.enabled && source.dirty && !prepared && (
          <div className='text-12px leading-18px text-warning'>{t('team.create.isolated.dirty')}</div>
        )}
        {prepared && (
          <div className='text-12px leading-18px text-t-secondary break-all'>
            {t('team.create.isolated.prepared', { path: prepared.worktree, branch: prepared.branch })}
          </div>
        )}
      </div>
    </>
  );
};

export default IsolatedWorkspaceOption;
