import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WorkflowPresets from '@/renderer/pages/team/WorkflowPresets';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('workflow template selection', () => {
  it('shows the bugfix stages and only selectable configuration sources', async () => {
    render(
      <WorkflowPresets
        preset='bugfix'
        assistants={[
          { id: 'good', name: 'Available', team_selectable: true },
          { id: 'blocked', name: 'Blocked', team_selectable: false },
        ]}
        disabled={false}
        onPresetChange={vi.fn()}
        onBaseChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('team-workflow-stages').textContent).toBe(
      'team.workflow.roles.requirements → team.workflow.roles.implementation → team.workflow.roles.testing → team.workflow.roles.review → team.workflow.roles.delivery'
    );
    fireEvent.click(screen.getByLabelText('team.workflow.baseAssistant'));
    await waitFor(() => expect(screen.getByText('Available')).toBeVisible());
    expect(screen.queryByText('Blocked')).not.toBeInTheDocument();
  });

  it('keeps the source empty when no supported assistant exists', () => {
    render(
      <WorkflowPresets
        preset='review'
        assistants={[]}
        disabled={false}
        onPresetChange={vi.fn()}
        onBaseChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText('team.workflow.baseAssistant')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('team-workflow-stages')).not.toHaveTextContent('team.workflow.roles.implementation');
  });

  it('locks both selections while roles are prepared or creation is running', () => {
    render(
      <WorkflowPresets preset='feature' assistants={[]} disabled onPresetChange={vi.fn()} onBaseChange={vi.fn()} />
    );
    expect(screen.getByLabelText('team.workflow.label')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByLabelText('team.workflow.baseAssistant')).toHaveAttribute('aria-disabled', 'true');
  });
});
