import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CommitWorkflowModal,
  type CommitWorkflowModalProps,
} from '@/renderer/pages/conversation/SourceControl/CommitWorkflowModal';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const props = (): CommitWorkflowModalProps => ({
  visible: true,
  repo: {
    repo_id: 'r',
    provider_id: 'git',
    root: { pe_id: 'p', relative_path: '' },
    label: 'repo',
    capabilities: { staging: true, local_branches: true, history_graph: true, remote_ops: true },
    state: 'idle',
  },
  resources: [
    { file: { pe_id: 'p', relative_path: 'a.c' }, repo_relative_path: 'a.c', state: 'modified', staged: false },
  ],
  state: 'confirmation',
  messageFields: { reason: 'fix', scope: 'display', solution: 'update', impact: 'none', tests: 'checked' },
  diagnostics: [],
  draftReady: false,
  checks: { scanners: [], compile: false, autoRepair: false },
  onChecksChange: vi.fn(),
  onCancel: vi.fn(),
  onDraft: vi.fn(),
  onStart: vi.fn(),
  onCommit: vi.fn(),
  onRetryPush: vi.fn(),
  onMessageFieldsChange: vi.fn(),
});

describe('checked commit choices', () => {
  it('exposes Amend before checks and freezes the choice while checking', () => {
    const onAmendChange = vi.fn();
    const options = {
      ...props(),
      state: 'idle' as const,
      onAmendChange,
      mode: { kind: 'amend' as const, expectedHead: 'a'.repeat(40) },
    };
    const { rerender } = render(<CommitWorkflowModal {...options} />);
    const amend = screen.getByRole('checkbox', { name: 'conversation.explorer.scm.commit.amend' });
    expect(amend).toBeChecked();
    fireEvent.click(amend);
    expect(onAmendChange).toHaveBeenCalledWith(false);
    rerender(<CommitWorkflowModal {...options} state='scan' />);
    expect(amend).toBeDisabled();
  });
  it('does not start checks while the Amend target is being captured', () => {
    const options = { ...props(), state: 'idle' as const, onAmendChange: vi.fn(), amendLoading: true };
    render(<CommitWorkflowModal {...options} />);
    expect(screen.getByRole('button', { name: 'conversation.explorer.scm.commit.continueCommit' })).toBeDisabled();
  });
  it('separates a local commit from committing and pushing', () => {
    const options = props();
    render(<CommitWorkflowModal {...options} />);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.explorer.scm.commit.commitOnly' }));
    expect(options.onCommit).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.explorer.scm.commit.commitAndPush' }));
    expect(options.onCommit).toHaveBeenCalledWith(true);
  });
  it('allows complete manually entered fields to proceed without generating an AI draft', () => {
    const options = { ...props(), state: 'idle' as const };
    render(<CommitWorkflowModal {...options} />);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.explorer.scm.commit.continueCommit' }));
    expect(options.onStart).toHaveBeenCalledOnce();
    expect(options.onDraft).not.toHaveBeenCalled();
  });
  it('does not enable commit confirmation while checks are running', () => {
    render(<CommitWorkflowModal {...props()} state='scan' />);
    expect(screen.queryByRole('button', { name: 'conversation.explorer.scm.commit.commitOnly' })).toBeNull();
  });
});
