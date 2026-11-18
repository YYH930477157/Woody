import React, { useState } from 'react';
import { Button, Checkbox, Input } from '@arco-design/web-react';
import { Delete, Edit, Plus } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { parseExpertPaths } from '@/common/types/team/moduleExperts';
import ExpertEditor from './ExpertEditor';
import type { ModuleExpertsState } from './useModuleExperts';

export { buildExpertTeamRoles, type ExpertTeamLabels } from './expertRules';
export { useModuleExperts, type ModuleExpertsState } from './useModuleExperts';

type Props = {
  workspace: string;
  state: ModuleExpertsState;
  disabled: boolean;
};

/** The module experts of the chosen project: who joins this team, and their saved definitions. */
const ModuleExperts: React.FC<Props> = ({ workspace, state, disabled }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [sharedText, setSharedText] = useState<string>();
  const toggleOpen = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  let notice: string | undefined;
  if (!state.available) notice = t('team.experts.unavailable');
  else if (!workspace) notice = t('team.experts.selectWorkspace');
  else if (state.error) notice = t('team.experts.loadFailed', { message: state.error });
  if (notice) {
    return (
      <div data-testid='team-experts-notice' className='text-12px leading-18px text-t-tertiary'>
        {notice}
      </div>
    );
  }
  if (state.loading || !state.file) return null;

  return (
    <section data-testid='team-experts' className='flex flex-col gap-10px'>
      <div className='flex items-center justify-between gap-10px'>
        <div className='min-w-0'>
          <div className='text-14px font-600 leading-21px text-t-secondary'>{t('team.experts.title')}</div>
          <div className='truncate text-12px leading-18px text-t-tertiary' title={state.file}>
            {t('team.experts.savedIn', { file: state.file })}
          </div>
        </div>
        <Button
          size='small'
          type='outline'
          icon={<Plus theme='outline' size='14' fill='currentColor' />}
          disabled={disabled || !state.canAdd}
          onClick={() => {
            state.add();
          }}
          data-testid='team-experts-add'
        >
          {t('team.experts.add')}
        </Button>
      </div>
      {state.drafts.length === 0 && (
        <div className='text-12px leading-18px text-t-tertiary'>{t('team.experts.empty')}</div>
      )}
      <div className='flex max-h-[34vh] flex-col gap-8px overflow-y-auto pe-4px'>
        {state.drafts.map((draft) => {
          const issue = state.issues.get(draft.key);
          // A new or incomplete expert opens for editing by itself.
          const editing = open.has(draft.key) || Boolean(issue);
          return (
            <div
              key={draft.key}
              data-testid={`team-expert-${draft.id || draft.key}`}
              className='rounded-8px border border-border-2 bg-fill-1 px-12px py-8px'
            >
              <div className='flex items-start gap-8px'>
                <Checkbox
                  checked={draft.selected}
                  disabled={disabled}
                  onChange={(checked: boolean) => state.toggle(draft.key, checked)}
                  aria-label={draft.name || draft.id}
                />
                <div className='min-w-0 flex-1'>
                  <div className='flex items-baseline gap-8px'>
                    <span className='truncate text-13px font-500 text-t-primary'>{draft.name || '—'}</span>
                    {draft.id && <span className='text-12px text-t-tertiary'>{draft.id}</span>}
                  </div>
                  {!editing && (
                    <div className='text-12px leading-18px text-t-secondary'>
                      {draft.summary} · {t('team.experts.pathCount', { count: draft.paths.length })}
                    </div>
                  )}
                </div>
                <Button
                  size='mini'
                  type='text'
                  icon={<Edit theme='outline' size='14' fill='currentColor' />}
                  disabled={disabled || Boolean(issue)}
                  onClick={() => toggleOpen(draft.key)}
                  aria-label={t('common.edit')}
                />
                <Button
                  size='mini'
                  type='text'
                  status='danger'
                  icon={<Delete theme='outline' size='14' fill='currentColor' />}
                  disabled={disabled}
                  onClick={() => state.remove(draft.key)}
                  aria-label={t('common.remove')}
                />
              </div>
              {editing && (
                <ExpertEditor draft={draft} disabled={disabled} onChange={(patch) => state.update(draft.key, patch)} />
              )}
              {issue && (
                <div className='mt-6px text-12px leading-18px text-danger-6'>{t(`team.experts.issues.${issue}`)}</div>
              )}
            </div>
          );
        })}
      </div>
      <div className='grid grid-cols-[96px_minmax(0,1fr)] items-start gap-x-10px'>
        <span className='pt-6px text-12px leading-18px text-t-secondary'>{t('team.experts.shared')}</span>
        <div className='flex flex-col gap-2px'>
          <Input.TextArea
            value={sharedText ?? state.shared.join('\n')}
            disabled={disabled}
            autoSize={{ minRows: 1, maxRows: 4 }}
            placeholder={t('team.experts.fields.pathsPlaceholder')}
            onChange={(text) => {
              setSharedText(text);
              state.setShared(parseExpertPaths(text));
            }}
            data-testid='team-experts-shared'
          />
          <span className='text-11px leading-16px text-t-tertiary'>{t('team.experts.sharedHint')}</span>
        </div>
      </div>
    </section>
  );
};

export default ModuleExperts;
