/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDuration } from './activity';
import type { TurnProcessItem } from './grouping';
import styles from './TurnProcessControl.module.css';

const useNow = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
};

/**
 * The row under a turn's opening message. A running turn shows its clock and
 * cannot fold; a finished turn shows how long it took and folds or unfolds
 * every process group in it at once. Replies stay visible either way.
 */
const TurnProcessControl: React.FC<{ item: TurnProcessItem; folded: boolean; onToggle: () => void }> = ({
  item,
  folded,
  onToggle,
}) => {
  const { t } = useTranslation();
  const now = useNow(item.running && item.startedAt !== undefined);
  const units = {
    hour: t('common.unit.hour_short'),
    minute: t('common.unit.minute_short'),
    second: t('common.unit.second_short'),
  };

  let label: string;
  if (item.running) {
    label =
      item.startedAt !== undefined
        ? t('conversation.process.turn.running', {
            // Show at least one second, as the clock starts when the turn does.
            duration: formatDuration(Math.max(1000, now - item.startedAt), units),
          })
        : t('conversation.process.turn.runningNoTime');
  } else {
    label =
      item.startedAt !== undefined && item.endedAt !== undefined
        ? t('conversation.process.turn.done', { duration: formatDuration(item.endedAt - item.startedAt, units) })
        : t('conversation.process.turn.doneNoTime');
  }

  if (item.running) {
    return (
      <div className={styles.root} data-testid='turn-process' data-running='true'>
        <span className={styles.label}>{label}</span>
      </div>
    );
  }
  const toggleTitle = folded ? t('conversation.process.turn.show') : t('conversation.process.turn.hide');
  return (
    <div
      className={styles.root + ' ' + styles.toggle}
      data-testid='turn-process'
      data-folded={String(folded)}
      role='button'
      tabIndex={0}
      aria-expanded={!folded}
      title={toggleTitle}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      <span className={styles.label}>{label}</span>
      <span className={folded ? styles.arrow : styles.arrow + ' ' + styles.arrowOpen}>
        <span />
      </span>
    </div>
  );
};

export default React.memo(TurnProcessControl);
