/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { CODEBASE_MEMORY_SKILL_NAME } from '@/common/types/codebaseMemory/constants';

type AvailableSkill = {
  name: string;
  description: string;
  is_auto_inject: boolean;
  source: 'builtin' | 'custom' | 'cron' | 'extension';
};

export type GuidSkillOption = { name: string; description: string; isAuto: boolean };

/**
 * Auto skills start checked and are switched off through the disabled list.
 * Built-in auto-inject skills are auto. So is the codebase memory skill: it
 * belongs to the project's codebase memory tools and goes with them unless the
 * user switches it off. It cannot be opt-in, because the enabled list is filled
 * from the assistant's defaults, which never name it.
 */
export const toGuidSkillOption = (skill: AvailableSkill): GuidSkillOption => ({
  name: skill.name,
  description: skill.description,
  isAuto: (skill.source === 'builtin' && skill.is_auto_inject) || skill.name === CODEBASE_MEMORY_SKILL_NAME,
});
