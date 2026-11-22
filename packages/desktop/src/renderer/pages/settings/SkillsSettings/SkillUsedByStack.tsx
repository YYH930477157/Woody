/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SkillUsedByStack — compact overlapping avatar stack shown on a skill card
 * to surface which assistants have the skill attached. Mirrors the agent
 * page's BoundAssistantStack, capped with a "+N" pill.
 */

import type { Assistant } from '@/common/types/agent/assistantTypes';
import { resolveLocaleKey } from '@/common/utils';
import AssistantAvatar from '@/renderer/pages/settings/AssistantSettings/AssistantAvatar';
import { Tooltip } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatNameList } from '@/renderer/services/i18n/list';

export const getSkillAvatarColorClass = (name: string): string => {
  if (!name) return 'bg-primary-6 text-white';
  const colors = [
    'bg-primary-6 text-white',
    'bg-success-6 text-white',
    'bg-brand text-white',
    'bg-danger-5 text-white',
    'bg-warning-6 text-white',
    'bg-aou-7 text-white',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

/**
 * Assistants that have this skill attached (enabled or custom list, or not
 * excluded via `disabled_builtin_skills` for auto-injected builtin skills).
 * The live API may omit the skill arrays on some assistants, so guard all.
 */
export const getAssistantsUsingSkill = (
  skillName: string,
  assistants: Assistant[],
  options?: { isAutoInject?: boolean }
): Assistant[] => {
  if (options?.isAutoInject) {
    return assistants.filter((a) => !(a.disabled_builtin_skills ?? []).includes(skillName));
  }
  return assistants.filter(
    (a) => (a.enabled_skills ?? []).includes(skillName) || (a.custom_skill_names ?? []).includes(skillName)
  );
};

const SkillUsedByStack: React.FC<{ assistants: Assistant[]; max?: number }> = ({ assistants, max = 4 }) => {
  const { t, i18n } = useTranslation();
  const localeKey = resolveLocaleKey(i18n.language);
  if (assistants.length === 0) return null;

  const shown = assistants.slice(0, max);
  const overflow = assistants.length - shown.length;
  const names = formatNameList(
    assistants.map((a) => a.name_i18n?.[localeKey] || a.name),
    i18n.language
  );

  return (
    <Tooltip
      content={t('settings.skillsHub.usedByTooltip', {
        count: assistants.length,
        names,
        defaultValue: `Used by ${assistants.length} assistant(s): ${names}`,
      })}
    >
      <div className='flex items-center' data-testid='skill-used-by-stack'>
        {shown.map((assistant, index) => (
          <div
            key={assistant.id}
            className='overflow-hidden rounded-full border-2 border-solid border-bg-2'
            style={{ marginInlineStart: index === 0 ? 0 : -7, zIndex: shown.length - index }}
          >
            <AssistantAvatar assistant={assistant} size={22} />
          </div>
        ))}
        {overflow > 0 && (
          <div
            className='flex items-center justify-center rounded-full border-2 border-solid border-bg-2 bg-fill-3 text-9px font-600 text-t-secondary'
            style={{ width: 22, height: 22, marginInlineStart: -7 }}
          >
            +{overflow}
          </div>
        )}
      </div>
    </Tooltip>
  );
};

export default SkillUsedByStack;
