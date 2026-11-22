/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAssistantMock = vi.fn();
const listProvidersMock = vi.fn();

vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: {
      get: {
        invoke: (...args: unknown[]) => getAssistantMock(...args),
      },
    },
    mode: {
      listProviders: {
        invoke: (...args: unknown[]) => listProvidersMock(...args),
      },
    },
  },
}));

import { resolveDefaultTeamAgentModel } from '@/renderer/pages/team/components/teamCreateModelResolver';

describe('resolveDefaultTeamAgentModel', () => {
  beforeEach(() => {
    getAssistantMock.mockReset();
    listProvidersMock.mockReset();
    listProvidersMock.mockResolvedValue([]);
  });

  it('prefers the assistant fixed default model over agent-level fallbacks', async () => {
    getAssistantMock.mockResolvedValue({
      defaults: {
        model: { mode: 'fixed', value: 'claude-sonnet-4-5-20250514' },
      },
      preferences: {
        last_model_id: 'claude-opus-4-1-20250805',
      },
    });

    await expect(
      resolveDefaultTeamAgentModel({
        assistant_id: 'assistant-fixed',
      })
    ).resolves.toBe('claude-sonnet-4-5-20250514');
  });

  it('uses the assistant remembered auto model before falling back to backend defaults', async () => {
    getAssistantMock.mockResolvedValue({
      defaults: {
        model: { mode: 'auto' },
      },
      preferences: {
        last_model_id: 'gemini-2.5-pro',
      },
    });

    await expect(
      resolveDefaultTeamAgentModel({
        assistant_id: 'assistant-auto',
      })
    ).resolves.toBe('gemini-2.5-pro');
  });

  it('falls back to the assistant engine backend when no assistant-owned model is stored', async () => {
    getAssistantMock.mockResolvedValue({
      defaults: {
        model: { mode: 'auto' },
      },
      preferences: {
        last_model_id: undefined,
      },
      engine: {
        agent_id: 'cc126dd5',
        agent: {
          id: 'cc126dd5',
          type: 'acp',
          source: 'builtin',
          acp_backend: 'gemini',
        },
      },
    });

    await expect(
      resolveDefaultTeamAgentModel({
        assistant_id: 'assistant-gemini',
      })
    ).resolves.toBe('auto');
  });

  it('uses the provided assistant backend when detail lookup fails', async () => {
    getAssistantMock.mockRejectedValue(new Error('lookup failed'));

    await expect(
      resolveDefaultTeamAgentModel({
        assistant_id: 'assistant-gemini',
        assistant_backend: 'gemini',
      })
    ).resolves.toBe('auto');
  });

  it('returns an empty model for antigravity assistants resolved from engine details', async () => {
    getAssistantMock.mockResolvedValue({
      defaults: {
        model: { mode: 'auto' },
      },
      preferences: {
        last_model_id: undefined,
      },
      engine: {
        agent_id: 'agy-agent',
        agent: {
          id: 'agy-agent',
          type: 'acp',
          source: 'builtin',
          acp_backend: 'antigravity',
        },
      },
    });

    await expect(
      resolveDefaultTeamAgentModel({
        assistant_id: 'assistant-antigravity',
      })
    ).resolves.toBe('');
  });

  it('returns an empty model for the antigravity backend when detail lookup fails', async () => {
    getAssistantMock.mockRejectedValue(new Error('lookup failed'));

    await expect(
      resolveDefaultTeamAgentModel({
        assistant_id: 'assistant-antigravity',
        assistant_backend: 'antigravity',
      })
    ).resolves.toBe('');
  });

  it('gives an aionrs assistant without a model the first available model, like a new chat', async () => {
    listProvidersMock.mockResolvedValue([
      { id: 'empty', platform: 'custom', name: 'Empty', base_url: '', api_key: '', models: [] },
      {
        id: 'relay',
        platform: 'custom',
        name: 'Relay',
        base_url: '',
        api_key: '',
        models: ['mimo-v2.6-flash', 'deepseek-flash'],
        model_enabled: { 'mimo-v2.6-flash': false },
      },
    ]);
    getAssistantMock.mockResolvedValue({
      defaults: { model: { mode: 'auto' } },
      preferences: { last_model_id: undefined },
      engine: { agent_id: 'aionrs', agent: { id: 'aionrs', type: 'aionrs', source: 'builtin' } },
    });

    await expect(resolveDefaultTeamAgentModel({ assistant_id: 'woody-meter-lead' })).resolves.toBe('deepseek-flash');
  });

  it('keeps the default placeholder for aionrs when no model is configured', async () => {
    await expect(
      resolveDefaultTeamAgentModel({
        assistant_backend: 'aionrs',
      })
    ).resolves.toBe('default');
  });

  it('keeps the default placeholder for aionrs when the providers cannot be read', async () => {
    listProvidersMock.mockRejectedValue(new Error('backend not ready'));

    await expect(resolveDefaultTeamAgentModel({ assistant_backend: 'aionrs' })).resolves.toBe('default');
  });

  it('keeps the default placeholder for other ACP backends such as claude', async () => {
    await expect(
      resolveDefaultTeamAgentModel({
        assistant_backend: 'claude',
      })
    ).resolves.toBe('default');
  });
});
