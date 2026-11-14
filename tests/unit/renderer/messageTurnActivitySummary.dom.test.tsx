import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IMessageThinking } from '@/common/chat/chatLib';
import MessageTurnActivitySummary from '@/renderer/pages/conversation/Messages/components/MessageTurnActivitySummary';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageThinking', () => ({
  default: ({ message }: { message: IMessageThinking }) => (
    <div data-testid={'thinking-' + message.id}>{message.content.content}</div>
  ),
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary', () => ({
  default: ({ messages }: { messages: unknown[] }) => <div data-testid='tool-summary'>{messages.length} tools</div>,
}));

const thinking = (id: string, status: 'thinking' | 'done'): IMessageThinking => ({
  id,
  conversation_id: 'conversation-1',
  type: 'thinking',
  created_at: 1,
  content: { content: id, status, duration: 1000 },
});

describe('MessageTurnActivitySummary', () => {
  it('combines thinking and tools behind one collapsed entry after completion', () => {
    render(
      <MessageTurnActivitySummary
        activities={[
          { type: 'thinking', message: thinking('thinking-1', 'done') },
          {
            type: 'tools',
            messages: [
              {
                id: 'tool-1',
                conversation_id: 'conversation-1',
                type: 'tool_call',
                content: { call_id: 'call-1', name: 'rg', args: {}, status: 'completed' },
              },
            ],
          },
          { type: 'thinking', message: thinking('thinking-2', 'done') },
        ]}
      />
    );

    expect(screen.getByText('Thought complete · 2s · messages.viewSteps · 1')).toBeInTheDocument();
    expect(screen.getByTestId('thinking-thinking-1').parentElement).toHaveClass(
      'turn-activity-summary__body--collapsed'
    );
    fireEvent.click(screen.getByText('Thought complete · 2s · messages.viewSteps · 1'));
    expect(screen.getByTestId('thinking-thinking-1')).toBeInTheDocument();
    expect(screen.getByTestId('thinking-thinking-2')).toBeInTheDocument();
  });

  it('opens while the current thinking activity is still running', () => {
    render(
      <MessageTurnActivitySummary activities={[{ type: 'thinking', message: thinking('thinking-1', 'thinking') }]} />
    );

    expect(screen.getByTestId('thinking-thinking-1')).toBeInTheDocument();
  });
});
