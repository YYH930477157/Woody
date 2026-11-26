/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MessageThinking from '../MessageThinking';
import MessageToolGroupSummary from '../MessageToolGroupSummary';
import { formatDuration, summarizeActivities, type TurnActivity } from './activity';
import styles from './ProcessGroup.module.css';

const FOLLOW_SLACK_PX = 4;

/**
 * One group of thinking and tool steps. The header names what the group is
 * doing while it runs and what it did once closed; the body opens while the
 * group runs, folds when it closes, and scrolls within a capped height.
 */
const ProcessGroup: React.FC<{ activities: TurnActivity[]; closed: boolean }> = ({ activities, closed }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(!closed);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Follow new steps only while the reader stays at the bottom of the body.
  const followRef = useRef(!closed);
  const [fade, setFade] = useState({ top: false, bottom: false });

  useEffect(() => {
    setExpanded(!closed);
  }, [closed]);

  const summary = useMemo(() => summarizeActivities(activities), [activities]);

  const label = useMemo(() => {
    if (!closed) {
      if (summary.liveTool) {
        const text = t(`conversation.process.running.${summary.liveTool.category}`);
        return summary.liveTool.detail ? text + ' · ' + summary.liveTool.detail : text;
      }
      if (summary.liveThinking) return summary.liveThinking.content.subject || t('conversation.thinking.label');
      return t('conversation.process.running.analysis');
    }
    if (!summary.categories.length) {
      if (!summary.thinkingCount) return t('conversation.process.done.analysis');
      const done = t('conversation.thinking.complete');
      if (!summary.thinkingDuration) return done;
      const duration = formatDuration(summary.thinkingDuration, {
        hour: t('common.unit.hour_short'),
        minute: t('common.unit.minute_short'),
        second: t('common.unit.second_short'),
      });
      return done + ' · ' + duration;
    }
    // The first category leads the sentence; the next two use their mid-sentence form.
    const [lead, ...rest] = summary.categories;
    const first = t(`conversation.process.done.${lead}`);
    const [second, third] = rest.slice(0, 2).map((category) => t(`conversation.process.doneFollowing.${category}`));
    if (summary.categories.length === 1) return first;
    if (summary.categories.length === 2) return t('conversation.process.join.two', { first, second });
    const key = summary.categories.length === 3 ? 'three' : 'more';
    return t(`conversation.process.join.${key}`, { first, second, third });
  }, [closed, summary, t]);

  const updateFade = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const top = body.scrollTop > 0;
    const bottom = body.scrollTop + body.clientHeight < body.scrollHeight - 1;
    setFade((current) => (current.top === top && current.bottom === bottom ? current : { top, bottom }));
  }, []);

  const scrollToEnd = useCallback(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, []);

  // Opening a running group lands on its latest step; opening a closed one starts at the top.
  useLayoutEffect(() => {
    if (!expanded) return;
    followRef.current = !closed;
    if (closed) {
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
    } else {
      scrollToEnd();
    }
    updateFade();
  }, [closed, expanded, scrollToEnd, updateFade]);

  useLayoutEffect(() => {
    if (expanded && followRef.current) scrollToEnd();
    updateFade();
  }, [activities, expanded, scrollToEnd, updateFade]);

  useEffect(() => {
    const content = contentRef.current;
    if (!expanded || !content || typeof ResizeObserver === 'undefined') return;
    // Thinking and tool output grow without a new activity, so watch the content size too.
    const observer = new ResizeObserver(() => {
      if (followRef.current) scrollToEnd();
      updateFade();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [expanded, scrollToEnd, updateFade]);

  const handleScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    followRef.current = body.scrollTop + body.clientHeight >= body.scrollHeight - FOLLOW_SLACK_PX;
    updateFade();
  };

  const bodyClass = [
    styles.body,
    expanded ? '' : styles.collapsed,
    fade.top ? styles.fadeTop : '',
    fade.bottom ? styles.fadeBottom : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={styles.root} data-testid='process-group' data-closed={String(closed)}>
      <div
        className={styles.header}
        role='button'
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        }}
      >
        <span className={styles.icon}>
          <span className={closed ? styles.status : styles.status + ' ' + styles.statusRunning} />
        </span>
        <span className={styles.label}>{label}</span>
        <span className={expanded ? styles.arrow + ' ' + styles.arrowOpen : styles.arrow}>
          <span />
        </span>
      </div>
      <div
        ref={bodyRef}
        className={bodyClass}
        data-testid='process-group-body'
        data-expanded={String(expanded)}
        onScroll={handleScroll}
      >
        <div ref={contentRef} className={styles.content}>
          {activities.map((activity, index) =>
            activity.type === 'thinking' ? (
              <MessageThinking key={activity.message.id} message={activity.message} />
            ) : (
              <MessageToolGroupSummary key={'tools-' + index} messages={activity.messages} flat />
            )
          )}
        </div>
      </div>
    </div>
  );
};

export default React.memo(ProcessGroup);
