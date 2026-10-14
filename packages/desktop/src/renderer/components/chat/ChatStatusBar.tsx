/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Tooltip } from '@arco-design/web-react';
import { BookOpen, Lightning, Timer } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import ContextUsageIndicator from '@renderer/components/agent/ContextUsageIndicator';
import { formatTokenCount } from '@renderer/components/agent/ContextUsageIndicator';
import type { AionrsUsageStats } from '@renderer/pages/conversation/platforms/aionrs/useAionrsMessage';

interface ChatStatusBarProps {
  running: boolean;
  /** Turn origin (persisted turn clock), null when idle. */
  startedAtMs: number | null;
  firstTokenAtMs: number | null;
  /** Frozen whole-turn duration once finish arrived; null while running. */
  finalElapsedMs: number | null;
  usageStats: AionrsUsageStats | null;
  /** Total streamed text length of the active turn — live speed estimate. */
  getLiveTextLength: () => number;
  className?: string;
}

/** Rough chars-per-token ratio for the pre-usage streaming estimate. */
const CHARS_PER_TOKEN = 4;

const formatSeconds = (ms: number): string => {
  const seconds = ms / 1000;
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);
    return `${minutes}m${rest.toString().padStart(2, '0')}s`;
  }
  return `${seconds.toFixed(1)}s`;
};

const formatSpeed = (tokensPerSecond: number): string => `${tokensPerSecond.toFixed(1)} tok/s`;

/**
 * Cherry-Studio-style live status strip for aionrs conversations:
 * generation speed / prompt-cache hit / response time / context occupancy.
 * Every segment degrades to `--` when its datum is unknown — no fabricated
 * numbers, no percentage against a guessed context window.
 */
const ChatStatusBar: React.FC<ChatStatusBarProps> = ({
  running,
  startedAtMs,
  firstTokenAtMs,
  finalElapsedMs,
  usageStats,
  getLiveTextLength,
  className = '',
}) => {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [now, setNow] = useState(() => Date.now());

  // Tick while running so elapsed / estimated speed advance live.
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

  if (!usageStats && !running) {
    return null;
  }

  // Speed: exact per-call value from the engine once reported; before that,
  // a rough chars/4 estimate of the stream in flight. Never both.
  const exactSpeed =
    usageStats && usageStats.duration_ms > 0 && usageStats.output_tokens > 0
      ? (usageStats.output_tokens / usageStats.duration_ms) * 1000
      : null;
  const estimateSpeed =
    running && firstTokenAtMs && now > firstTokenAtMs ? getLiveTextLength() / CHARS_PER_TOKEN / ((now - firstTokenAtMs) / 1000) : null;
  const speedText = exactSpeed !== null ? formatSpeed(exactSpeed) : estimateSpeed !== null ? `~${formatSpeed(estimateSpeed)}` : '--';

  // Cache hit: share of the latest call's prompt served from the provider's
  // prompt cache. Zero-denominator (provider reports nothing) → `--`.
  const cachePct =
    usageStats && usageStats.input_tokens > 0 && usageStats.cache_read_tokens > 0
      ? (usageStats.cache_read_tokens / usageStats.input_tokens) * 100
      : null;

  // Response time: frozen after finish, live while the turn runs.
  const elapsedMs = finalElapsedMs ?? (running && startedAtMs && now > startedAtMs ? now - startedAtMs : null);

  const segment = (icon: React.ReactNode, label: string, value: React.ReactNode, tooltip: React.ReactNode) => (
    <Tooltip
      content={tooltip}
      position='top'
      mini
      className='chat-status-bar-tooltip'
    >
      <span className='flex items-center gap-4px whitespace-nowrap cursor-default'>
        <span className='inline-flex items-center text-14px leading-none'>{icon}</span>
        <span>{label}</span>
        <span className='text-t-secondary font-[500] tabular-nums'>{value}</span>
      </span>
    </Tooltip>
  );

  return (
    <div className={`chat-status-bar flex items-center gap-16px text-12px text-t-tertiary ${className}`}>
      {segment(
        <Lightning theme='outline' size='13' fill='currentColor' />,
        t('conversation.statusBar.speed', 'Speed'),
        speedText,
        exactSpeed !== null
          ? t('conversation.statusBar.speedExact', 'Last call: {{output}} tokens in {{seconds}}', {
              output: usageStats?.output_tokens ?? 0,
              seconds: formatSeconds(usageStats?.duration_ms ?? 0),
            })
          : t('conversation.statusBar.speedEstimate', 'Rough estimate from streamed text until the engine reports usage')
      )}
      {segment(
        <BookOpen theme='outline' size='13' fill='currentColor' />,
        t('conversation.statusBar.cacheHit', 'Cache'),
        cachePct !== null ? `${Math.round(cachePct)}%` : '--',
        cachePct !== null && usageStats
          ? `${t('conversation.contextUsage.cachedRead', 'Cache read')} ${formatTokenCount(usageStats.cache_read_tokens, locale)} · ${t(
              'conversation.contextUsage.cachedWrite',
              'Cache write'
            )} ${formatTokenCount(usageStats.cache_creation_tokens, locale)} / ${t('conversation.contextUsage.input', 'Input')} ${formatTokenCount(
              usageStats.input_tokens,
              locale
            )}`
          : t('conversation.statusBar.cacheUnknown', 'Provider reports no prompt-cache usage')
      )}
      {segment(
        <Timer theme='outline' size='13' fill='currentColor' />,
        t('conversation.statusBar.elapsed', 'Time'),
        elapsedMs !== null ? formatSeconds(elapsedMs) : '--',
        t('conversation.statusBar.elapsedTip', 'Whole turn, tools included')
      )}
      {usageStats && usageStats.context_usage > 0 ? (
        <ContextUsageIndicator
          tokenUsage={{ total_tokens: usageStats.context_usage }}
          context_limit={usageStats.context_window}
          size={16}
          className='-ms-6px'
        />
      ) : null}
    </div>
  );
};

export default ChatStatusBar;
