/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { type ScmActionReport } from '../useScmActions';

const reportToneClass = (tone: ScmActionReport['tone']): string =>
  tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : 'text-danger';

/**
 * The action outcome's one-line summary, living inline in the header row to the
 * left of the refresh button. Tone carries the distinction that matters: a
 * `warning` means the action **partly happened** (message states counts, never
 * "failed"), while `error` means nothing happened. Only the message and its
 * dismiss control belong here — the detail and retry are wide/rare and go to
 * `ActionReportExtras` so this stays one line. `data-scm-report` stays on this
 * node so existing selectors keep resolving the report by tone.
 */
export const ActionReportSummary: React.FC<{
  report: ScmActionReport;
  onDismiss: () => void;
}> = ({ report, onDismiss }) => {
  const { t } = useTranslation();
  return (
    <div data-scm-report={report.tone} className='flex-1 min-w-0 flex items-center gap-4px text-12px'>
      <span className={`flex-1 min-w-0 truncate ${reportToneClass(report.tone)}`}>{report.message}</span>
      <Button type='text' size='mini' className='flex-shrink-0' aria-label={t('common.close')} onClick={onDismiss}>
        ×
      </Button>
    </div>
  );
};

/**
 * The report's secondary parts — a failed-file detail line and a retry button —
 * on their own full-width row below the header. Renders nothing when neither is
 * present (the common success case), so the summary stays a single line up top.
 * Retry appears only when trying again could actually succeed.
 */
export const ActionReportExtras: React.FC<{
  report: ScmActionReport;
  /** Disables retry while another action is in flight (parity with row/bulk buttons). */
  busy: boolean;
  onRetry: () => void;
}> = ({ report, busy, onRetry }) => {
  const { t } = useTranslation();
  if (!report.detail && !report.retryable) return null;
  return (
    <div className='flex-shrink-0 flex items-start gap-4px px-8px py-4px text-12px border-b border-[var(--bg-3)]'>
      {report.detail && <div className='flex-1 min-w-0 text-t-tertiary break-all'>{report.detail}</div>}
      {report.retryable && (
        <Button type='text' size='mini' data-scm-retry disabled={busy} onClick={onRetry}>
          {t('conversation.explorer.scm.actions.retry')}
        </Button>
      )}
    </div>
  );
};

/**
 * Full-panel state message. `details` and `hint` are the diagnostic tail — the folders the backend was asked about
 * and the raw reason it returned — so a "no repository here" report can be acted on without reading logs.
 */
export const PanelNotice: React.FC<{
  text: string;
  hint?: string;
  details?: Array<{ label: string; values: string[] }>;
}> = ({ text, hint, details = [] }) => (
  // The scroll container and the `min-h-full` inner box keep a tall notice (folders + hint) scrollable instead of
  // clipped at the top, which is what a plain `justify-center` + `overflow-auto` would do in a short sidebar.
  <div className='h-full overflow-auto px-16px py-16px text-center text-t-secondary text-13px'>
    <div className='min-h-full flex flex-col items-center justify-center gap-8px'>
      <div>{text}</div>
      {details
        .filter((group) => group.values.length > 0)
        .map((group) => (
          <div key={group.label} className='text-12px' data-scm-diagnostic='details'>
            <div className='text-t-tertiary'>{group.label}</div>
            <ul className='m-0 p-0 list-none'>
              {group.values.map((value) => (
                <li key={value} className='break-all font-mono'>
                  {value}
                </li>
              ))}
            </ul>
          </div>
        ))}
      {hint && (
        <div className='max-w-420px text-12px text-t-tertiary' data-scm-diagnostic='hint'>
          {hint}
        </div>
      )}
    </div>
  </div>
);
