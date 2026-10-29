/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { TChatConversation } from '@/common/config/storage';
import { buildGroupedHistory } from '@/renderer/pages/conversation/GroupedHistory/utils/groupingHelpers';

const t = (key: string): string => key;

const conversation = (id: string, extra: TChatConversation['extra'], modified_at: number): TChatConversation =>
  ({
    id,
    name: id,
    type: 'acp',
    created_at: modified_at,
    modified_at,
    extra,
  }) as TChatConversation;

describe('buildGroupedHistory', () => {
  const managedConversation = (id: string, projectId: string, path: string, marker = projectId): TChatConversation =>
    ({
      ...conversation(id, { workspace: path, custom_workspace: Boolean(path) }, 100),
      type: 'aionrs',
      project_id: projectId,
      extra: { workspace: path, custom_workspace: Boolean(path), workspace_project_id: marker },
    }) as TChatConversation;

  it('keeps independent managed workspaces separate when their physical root is identical', () => {
    const result = buildGroupedHistory(
      [managedConversation('a', 'p1', '/shared'), managedConversation('b', 'p2', '/shared')],
      t
    );
    expect(result.timelineSections[0].items.map((item) => item.workspaceGroup?.project_id)).toEqual(['p1', 'p2']);
  });

  it('keeps one managed workspace together after its default folder changes', () => {
    const result = buildGroupedHistory(
      [managedConversation('a', 'p', '/old'), managedConversation('b', 'p', '/new')],
      t
    );
    expect(result.timelineSections[0].items).toHaveLength(1);
    expect(result.timelineSections[0].items[0].workspaceGroup?.conversations).toHaveLength(2);
  });

  it('groups an empty managed workspace using the authoritative project identity', () => {
    const result = buildGroupedHistory([managedConversation('a', 'actual', '', 'stale')], t);
    expect(result.timelineSections[0].items[0]).toMatchObject({
      type: 'workspace',
      workspaceGroup: { project_id: 'actual' },
    });
  });

  it('keeps scheduled-task conversations in the regular conversation timeline', () => {
    const result = buildGroupedHistory(
      [conversation('cron-conversation', { backend: 'aioncore', cron_job_id: 'job-1' }, 100)],
      t
    );

    expect(result.timelineSections[0]?.items).toEqual([
      expect.objectContaining({
        type: 'conversation',
        conversation: expect.objectContaining({ id: 'cron-conversation' }),
      }),
    ]);
  });

  it('keeps scheduled-task conversations with workspaces in the project section', () => {
    const result = buildGroupedHistory(
      [
        conversation(
          'cron-project-conversation',
          {
            backend: 'aioncore',
            cron_job_id: 'job-1',
            workspace: '/repo/aionui',
            custom_workspace: true,
          },
          100
        ),
      ],
      t
    );

    expect(result.timelineSections[0]?.items).toEqual([
      expect.objectContaining({
        type: 'workspace',
        workspaceGroup: expect.objectContaining({
          workspace: '/repo/aionui',
          conversations: [expect.objectContaining({ id: 'cron-project-conversation' })],
        }),
      }),
    ]);
  });

  it('continues to hide team-owned conversations from the regular history', () => {
    const result = buildGroupedHistory(
      [conversation('team-conversation', { backend: 'aioncore', team_id: 'team-1' }, 100)],
      t
    );

    expect(result.timelineSections).toEqual([]);
  });
});
