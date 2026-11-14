import type { IMessageThinking } from '@/common/chat/chatLib';
import { hasRunningToolMessages, normalizeToolMessages, type ToolMessage } from '@/common/chat/normalizeToolCall';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MessageThinking from './MessageThinking';
import MessageToolGroupSummary from './MessageToolGroupSummary';
import './MessageTurnActivitySummary.css';

export type TurnActivity = { type: 'thinking'; message: IMessageThinking } | { type: 'tools'; messages: ToolMessage[] };

const formatDuration = (duration: number, secondUnit: string, minuteUnit: string): string => {
  const seconds = Math.max(0, Math.floor(duration / 1000));
  if (seconds < 60) return seconds + secondUnit;
  return Math.floor(seconds / 60) + minuteUnit + ' ' + (seconds % 60) + secondUnit;
};

const MessageTurnActivitySummary: React.FC<{ activities: TurnActivity[] }> = ({ activities }) => {
  const { t } = useTranslation();
  const hasRunning = activities.some((activity) =>
    activity.type === 'thinking'
      ? activity.message.content.status !== 'done'
      : hasRunningToolMessages(activity.messages)
  );
  const [expanded, setExpanded] = useState(hasRunning);

  useEffect(() => {
    setExpanded(hasRunning);
  }, [hasRunning]);

  const thinking = useMemo(
    () =>
      activities.find(
        (activity): activity is Extract<TurnActivity, { type: 'thinking' }> => activity.type === 'thinking'
      ),
    [activities]
  );
  const duration = activities.reduce(
    (total, activity) => (activity.type === 'thinking' ? total + (activity.message.content.duration ?? 0) : total),
    0
  );
  const toolCount = activities.reduce(
    (total, activity) => (activity.type === 'tools' ? total + normalizeToolMessages(activity.messages).length : total),
    0
  );
  const label =
    thinking?.message.content.status === 'done' && !hasRunning
      ? t('conversation.thinking.complete', { defaultValue: 'Thought complete' }) +
        ' · ' +
        formatDuration(
          duration,
          t('common.unit.second_short', { defaultValue: 's' }),
          t('common.unit.minute_short', { defaultValue: 'm' })
        )
      : thinking?.message.content.subject ||
        (thinking ? t('conversation.thinking.label', { defaultValue: 'Thinking...' }) : t('messages.viewSteps'));

  return (
    <div className='turn-activity-summary'>
      <div className='turn-activity-summary__header' onClick={() => setExpanded((value) => !value)}>
        <span className='turn-activity-summary__icon'>
          <span
            className={'turn-activity-summary__status' + (hasRunning ? ' turn-activity-summary__status--running' : '')}
          />
        </span>
        <span className='turn-activity-summary__label'>
          {label}
          {toolCount > 0 && ' · ' + t('messages.viewSteps') + ' · ' + toolCount}
        </span>
        <span className={'turn-activity-summary__arrow' + (expanded ? ' turn-activity-summary__arrow--open' : '')}>
          <span />
        </span>
      </div>
      <div className={'turn-activity-summary__body' + (expanded ? '' : ' turn-activity-summary__body--collapsed')}>
        {activities.map((activity, index) =>
          activity.type === 'thinking' ? (
            <MessageThinking key={activity.message.id} message={activity.message} />
          ) : (
            <MessageToolGroupSummary key={'tools-' + index} messages={activity.messages} />
          )
        )}
      </div>
    </div>
  );
};

export default React.memo(MessageTurnActivitySummary);
