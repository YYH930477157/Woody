import React, { useState } from 'react';
import { Input } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { parseExpertPaths } from '@/common/types/team/moduleExperts';
import type { ExpertDraft } from './useModuleExperts';

type Props = {
  draft: ExpertDraft;
  disabled: boolean;
  onChange: (patch: Partial<Omit<ExpertDraft, 'key' | 'selected'>>) => void;
};

const FIELD = 'grid grid-cols-[96px_minmax(0,1fr)] items-start gap-x-10px';
const LABEL = 'pt-6px text-12px leading-18px text-t-secondary';

/** The fields of one expert. Paths keep the typed text, so a new line can be started before it holds a path. */
const ExpertEditor: React.FC<Props> = ({ draft, disabled, onChange }) => {
  const { t } = useTranslation();
  const [pathsText, setPathsText] = useState(() => draft.paths.join('\n'));
  return (
    <div data-testid={`team-expert-editor-${draft.key}`} className='mt-8px flex flex-col gap-8px'>
      <div className={FIELD}>
        <span className={LABEL}>{t('team.experts.fields.name')}</span>
        <Input
          size='small'
          value={draft.name}
          disabled={disabled}
          placeholder={t('team.experts.fields.namePlaceholder')}
          onChange={(name) => onChange({ name })}
          data-testid='team-expert-name'
        />
      </div>
      <div className={FIELD}>
        <span className={LABEL}>{t('team.experts.fields.id')}</span>
        <div className='flex flex-col gap-2px'>
          <Input
            size='small'
            value={draft.id}
            disabled={disabled}
            placeholder='sensor'
            onChange={(id) => onChange({ id: id.trim().toLowerCase() })}
            data-testid='team-expert-id'
          />
          <span className='text-11px leading-16px text-t-tertiary'>{t('team.experts.fields.idHint')}</span>
        </div>
      </div>
      <div className={FIELD}>
        <span className={LABEL}>{t('team.experts.fields.summary')}</span>
        <Input.TextArea
          value={draft.summary}
          disabled={disabled}
          autoSize={{ minRows: 1, maxRows: 4 }}
          placeholder={t('team.experts.fields.summaryPlaceholder')}
          onChange={(summary) => onChange({ summary })}
          data-testid='team-expert-summary'
        />
      </div>
      <div className={FIELD}>
        <span className={LABEL}>{t('team.experts.fields.paths')}</span>
        <Input.TextArea
          value={pathsText}
          disabled={disabled}
          autoSize={{ minRows: 2, maxRows: 8 }}
          placeholder={t('team.experts.fields.pathsPlaceholder')}
          onChange={(text) => {
            setPathsText(text);
            onChange({ paths: parseExpertPaths(text) });
          }}
          data-testid='team-expert-paths'
        />
      </div>
    </div>
  );
};

export default ExpertEditor;
