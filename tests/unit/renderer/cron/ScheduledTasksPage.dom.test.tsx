/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ICronJob } from '@/common/adapter/ipcBridge';

const { navigate, pauseJob } = vi.hoisted(() => ({ navigate: vi.fn(), pauseJob: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { error?: string }) => options?.error || key,
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('@renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => ({ isMobile: false }) }));
vi.mock('@/common/config/configService', () => ({ configService: { get: () => false, setLocal: vi.fn() } }));
vi.mock('@/common/adapter/ipcBridge', () => ({ systemSettings: { setKeepAwake: { invoke: vi.fn() } } }));
vi.mock('@renderer/pages/conversation/hooks/useConversationAssistants', () => ({
  useConversationAssistants: () => ({ presetAssistants: [] }),
}));
vi.mock('@renderer/utils/model/agentLogo', () => ({ useAgentLogos: () => ({}), resolveAgentLogo: () => null }));
vi.mock('@/renderer/pages/cron/ScheduledTasksPage/CreateTaskDialog', () => ({ default: () => null }));
vi.mock('@/renderer/components/base/TalkToButlerButton', () => ({ default: () => null }));
vi.mock('@/renderer/components/base', () => ({ AionSearchInput: () => null }));
vi.mock('@/renderer/pages/settings/components/SettingsPageHeader', () => ({
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('@renderer/pages/cron/useCronJobs', () => ({
  useAllCronJobs: () => ({
    loading: false,
    pauseJob,
    resumeJob: vi.fn(),
    jobs: [
      {
        id: 'email-scan',
        name: 'Todo email scan',
        enabled: true,
        schedule: { kind: 'cron', expr: '45 8 * * *', description: 'Daily' },
        target: { execution_mode: 'existing', payload: { kind: 'message', text: 'Scan mail' } },
        metadata: { agent_type: 'aionrs', conversation_id: 'conv-1', created_by: 'user', created_at: 1, updated_at: 1 },
        state: {
          last_status: 'error',
          last_error: 'Mail scan failed: endpoint unavailable',
          run_count: 1,
          retry_count: 0,
          max_retries: 0,
          queue_enabled: false,
        },
      } satisfies ICronJob,
    ],
  }),
}));

import ScheduledTasksPage from '@/renderer/pages/cron/ScheduledTasksPage';

class CaptureError extends React.Component<React.PropsWithChildren, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? <div role='alert'>{this.state.error}</div> : this.props.children;
  }
}

describe('ScheduledTasksPage error indicator', () => {
  it('shows the failure without crashing or navigating, then remains usable after closing it', async () => {
    render(
      <CaptureError>
        <ScheduledTasksPage />
      </CaptureError>
    );
    const indicator = screen.getByLabelText('Mail scan failed: endpoint unavailable');
    fireEvent.mouseEnter(indicator);
    fireEvent.click(indicator);
    await waitFor(() => expect(screen.getByText('Mail scan failed: endpoint unavailable')).toBeVisible());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.mouseLeave(indicator);
    await waitFor(() => expect(screen.queryByText('Mail scan failed: endpoint unavailable')).not.toBeInTheDocument());
    fireEvent.click(screen.getByText('Todo email scan'));
    expect(navigate).toHaveBeenCalledWith('/scheduled/email-scan');
  });
});
