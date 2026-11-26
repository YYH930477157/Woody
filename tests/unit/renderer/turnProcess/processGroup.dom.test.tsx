/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IMessageThinking, IMessageToolGroup } from '@/common/chat/chatLib';
import {
  ProcessGroup,
  TurnProcessControl,
  type TurnActivity,
} from '@/renderer/pages/conversation/Messages/components/TurnProcess';

vi.mock('react-i18next', async () => {
  const { enT } = await import('./enT');
  return { useTranslation: () => ({ t: enT }) };
});

vi.mock('@/renderer/pages/conversation/Messages/components/MessageThinking', () => ({
  default: ({ message }: { message: IMessageThinking }) => <div data-testid={'thinking-' + message.id} />,
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary', () => ({
  default: () => <div data-testid='tool-summary' />,
}));

const tools = (calls: Array<[string, string, string?]>): TurnActivity => ({
  type: 'tools',
  messages: [
    {
      id: 'group-' + calls.map(([id]) => id).join(''),
      conversation_id: 'c1',
      type: 'tool_group',
      content: calls.map(([id, name, status]) => ({
        call_id: id,
        name,
        description: 'npm test',
        status: status ?? 'Success',
        renderOutputAsMarkdown: false,
      })),
    } as unknown as IMessageToolGroup,
  ],
});

const thought = (id: string, status: 'thinking' | 'done', duration = 0): TurnActivity => ({
  type: 'thinking',
  message: { id, conversation_id: 'c1', type: 'thinking', content: { content: id, status, duration } },
});

describe('ProcessGroup', () => {
  it('names what a closed group did and folds its body', () => {
    render(
      <ProcessGroup
        closed
        activities={[
          tools([
            ['a', 'Read'],
            ['b', 'Read'],
            ['c', 'Grep'],
          ]),
        ]}
      />
    );
    expect(screen.getByText('Read files and searched code')).toBeInTheDocument();
    expect(screen.getByTestId('process-group-body')).toHaveAttribute('data-expanded', 'false');
  });

  it('joins three categories and marks more with "and more"', () => {
    const { rerender } = render(
      <ProcessGroup
        closed
        activities={[
          tools([
            ['a', 'Read'],
            ['b', 'Grep'],
            ['c', 'ExecCommand'],
          ]),
        ]}
      />
    );
    expect(screen.getByText('Read files, searched code, ran commands')).toBeInTheDocument();
    rerender(
      <ProcessGroup
        closed
        activities={[
          tools([
            ['a', 'Read'],
            ['b', 'Grep'],
            ['c', 'ExecCommand'],
            ['d', 'Edit'],
          ]),
        ]}
      />
    );
    expect(screen.getByText('Read files, searched code, ran commands and more')).toBeInTheDocument();
  });

  it('shows the running tool and its detail while open, and folds when the group closes', () => {
    const activities = [thought('t1', 'done'), tools([['a', 'ExecCommand', 'Executing']])];
    const { rerender } = render(<ProcessGroup closed={false} activities={activities} />);
    expect(screen.getByText('Running commands · npm test')).toBeInTheDocument();
    expect(screen.getByTestId('process-group-body')).toHaveAttribute('data-expanded', 'true');

    rerender(<ProcessGroup closed activities={activities} />);
    expect(screen.getByTestId('process-group-body')).toHaveAttribute('data-expanded', 'false');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('process-group-body')).toHaveAttribute('data-expanded', 'true');
  });

  it('keeps the thinking time for a group that only thought', () => {
    render(<ProcessGroup closed activities={[thought('t1', 'done', 2400)]} />);
    expect(screen.getByText('Thought complete · 2s')).toBeInTheDocument();
  });
});

describe('TurnProcessControl', () => {
  const base = { type: 'turn_process' as const, id: 'turn-process-u1', turnId: 'u1', created_at: 1000 };

  it('shows the duration of a finished turn and toggles its fold', () => {
    const onToggle = vi.fn();
    render(
      <TurnProcessControl
        item={{ ...base, startedAt: 1000, endedAt: 73_000, running: false }}
        folded
        onToggle={onToggle}
      />
    );
    const row = screen.getByRole('button');
    expect(row).toHaveTextContent('Done in 1m 12s');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows a running clock that cannot fold', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    render(<TurnProcessControl item={{ ...base, startedAt: 5000, running: true }} folded={false} onToggle={vi.fn()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByTestId('turn-process')).toHaveTextContent('Working, 5s so far ···');
    vi.useRealTimers();
  });
});
