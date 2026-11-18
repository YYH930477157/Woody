import React, { useState } from 'react';
import { Alert, Button, Checkbox, Input, Select, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { CodebaseMemoryModule, ModuleCardState } from '@/common/types/codebaseMemory/types';
import type { ExpertFields, ModuleListState } from './useModuleList';

type Props = {
  modules: CodebaseMemoryModule[];
  state: ModuleListState;
  disabled: boolean;
};

const TAG_COLORS: Record<ModuleCardState, string | undefined> = {
  nobrief: undefined,
  missing: undefined,
  stale: 'orange',
  ready: 'green',
  error: 'red',
};
// The panel is narrow: labels sit above their fields so the fields get the full width.
const FIELD = 'flex flex-col gap-2px';
const LABEL = 'text-12px leading-18px text-t-secondary';

/**
 * The modules Woody found in the dispatch tables, and the project's module experts with the
 * state of their feature cards. Chosen modules become a new expert or join an existing one.
 */
export default function ModuleList({ modules, state, disabled }: Props) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string[]>([]);
  const [draft, setDraft] = useState<ExpertFields>();
  const [target, setTarget] = useState<string>();
  const locked = disabled || Boolean(state.busy);
  const cardOf = (id: string) => state.cards?.experts.find((card) => card.id === id);
  const nameOf = (id: string) => state.experts.find((expert) => expert.id === id)?.name ?? id;

  const startDraft = () => {
    const picked = modules.filter((item) => chosen.includes(item.id));
    const id = picked
      .map((item) => item.id)
      .join('-')
      .slice(0, 40)
      .replace(/-+$/, '');
    setDraft({
      id,
      name: t('conversation.codebaseMemory.modules.nameDraft', { id }),
      summary: t('conversation.codebaseMemory.modules.summaryDraft', {
        modules: picked.map((item) => item.id).join(', '),
        tables: [...new Set(picked.flatMap((item) => item.tables))].join(', ') || '—',
        functions:
          picked
            .flatMap((item) => item.functions)
            .slice(0, 6)
            .join(', ') || '—',
      }),
    });
  };
  const issue = draft ? state.issueOf(draft, modules, chosen) : null;
  const done = () => {
    setChosen([]);
    setDraft(undefined);
    setTarget(undefined);
  };

  return (
    <div className='flex flex-col gap-6px' data-testid='codebase-modules'>
      <div className='flex items-center justify-between gap-8px'>
        <span>{t('conversation.codebaseMemory.modules.title')}</span>
        <Button
          size='small'
          disabled={locked || state.experts.length === 0}
          loading={state.busy === 'refresh'}
          onClick={() => void state.refreshCards()}
        >
          {t('conversation.codebaseMemory.modules.refresh')}
        </Button>
      </div>
      <div className='text-12px text-t-secondary'>{t('conversation.codebaseMemory.modules.hint')}</div>
      {state.experts.length > 0 && (
        <div className='flex flex-col gap-4px' data-testid='codebase-module-experts'>
          {state.experts.map((expert) => {
            const card = cardOf(expert.id);
            const cardState = card?.state ?? 'nobrief';
            return (
              <div key={expert.id} className='flex items-center justify-between gap-8px text-12px'>
                <span className='min-w-0 truncate text-t-primary' title={card?.card}>
                  {expert.name}
                </span>
                <Tag size='small' color={TAG_COLORS[cardState]} title={card?.error}>
                  {t(`conversation.codebaseMemory.modules.states.${cardState}`)}
                </Tag>
              </div>
            );
          })}
        </div>
      )}
      {state.cards?.error && (
        <Alert
          type='warning'
          content={t('conversation.codebaseMemory.modules.expertsUnreadable', { error: state.cards.error })}
        />
      )}
      {modules.length === 0 ? (
        <div className='text-12px text-t-tertiary'>{t('conversation.codebaseMemory.modules.empty')}</div>
      ) : (
        <div className='flex max-h-[40vh] flex-col gap-4px overflow-y-auto pe-4px'>
          {modules.map((item) => (
            <div key={item.id} className='flex items-start gap-6px rounded-6px bg-fill-1 px-8px py-4px'>
              <Checkbox
                checked={chosen.includes(item.id)}
                disabled={locked}
                aria-label={item.id}
                onChange={(checked: boolean) =>
                  setChosen((current) => (checked ? [...current, item.id] : current.filter((id) => id !== item.id)))
                }
              />
              <div className='min-w-0 flex-1 text-12px leading-18px'>
                <div className='flex items-baseline justify-between gap-6px'>
                  <span className='font-500 text-t-primary'>{item.id}</span>
                  <span className='truncate text-t-tertiary'>
                    {item.experts.length
                      ? item.experts.map(nameOf).join(', ')
                      : t('conversation.codebaseMemory.modules.noExpert')}
                  </span>
                </div>
                <div className='break-all text-t-secondary'>{item.files.join(', ')}</div>
                <div className='text-t-tertiary'>{item.tables.join(', ')}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {chosen.length > 0 && !draft && (
        <div className='flex flex-wrap items-center gap-6px'>
          <Button size='small' type='primary' disabled={locked || !state.canCreate} onClick={startDraft}>
            {t('conversation.codebaseMemory.modules.newExpert')}
          </Button>
          {state.experts.length > 0 && (
            <>
              <Select
                size='small'
                className='w-160px'
                value={target}
                disabled={locked}
                placeholder={t('conversation.codebaseMemory.modules.chooseExpert')}
                options={state.experts.map((expert) => ({ value: expert.id, label: expert.name }))}
                onChange={(value: string) => setTarget(value)}
              />
              <Button
                size='small'
                disabled={locked || !target}
                loading={state.busy === 'add'}
                onClick={() => {
                  if (target) void state.addTo(target, modules, chosen).then((saved) => saved && done());
                }}
              >
                {t('conversation.codebaseMemory.modules.addToExpert')}
              </Button>
            </>
          )}
        </div>
      )}
      {draft && (
        <div
          className='flex flex-col gap-6px rounded-6px border border-border-2 px-8px py-6px'
          data-testid='codebase-module-draft'
        >
          <div className={FIELD}>
            <span className={LABEL}>{t('team.experts.fields.name')}</span>
            <Input
              size='small'
              value={draft.name}
              disabled={locked}
              onChange={(name) => setDraft({ ...draft, name })}
            />
          </div>
          <div className={FIELD}>
            <span className={LABEL}>{t('team.experts.fields.id')}</span>
            <Input
              size='small'
              value={draft.id}
              disabled={locked}
              onChange={(id) => setDraft({ ...draft, id: id.trim().toLowerCase() })}
            />
          </div>
          <div className={FIELD}>
            <span className={LABEL}>{t('team.experts.fields.summary')}</span>
            <Input.TextArea
              value={draft.summary}
              disabled={locked}
              autoSize={{ minRows: 2, maxRows: 4 }}
              onChange={(summary) => setDraft({ ...draft, summary })}
            />
          </div>
          {issue && <div className='text-12px text-danger-6'>{t(`team.experts.issues.${issue}`)}</div>}
          <div className='flex justify-end gap-6px'>
            <Button size='small' disabled={locked} onClick={() => setDraft(undefined)}>
              {t('common.cancel')}
            </Button>
            <Button
              size='small'
              type='primary'
              disabled={locked || Boolean(issue)}
              loading={state.busy === 'create'}
              onClick={() => void state.create(draft, modules, chosen).then((saved) => saved && done())}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
      {state.error && <Alert type='error' content={state.error} />}
    </div>
  );
}
