/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assistant } from '@/common/types/agent/assistantTypes';

const createTeamInvokeMock = vi.fn();
const deleteAssistantInvokeMock = vi.fn();
const resolveDefaultTeamAgentModelMock = vi.fn();
const messageErrorMock = vi.fn();
const messageWarningMock = vi.fn();
const sendToAgentMock = vi.fn();
const prepareWorkflowMock = vi.fn();
const prepareRolesMock = vi.fn();
const memberExtrasMock = vi.fn();

vi.mock('@renderer/pages/team/WorkflowPresets/memberExtras', () => ({
  prepareTeamMemberExtras: (...args: unknown[]) => memberExtrasMock(...args),
}));

vi.mock('@renderer/pages/team/WorkflowPresets/prepareWorkflow', () => ({
  prepareWorkflow: (...args: unknown[]) => prepareWorkflowMock(...args),
  prepareRoles: (...args: unknown[]) => prepareRolesMock(...args),
  WorkflowPreparationError: class extends Error {},
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@renderer/pages/conversation/hooks/useConversationAssistants', () => ({
  useConversationAssistants: () => ({
    presetAssistants: assistants(),
  }),
}));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return {
    ...actual,
    Message: {
      ...actual.Message,
      error: (...args: unknown[]) => messageErrorMock(...args),
      warning: (...args: unknown[]) => messageWarningMock(...args),
    },
  };
});

// Mirror AionModal's real prop contract: header/footer may be config objects.
// The standard variant renders the title as an <h3> (text-18px) and the optional
// subtitle as a <p> (text-13px leading-20px); footer is rendered via footer.render().
vi.mock('@renderer/components/base/AionModal', () => {
  type HeaderConfig = { render?: () => React.ReactNode; title?: React.ReactNode; subtitle?: React.ReactNode };
  type FooterConfig = { render?: () => React.ReactNode };
  const renderHeader = (header: unknown): React.ReactNode => {
    if (!header || typeof header !== 'object') return header as React.ReactNode;
    const cfg = header as HeaderConfig;
    if (cfg.render) return cfg.render();
    return (
      <div>
        {cfg.title ? <h3 className='text-18px font-600 leading-26px text-t-primary m-0'>{cfg.title}</h3> : null}
        {cfg.subtitle ? <p className='text-13px leading-20px text-t-secondary m-0 mt-4px'>{cfg.subtitle}</p> : null}
      </div>
    );
  };
  const renderFooter = (footer: unknown): React.ReactNode => {
    if (!footer || typeof footer !== 'object') return footer as React.ReactNode;
    const cfg = footer as FooterConfig;
    return cfg.render ? cfg.render() : (footer as React.ReactNode);
  };
  return {
    default: ({ visible, header, footer, children, style }: Record<string, unknown>) =>
      visible ? (
        <div
          data-testid='team-create-modal'
          data-width={(style as React.CSSProperties | undefined)?.width}
          data-max-width={(style as React.CSSProperties | undefined)?.maxWidth}
        >
          {renderHeader(header)}
          <div>{children as React.ReactNode}</div>
          <div>{renderFooter(footer)}</div>
        </div>
      ) : null,
  };
});

vi.mock('@renderer/components/workspace', () => ({
  WorkspaceFolderSelect: ({ onChange }: { onChange: (value: string) => void }) => (
    <div data-testid='workspace-folder-select' onClick={() => onChange('D:\\work\\project')} />
  ),
}));

const worktreeMocks = vi.hoisted(() => ({ inspect: vi.fn(), create: vi.fn(), discard: vi.fn() }));
const expertsMocks = vi.hoisted(() => ({
  experts: vi.fn(),
  save: vi.fn(),
  cards: vi.fn(),
  getStatus: vi.fn(),
  saveConfig: vi.fn(),
  startIndex: vi.fn(),
}));
vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: () => true }));

vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: {
      delete: { invoke: (...args: unknown[]) => deleteAssistantInvokeMock(...args) },
    },
    team: {
      create: { invoke: (...args: unknown[]) => createTeamInvokeMock(...args) },
      sendMessageToAgent: { invoke: (...args: unknown[]) => sendToAgentMock(...args) },
    },
    gitWorkbench: {
      teamWorktreeInspect: { invoke: worktreeMocks.inspect },
      teamWorktreeCreate: { invoke: worktreeMocks.create },
      teamWorktreeDiscard: { invoke: worktreeMocks.discard },
    },
    codebaseMemory: {
      get: { invoke: expertsMocks.getStatus },
      save: { invoke: expertsMocks.saveConfig },
      start: { invoke: expertsMocks.startIndex },
      experts: { invoke: expertsMocks.experts },
      saveExperts: { invoke: expertsMocks.save },
      moduleCards: { invoke: expertsMocks.cards },
    },
  },
}));

vi.mock('@renderer/pages/team/components/teamCreateModelResolver', () => ({
  resolveDefaultTeamAgentModel: (...args: unknown[]) => resolveDefaultTeamAgentModelMock(...args),
}));

import TeamCreateModal from '@/renderer/pages/team/components/TeamCreateModal';
import { LayoutContext } from '@/renderer/hooks/context/LayoutContext';

// Render inside a LayoutContext flagged as mobile so the component takes the
// narrow-screen branch (single column + bottom-sheet assistant picker).
const renderMobile = (ui: React.ReactElement) =>
  render(
    <LayoutContext.Provider value={{ isMobile: true, siderCollapsed: false, setSiderCollapsed: () => {} }}>
      {ui}
    </LayoutContext.Provider>
  );

describe('TeamCreateModal', () => {
  beforeEach(() => {
    createTeamInvokeMock.mockReset();
    createTeamInvokeMock.mockResolvedValue({ id: 'team-1', assistants: [], agents: [] });
    deleteAssistantInvokeMock.mockReset();
    deleteAssistantInvokeMock.mockResolvedValue(true);
    resolveDefaultTeamAgentModelMock.mockReset();
    resolveDefaultTeamAgentModelMock.mockResolvedValue(undefined);
    messageErrorMock.mockReset();
    memberExtrasMock.mockReset();
    memberExtrasMock.mockResolvedValue(undefined);
    prepareWorkflowMock.mockReset();
    prepareWorkflowMock.mockResolvedValue([
      { role: 'leader', assistant_id: 'workflow-leader', assistant_name: 'Requirements', model: 'configured-model' },
    ]);
    worktreeMocks.inspect.mockReset();
    worktreeMocks.inspect.mockResolvedValue({ root: 'D:\\work\\project', branch: 'main', head: 'abc', dirty: false });
    worktreeMocks.create.mockReset();
    worktreeMocks.create.mockResolvedValue({
      state: 'complete',
      worktree: {
        workspace: 'D:\\work\\project-feature',
        worktree: 'D:\\work\\project-feature',
        branch: 'team/feature',
        base: 'main',
      },
    });
    worktreeMocks.discard.mockReset();
    worktreeMocks.discard.mockResolvedValue(true);
    prepareRolesMock.mockReset();
    prepareRolesMock.mockResolvedValue([
      { role: 'leader', assistant_id: 'dispatcher-copy', assistant_name: '总管', model: 'configured-model' },
    ]);
    expertsMocks.experts.mockReset();
    expertsMocks.save.mockReset();
    // Without codebase memory the card call fails, like the real one for a project without it.
    expertsMocks.cards.mockReset();
    expertsMocks.cards.mockRejectedValue(new Error('Codebase memory is disabled for this project'));
    expertsMocks.getStatus.mockReset();
    expertsMocks.saveConfig.mockReset();
    expertsMocks.startIndex.mockReset();
    messageWarningMock.mockReset();
    sendToAgentMock.mockReset();
    sendToAgentMock.mockResolvedValue({ accepted: true });
  });

  const EXPERTS_FILE = 'D:\\work\\project\\.woody\\experts.json';
  const sensor = { id: 'sensor', name: 'Sensor 专家', summary: 'Sensor sampling', paths: ['src/sensor.c'] };
  const ui = { id: 'ui', name: 'UI 专家', summary: 'Screens', paths: ['src/ui.c'] };
  const startExpertTeam = async () => {
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('team.workflow.label'));
    fireEvent.click(await screen.findByText('team.workflow.experts'));
    expect(screen.getByTestId('team-workflow-experts-hint')).toHaveTextContent('team.experts.hint');
    fireEvent.click(screen.getByLabelText('team.workflow.baseAssistant'));
    fireEvent.click(await screen.findByText('Aion 命令行'));
    fireEvent.change(screen.getByTestId('team-create-name-input'), { target: { value: 'Demo' } });
    expect(screen.getByTestId('team-experts-notice')).toHaveTextContent('team.experts.selectWorkspace');
    fireEvent.click(screen.getByTestId('workspace-folder-select'));
  };

  it('creates a dispatcher, the chosen experts and a verifier from the saved expert list', async () => {
    expertsMocks.experts.mockResolvedValue({
      file: EXPERTS_FILE,
      saved: { version: 1, experts: [sensor, ui], shared: ['src/tasks.c'] },
      cards: [],
      business: true,
    });
    await startExpertTeam();
    fireEvent.click(within(await screen.findByTestId('team-expert-ui')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
    await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(1));
    expect(expertsMocks.experts).toHaveBeenCalledWith({ repoPath: 'D:\\work\\project' });
    // Choosing who joins is not a change to the saved list.
    expect(expertsMocks.save).not.toHaveBeenCalled();
    const { roles, workspace } = prepareRolesMock.mock.calls[0][0];
    expect(workspace).toBe('D:\\work\\project');
    expect(roles.map((role: { name: string }) => role.name)).toEqual([
      'team.experts.roles.dispatcher',
      'Sensor 专家',
      'team.experts.roles.verifier',
    ]);
    expect(roles[0].rules).toContain('src/tasks.c');
    expect(roles[0].rules).not.toContain('UI 专家');
    expect(roles[1].rules).toContain('.woody/features/sensor.md');
    expect(createTeamInvokeMock.mock.calls[0][0]).toMatchObject({
      workspace: 'D:\\work\\project',
      agents: [{ role: 'leader', assistant_id: 'dispatcher-copy', assistant_name: '总管', model: 'configured-model' }],
    });
  });

  it('passes the main workspace to prepareRoles while creating an isolated worktree team', async () => {
    expertsMocks.experts.mockResolvedValue({
      file: EXPERTS_FILE,
      saved: { version: 1, experts: [sensor], shared: ['src/tasks.c'] },
      cards: [],
      business: true,
    });
    await startExpertTeam();
    await screen.findByTestId('team-expert-sensor');
    fireEvent.click(await screen.findByRole('switch', { name: 'team.create.isolated.label' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
    await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(1));

    const { roles, workspace } = prepareRolesMock.mock.calls[0][0];
    expect(workspace).toBe('D:\\work\\project');
    expect(roles[1].rules).toContain('D:\\work\\project\\.woody/features/sensor.md');
    expect(createTeamInvokeMock.mock.calls[0][0]).toMatchObject({
      workspace: 'D:\\work\\project-feature',
      workspace_mode: 'isolated',
    });
    // Template roles carry the codebase memory tools; the team still gets its files folder.
    expect(memberExtrasMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: 'D:\\work\\project', withCodebaseMemory: false })
    );
  });

  it('enables and builds the index from the banner and seeds split module wildcards when no experts exist yet', async () => {
    expertsMocks.experts.mockResolvedValue({ file: EXPERTS_FILE, saved: null, cards: [], business: true });
    expertsMocks.getStatus.mockResolvedValue({
      repoPath: 'D:\\work\\project',
      config: { version: 1, enabled: false, mode: 'full' },
      available: true,
      phase: 'idle',
      log: '',
    });
    expertsMocks.saveConfig.mockResolvedValue({
      repoPath: 'D:\\work\\project',
      config: { version: 1, enabled: true, mode: 'full' },
      available: true,
      phase: 'idle',
      log: '',
    });
    expertsMocks.startIndex.mockImplementation(async () => {
      expertsMocks.cards.mockResolvedValue({
        indexPhase: 'succeeded',
        modules: [
          {
            id: 'display',
            files: ['app/display_lcd.c', 'app/display_menu.c', 'app/display.h'],
            split: { dir: 'app', base: 'display' },
            tables: ['secondList'],
            functions: ['DISPLAY_Second'],
            experts: [],
          },
        ],
        experts: [],
      });
      return {
        repoPath: 'D:\\work\\project',
        config: { version: 1, enabled: true, mode: 'full' },
        available: true,
        phase: 'succeeded',
        log: '',
      };
    });

    await startExpertTeam();
    const banner = await screen.findByTestId('team-experts-index-banner');
    expect(banner).toHaveTextContent('team.experts.indexStatus.disabled');
    fireEvent.click(screen.getByTestId('team-experts-index-action'));

    await waitFor(() => expect(screen.queryByTestId('team-experts-index-banner')).toBeNull());
    expect(expertsMocks.saveConfig).toHaveBeenCalledWith({
      repoPath: 'D:\\work\\project',
      config: { version: 1, enabled: true, mode: 'full' },
    });
    expect(expertsMocks.startIndex).toHaveBeenCalledWith({ repoPath: 'D:\\work\\project', language: 'zh-CN' });
    const row = await screen.findByTestId('team-expert-display');
    // A complete seeded expert starts folded; open it to see its paths.
    fireEvent.click(within(row).getByRole('button', { name: 'common.edit' }));
    expect(within(row).getByPlaceholderText('team.experts.fields.pathsPlaceholder')).toHaveValue(
      'app/display_*.c\napp/display.h'
    );

    // A seeded expert is complete: the team is created without filling anything in.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
    await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(1));
    expect(expertsMocks.save).toHaveBeenCalledWith({
      repoPath: 'D:\\work\\project',
      file: {
        version: 1,
        experts: [
          {
            id: 'display',
            // The untranslated key is longer than a name may be, so the id stands in.
            name: 'display',
            summary: 'conversation.codebaseMemory.modules.summaryDraft',
            paths: ['app/display_*.c', 'app/display.h'],
          },
        ],
        shared: [],
      },
    });
  });

  it('re-seeds untouched expert drafts from the new index after a refresh', async () => {
    expertsMocks.experts.mockResolvedValue({ file: EXPERTS_FILE, saved: null, cards: [], business: true });
    expertsMocks.cards.mockResolvedValue({
      indexPhase: 'succeeded',
      indexDrift: { added: 1, modified: 0, deleted: 0 },
      modules: [{ id: 'display', files: ['app/display.c'], tables: [], functions: [], experts: [] }],
      experts: [],
    });
    expertsMocks.getStatus.mockResolvedValue({
      repoPath: 'D:\\work\\project',
      config: { version: 1, enabled: true, mode: 'full' },
      available: true,
      phase: 'succeeded',
      log: '',
    });
    expertsMocks.startIndex.mockImplementation(async () => {
      expertsMocks.cards.mockResolvedValue({
        indexPhase: 'succeeded',
        modules: [
          {
            id: 'display',
            files: ['app/display.c', 'app/display_lcd.c', 'app/display_menu.c'],
            split: { dir: 'app', base: 'display' },
            tables: [],
            functions: [],
            experts: [],
          },
        ],
        experts: [],
      });
      return {
        repoPath: 'D:\\work\\project',
        config: { version: 1, enabled: true, mode: 'full' },
        available: true,
        phase: 'succeeded',
        log: '',
      };
    });

    await startExpertTeam();
    const paths = () =>
      within(screen.getByTestId('team-expert-display')).getByPlaceholderText('team.experts.fields.pathsPlaceholder');
    const open = () =>
      fireEvent.click(within(screen.getByTestId('team-expert-display')).getByRole('button', { name: 'common.edit' }));
    await screen.findByTestId('team-expert-display');
    open();
    expect(paths()).toHaveValue('app/display.c');
    fireEvent.click(screen.getByTestId('team-experts-index-action'));

    // The re-seeded row is a new draft, so it starts folded again.
    await waitFor(() => expect(screen.queryByTestId('team-experts-index-banner')).toBeNull());
    open();
    expect(paths()).toHaveValue('app/display.c\napp/display_*.c');
  });

  it('offers Index anyway when the pre-check refused the index, and bypasses it on click', async () => {
    expertsMocks.experts.mockResolvedValue({
      file: EXPERTS_FILE,
      saved: { version: 1, experts: [sensor], shared: [] },
      cards: [],
      business: true,
    });
    expertsMocks.cards.mockResolvedValue({
      indexPhase: 'failed',
      indexError: 'Woody reads ciphertext',
      indexPrecheckRefused: true,
      modules: [],
      experts: [],
    });
    expertsMocks.getStatus.mockResolvedValue({
      repoPath: 'D:\\work\\project',
      config: { version: 1, enabled: true, mode: 'full' },
      available: true,
      phase: 'failed',
      log: '',
    });
    expertsMocks.startIndex.mockResolvedValue({
      repoPath: 'D:\\work\\project',
      config: { version: 1, enabled: true, mode: 'full' },
      available: true,
      phase: 'running',
      log: '',
    });

    await startExpertTeam();
    const banner = await screen.findByTestId('team-experts-index-banner');
    expect(banner).toHaveTextContent('team.experts.indexStatus.precheckRefused');
    expect(screen.getByTestId('team-experts-index-action')).toHaveTextContent('team.experts.indexStatus.indexAnyway');
    fireEvent.click(screen.getByTestId('team-experts-index-action'));

    await waitFor(() =>
      expect(expertsMocks.startIndex).toHaveBeenCalledWith({
        repoPath: 'D:\\work\\project',
        language: 'zh-CN',
        bypassPrecheck: true,
      })
    );
  });

  it('warns when disk sources drifted since the last index and refreshes on click', async () => {
    expertsMocks.experts.mockResolvedValue({
      file: EXPERTS_FILE,
      saved: { version: 1, experts: [sensor], shared: [] },
      cards: [],
      business: true,
    });
    expertsMocks.cards.mockResolvedValue({
      indexPhase: 'succeeded',
      indexDrift: { added: 2, modified: 1, deleted: 1 },
      modules: [],
      experts: [{ id: 'sensor', card: '.woody/features/sensor.md', state: 'stale' }],
    });
    expertsMocks.getStatus.mockResolvedValue({
      repoPath: 'D:\\work\\project',
      config: { version: 1, enabled: true, mode: 'full' },
      available: true,
      phase: 'succeeded',
      log: '',
    });
    expertsMocks.startIndex.mockImplementation(async () => {
      expertsMocks.cards.mockResolvedValue({
        indexPhase: 'succeeded',
        modules: [],
        experts: [{ id: 'sensor', card: '.woody/features/sensor.md', state: 'ready' }],
      });
      return {
        repoPath: 'D:\\work\\project',
        config: { version: 1, enabled: true, mode: 'full' },
        available: true,
        phase: 'succeeded',
        log: '',
      };
    });

    await startExpertTeam();
    const banner = await screen.findByTestId('team-experts-index-banner');
    expect(banner).toHaveTextContent('team.experts.indexStatus.outdated');
    fireEvent.click(screen.getByTestId('team-experts-index-action'));

    await waitFor(() => expect(screen.queryByTestId('team-experts-index-banner')).toBeNull());
    expect(expertsMocks.saveConfig).not.toHaveBeenCalled();
    expect(expertsMocks.startIndex).toHaveBeenCalledWith({ repoPath: 'D:\\work\\project', language: 'zh-CN' });
    expect(screen.getByTestId('team-expert-card-sensor')).toHaveTextContent(
      'conversation.codebaseMemory.modules.states.ready'
    );
  });

  describe('experts learning their modules', () => {
    const digest = {
      files: 2,
      entries: ['secondList #1 SENSOR_Second'],
      provides: [{ name: 'SENSOR_Read', callers: ['UI 专家'] }],
      writtenOutside: ['sensorLevel'],
      issues: { partial: 1, unusable: 0, changed: 0, missingFunctions: 0, missingGlobals: 2, unmatched: 0 },
    };
    const cards = {
      modules: [],
      experts: [
        { id: 'sensor', card: '.woody/features/sensor.md', state: 'missing', digest },
        { id: 'ui', card: '.woody/features/ui.md', state: 'ready', digest: { ...digest, entries: [] } },
      ],
    };
    beforeEach(() => {
      expertsMocks.experts.mockResolvedValue({
        file: EXPERTS_FILE,
        saved: { version: 1, experts: [sensor, ui], shared: ['src/tasks.c'] },
        cards: [],
        business: true,
      });
      expertsMocks.cards.mockResolvedValue(cards);
      prepareRolesMock.mockResolvedValue([
        { role: 'leader', assistant_id: 'dispatcher-copy', assistant_name: '总管' },
        { role: 'teammate', assistant_id: 'sensor-copy', assistant_name: 'Sensor 专家' },
        { role: 'teammate', assistant_id: 'ui-copy', assistant_name: 'UI 专家' },
        { role: 'teammate', assistant_id: 'verifier-copy', assistant_name: '验证员' },
      ]);
      createTeamInvokeMock.mockResolvedValue({
        id: 'team-1',
        assistants: [
          { slot_id: 'slot-dispatcher', assistant_id: 'dispatcher-copy' },
          { slot_id: 'slot-sensor', assistant_id: 'sensor-copy' },
          { slot_id: 'slot-ui', assistant_id: 'ui-copy' },
          { slot_id: 'slot-verifier', assistant_id: 'verifier-copy' },
        ],
      });
    });

    it('shows card states, writes missing briefs, puts each digest in its rules and asks only unready experts', async () => {
      await startExpertTeam();
      expect(await screen.findByTestId('team-expert-card-sensor')).toHaveTextContent(
        'conversation.codebaseMemory.modules.states.missing'
      );
      expect(screen.getByTestId('team-expert-card-ui')).toHaveTextContent(
        'conversation.codebaseMemory.modules.states.ready'
      );
      expect(screen.getByText('team.experts.onboardHint')).toBeInTheDocument();
      expect(screen.queryByTestId('team-experts-business')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
      await waitFor(() => expect(sendToAgentMock).toHaveBeenCalledTimes(1));
      expect(expertsMocks.cards).toHaveBeenCalledWith({
        repoPath: 'D:\\work\\project',
        refresh: true,
        ids: [],
        language: 'zh-CN',
      });
      const { roles } = prepareRolesMock.mock.calls[0][0];
      expect(roles[0].rules).toContain('these experts learn their modules and then report to you: Sensor 专家.');
      expect(roles[1].rules).toContain(
        'Your card .woody/features/sensor.md when the team was created: you have not written your part yet.'
      );
      expect(roles[1].rules).toContain('- Scheduled: secondList #1 SENSOR_Second');
      expect(roles[1].rules).toContain('- Called from outside: SENSOR_Read (by UI 专家)');
      expect(roles[1].rules).toContain('- Globals other files write: sensorLevel');
      expect(roles[1].rules).toContain('1 partly parsed files, 2 globals missing from the index graph');
      expect(roles[2].rules).toContain('up to date with your files');
      expect(sendToAgentMock).toHaveBeenCalledExactlyOnceWith({
        team_id: 'team-1',
        slot_id: 'slot-sensor',
        input: 'team.experts.onboardMessage',
      });
      expect(messageWarningMock).not.toHaveBeenCalled();
    });

    it('asks the dispatcher to write the business overview a project lacks, and reports when it cannot', async () => {
      expertsMocks.experts.mockResolvedValue({
        file: EXPERTS_FILE,
        saved: { version: 1, experts: [sensor, ui], shared: ['src/tasks.c'] },
        cards: [],
        business: false,
      });
      sendToAgentMock.mockImplementation(async ({ slot_id }: { slot_id: string }) => {
        if (slot_id === 'slot-dispatcher') throw new Error('session not ready');
        return { accepted: true };
      });
      await startExpertTeam();
      expect(await screen.findByTestId('team-experts-business')).toHaveTextContent('team.experts.onboardBusiness');
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
      await waitFor(() => expect(messageWarningMock).toHaveBeenCalledWith('team.experts.onboardFailed'));
      expect(sendToAgentMock).toHaveBeenCalledWith({
        team_id: 'team-1',
        slot_id: 'slot-dispatcher',
        input: 'team.experts.leadOnboardMessage',
      });
      expect(sendToAgentMock.mock.calls.map(([call]) => call.slot_id)).toEqual(['slot-dispatcher', 'slot-sensor']);
      const { roles } = prepareRolesMock.mock.calls[0][0];
      expect(roles[0].rules).toContain('learn the project’s meter business first');
      expect(roles[0].skills).toEqual(['woody-meter-business']);
    });

    it('asks nobody when the option is off, not even for a missing business overview', async () => {
      expertsMocks.experts.mockResolvedValue({
        file: EXPERTS_FILE,
        saved: { version: 1, experts: [sensor, ui], shared: ['src/tasks.c'] },
        cards: [],
        business: false,
      });
      await startExpertTeam();
      fireEvent.click(await screen.findByTestId('team-experts-onboard'));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
      await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(1));
      const { roles } = prepareRolesMock.mock.calls[0][0];
      expect(roles[0].rules).not.toContain('When the team starts, these experts learn their modules');
      expect(roles[0].rules).not.toContain('learn the project’s meter business first');
      await Promise.resolve();
      expect(sendToAgentMock).not.toHaveBeenCalled();
    });

    it('asks every expert to learn from the source when the project has no codebase memory, and reports a failed request', async () => {
      expertsMocks.cards.mockRejectedValue(new Error('Codebase memory is disabled for this project'));
      sendToAgentMock.mockImplementation(async ({ slot_id }: { slot_id: string }) => {
        if (slot_id === 'slot-ui') throw new Error('session not ready');
        return { accepted: true };
      });
      await startExpertTeam();
      expect(await screen.findByText('team.experts.onboardWithoutMemory')).toBeInTheDocument();
      expect(screen.queryByTestId('team-expert-card-sensor')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
      await waitFor(() => expect(messageWarningMock).toHaveBeenCalledWith('team.experts.onboardFailed'));
      expect(sendToAgentMock.mock.calls.map(([call]) => call.slot_id)).toEqual(['slot-sensor', 'slot-ui']);
      // Only the list read: without memory, nothing asks for briefs.
      expect(expertsMocks.cards).toHaveBeenCalledTimes(1);
      const { roles } = prepareRolesMock.mock.calls[0][0];
      expect(roles[1].rules).not.toContain('Module brief from the code index');
      expect(roles[1].rules).toContain('Learning your module.');
    });
  });

  it('starts from feature cards, requires every expert to be complete, and saves the list first', async () => {
    expertsMocks.experts.mockResolvedValue({ file: EXPERTS_FILE, saved: null, cards: ['sensor'], business: true });
    expertsMocks.save.mockImplementation(async ({ file }: { file: unknown }) => ({
      file: EXPERTS_FILE,
      saved: file,
      cards: ['sensor'],
      business: true,
    }));
    await startExpertTeam();
    const row = await screen.findByTestId('team-expert-sensor');
    expect(within(row).getByText('team.experts.issues.summary')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Create' })).toBeDisabled();
    fireEvent.change(within(row).getByPlaceholderText('team.experts.fields.summaryPlaceholder'), {
      target: { value: 'Sensor sampling' },
    });
    expect(within(row).getByText('team.experts.issues.paths')).toBeInTheDocument();
    fireEvent.change(within(row).getByPlaceholderText('team.experts.fields.pathsPlaceholder'), {
      target: { value: 'src\\sensor.c\nsrc/sensor.h\n' },
    });
    expect(within(row).queryByText(/team\.experts\.issues/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
    await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(1));
    expect(expertsMocks.save).toHaveBeenCalledExactlyOnceWith({
      repoPath: 'D:\\work\\project',
      file: {
        version: 1,
        experts: [
          { id: 'sensor', name: 'sensor', summary: 'Sensor sampling', paths: ['src/sensor.c', 'src/sensor.h'] },
        ],
        shared: [],
      },
    });
    expect(expertsMocks.save.mock.invocationCallOrder[0]).toBeLessThan(prepareRolesMock.mock.invocationCallOrder[0]);
  });

  it('completes a card-based expert from the detected module with the same id', async () => {
    expertsMocks.experts.mockResolvedValue({
      file: EXPERTS_FILE,
      saved: null,
      cards: ['clock', 'qos'],
      business: true,
    });
    expertsMocks.cards.mockResolvedValue({
      indexPhase: 'succeeded',
      modules: [
        { id: 'clock', files: ['app/clock.c', 'app/clock.h'], tables: ['secondList'], functions: [], experts: [] },
      ],
      experts: [],
    });
    await startExpertTeam();
    const clock = await screen.findByTestId('team-expert-clock');
    expect(within(clock).queryByText(/team\.experts\.issues/)).toBeNull();
    fireEvent.click(within(clock).getByRole('button', { name: 'common.edit' }));
    expect(within(clock).getByPlaceholderText('team.experts.fields.pathsPlaceholder')).toHaveValue(
      'app/clock.c\napp/clock.h'
    );
    // No module is called qos: that card still needs its files.
    expect(within(screen.getByTestId('team-expert-qos')).getByText('team.experts.issues.summary')).toBeInTheDocument();
  });

  it('creates nothing when the expert list cannot be saved', async () => {
    expertsMocks.experts.mockResolvedValue({
      file: EXPERTS_FILE,
      saved: { version: 1, experts: [sensor], shared: [] },
      cards: [],
      business: true,
    });
    expertsMocks.save.mockRejectedValue(new Error('read-only folder'));
    await startExpertTeam();
    const row = await screen.findByTestId('team-expert-sensor');
    fireEvent.click(within(row).getByRole('button', { name: 'common.edit' }));
    fireEvent.change(within(row).getByPlaceholderText('team.experts.fields.namePlaceholder'), {
      target: { value: 'Sensor' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
    await waitFor(() => expect(messageErrorMock).toHaveBeenCalledWith('team.experts.saveFailed'));
    expect(prepareRolesMock).not.toHaveBeenCalled();
    expect(createTeamInvokeMock).not.toHaveBeenCalled();
  });

  it('creates the team in a separate worktree and reuses it on retry', async () => {
    createTeamInvokeMock.mockRejectedValueOnce(new Error('offline'));
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('team-create-agent-option-bare-aionrs'));
    fireEvent.change(screen.getByTestId('team-create-name-input'), { target: { value: 'Feature' } });
    fireEvent.click(screen.getByTestId('workspace-folder-select'));
    fireEvent.click(await screen.findByRole('switch', { name: 'team.create.isolated.label' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
    await waitFor(() => expect(messageErrorMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
    await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(2));
    expect(worktreeMocks.create).toHaveBeenCalledExactlyOnceWith({ path: 'D:\\work\\project', name: 'Feature' });
    expect(createTeamInvokeMock.mock.calls[1][0]).toMatchObject({
      workspace: 'D:\\work\\project-feature',
      workspace_mode: 'isolated',
    });
    expect(worktreeMocks.discard).not.toHaveBeenCalled();
  });

  it('gives members picked by hand the extras prepared on the chosen folder', async () => {
    const extras = {
      skills: ['woody-codebase-memory'],
      mcp_server_ids: ['cbm-row'],
      session_files: {
        dir: 'D:\\work\\project\\.woody\\f\\2026-11-25_Feature',
        work_dir: 'D:\\work\\project\\.woody\\f\\2026-11-25_Feature\\work',
        output_dir: 'D:\\work\\project\\.woody\\f\\2026-11-25_Feature\\output',
      },
    };
    memberExtrasMock.mockResolvedValue(extras);
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('team-create-agent-option-bare-aionrs'));
    fireEvent.change(screen.getByTestId('team-create-name-input'), { target: { value: 'Feature' } });
    fireEvent.click(screen.getByTestId('workspace-folder-select'));
    fireEvent.click(await screen.findByRole('switch', { name: 'team.create.isolated.label' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
    await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(1));

    expect(memberExtrasMock).toHaveBeenCalledExactlyOnceWith({
      workspace: 'D:\\work\\project',
      teamName: 'Feature',
      names: {
        root: 'conversation.sessionFiles.rootFolder',
        work: 'conversation.sessionFiles.workFolder',
        output: 'conversation.sessionFiles.outputFolder',
        untitled: 'conversation.sessionFiles.untitled',
      },
      withCodebaseMemory: true,
    });
    expect(createTeamInvokeMock.mock.calls[0][0]).toMatchObject({
      workspace: 'D:\\work\\project-feature',
      member_extras: extras,
    });
  });

  it('removes an unused worktree when cancelling, and keeps the folder without the option', async () => {
    createTeamInvokeMock.mockRejectedValueOnce(new Error('offline'));
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('team-create-agent-option-bare-aionrs'));
    fireEvent.change(screen.getByTestId('team-create-name-input'), { target: { value: 'Feature' } });
    fireEvent.click(screen.getByTestId('workspace-folder-select'));
    fireEvent.click(await screen.findByRole('switch', { name: 'team.create.isolated.label' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
    await waitFor(() => expect(messageErrorMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(worktreeMocks.discard).toHaveBeenCalledWith({ path: 'D:\\work\\project-feature' }));

    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(screen.getAllByTestId('team-create-agent-option-bare-aionrs').at(-1)!);
    fireEvent.change(screen.getAllByTestId('team-create-name-input').at(-1)!, { target: { value: 'Plain' } });
    fireEvent.click(screen.getAllByTestId('workspace-folder-select').at(-1)!);
    await screen.findAllByRole('switch', { name: 'team.create.isolated.label' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm Create' }).at(-1)!);
    await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(2));
    expect(createTeamInvokeMock.mock.calls[1][0]).toMatchObject({
      workspace: 'D:\\work\\project',
      workspace_mode: 'shared',
    });
    expect(worktreeMocks.create).toHaveBeenCalledTimes(1);
  });

  it('keeps blocked assistants visible and prevents selecting them', () => {
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);

    expect(screen.getByTestId('team-create-agent-option-bare-aionrs')).toBeInTheDocument();
    expect(screen.getByText('Aion 命令行')).toBeInTheDocument();
    expect(screen.queryByText('Aion CLI')).not.toBeInTheDocument();
    expect(screen.getByTestId('team-create-agent-option-blocked-reviewer')).toBeInTheDocument();
    expect(screen.getByTestId('team-create-agent-option-remote-runner')).toBeInTheDocument();
    expect(screen.queryByText('Agent internal error (code -32603)')).not.toBeInTheDocument();

    const createButton = screen.getByRole('button', { name: 'Confirm Create' });
    fireEvent.change(screen.getByPlaceholderText('Team name'), {
      target: { value: 'My Team' },
    });
    fireEvent.click(screen.getByTestId('team-create-agent-option-blocked-reviewer'));

    expect(createButton).toBeDisabled();
  });

  it('previews stages without creating roles and requires a source assistant', async () => {
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('team.workflow.label'));
    fireEvent.click(await screen.findByText('team.workflow.feature'));
    fireEvent.change(screen.getByTestId('team-create-name-input'), { target: { value: 'Feature team' } });
    expect(screen.getByTestId('team-workflow-stages')).toHaveTextContent('team.workflow.roles.testing');
    expect(prepareWorkflowMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm Create' })).toBeDisabled();
  });

  it('reuses prepared roles when team creation fails and is retried', async () => {
    createTeamInvokeMock.mockRejectedValueOnce(new Error('offline'));
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('team.workflow.label'));
    fireEvent.click(await screen.findByText('team.workflow.feature'));
    fireEvent.click(screen.getByLabelText('team.workflow.baseAssistant'));
    fireEvent.click(await screen.findByText('Aion 命令行'));
    fireEvent.change(screen.getByTestId('team-create-name-input'), { target: { value: 'Feature team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
    await waitFor(() => expect(messageErrorMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
    await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(2));
    expect(prepareWorkflowMock).toHaveBeenCalledTimes(1);
    expect(createTeamInvokeMock.mock.calls[1][0].agents).toEqual([
      { role: 'leader', assistant_id: 'workflow-leader', assistant_name: 'Requirements', model: 'configured-model' },
    ]);
    expect(deleteAssistantInvokeMock).not.toHaveBeenCalled();
  });

  it('deletes prepared workflow roles when cancelling after team creation fails', async () => {
    createTeamInvokeMock.mockRejectedValueOnce(new Error('offline'));
    const onClose = vi.fn();
    render(<TeamCreateModal visible onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('team.workflow.label'));
    fireEvent.click(await screen.findByText('team.workflow.feature'));
    fireEvent.click(screen.getByLabelText('team.workflow.baseAssistant'));
    fireEvent.click(await screen.findByText('Aion 命令行'));
    fireEvent.change(screen.getByTestId('team-create-name-input'), { target: { value: 'Feature team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
    await waitFor(() => expect(messageErrorMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(deleteAssistantInvokeMock).toHaveBeenCalledWith({ id: 'workflow-leader' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not create a team if role preparation fails', async () => {
    prepareWorkflowMock.mockRejectedValueOnce(new Error('rule save failed'));
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('team.workflow.label'));
    fireEvent.click(await screen.findByText('team.workflow.feature'));
    fireEvent.click(screen.getByLabelText('team.workflow.baseAssistant'));
    fireEvent.click(await screen.findByText('Aion 命令行'));
    fireEvent.change(screen.getByTestId('team-create-name-input'), { target: { value: 'Feature team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));
    await waitFor(() => expect(messageErrorMock).toHaveBeenCalled());
    expect(createTeamInvokeMock).not.toHaveBeenCalled();
  });

  it('keeps blocked assistant rows single-line while the reason stays out of the row', () => {
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);

    const blockedOption = screen.getByTestId('team-create-agent-option-blocked-reviewer');
    const rowContent = blockedOption.querySelector('[data-testid="team-assistant-picker-row-content"]');

    expect(blockedOption).toHaveClass('!h-44px');
    expect(blockedOption).not.toHaveClass('!h-auto', '!min-h-56px');
    expect(rowContent).toHaveClass('w-full', 'items-center', 'justify-between');
    expect(rowContent).not.toHaveClass('flex-col');
    expect(screen.queryByText('Agent internal error (code -32603)')).not.toBeInTheDocument();
  });

  it('renders blocked assistant rows as muted and non-actionable', () => {
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);

    const blockedOption = screen.getByTestId('team-create-agent-option-blocked-reviewer');
    const rowContent = blockedOption.querySelector('[data-testid="team-assistant-picker-row-content"]');
    const optionName = blockedOption.querySelector('[data-testid="assistant-option-name"]');
    const addIcon = blockedOption.querySelector('[data-testid="team-assistant-picker-add-icon"]');

    expect(blockedOption.tagName).toBe('BUTTON');
    expect(blockedOption).toHaveAttribute('aria-disabled', 'true');
    expect(blockedOption).toHaveAttribute('tabindex', '-1');
    expect(blockedOption).toHaveClass('w-full');
    expect(blockedOption).not.toHaveClass('hover:!bg-fill-2');
    expect(rowContent).toHaveClass('cursor-not-allowed', 'text-t-tertiary');
    expect(rowContent).toHaveClass('w-full', 'items-center', 'justify-between');
    expect(optionName).toHaveClass('text-t-tertiary');
    expect(addIcon).toHaveClass('flex', 'h-30px', 'w-30px', 'items-center', 'justify-center', 'text-t-quaternary');
    expect(addIcon).not.toHaveClass('mt-7px');
  });

  it('renders the reference two-column creation layout with details on the selected-member side', () => {
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);

    const subtitle =
      'Let multiple AI assistants team up and collaborate. We suggest one team focuses on a single goal — create separate teams for different tasks.';
    expect(screen.getByRole('heading', { name: 'New Team' })).toBeInTheDocument();
    expect(screen.getByText(subtitle)).toBeInTheDocument();
    expect(screen.getByTestId('team-create-modal')).toHaveAttribute('data-width', '900');
    expect(screen.getByTestId('team-create-modal')).toHaveAttribute('data-max-width', 'calc(100vw - 72px)');
    expect(screen.getByRole('heading', { name: 'New Team' })).toHaveClass('text-18px');
    expect(screen.getByText(subtitle)).toHaveClass('text-13px', 'leading-20px');

    const assistantPane = screen.getByTestId('team-create-assistant-pane');
    const detailsPane = screen.getByTestId('team-create-details-pane');
    const layout = screen.getByTestId('team-create-layout');
    const searchInput = within(assistantPane).getByTestId('team-create-agent-search');
    const nameInput = within(detailsPane).getByTestId('team-create-name-input');

    expect(layout).toHaveStyle({ height: 'min(54vh, 470px)', minHeight: '390px' });
    expect(assistantPane).toHaveClass('px-20px', 'pt-12px', 'pb-18px');
    expect(detailsPane).toHaveClass('px-20px', 'pt-12px', 'pb-14px');
    expect(within(assistantPane).getByText('All assistants (3)')).toBeInTheDocument();
    expect(within(assistantPane).getByText('All assistants (3)')).toHaveClass('text-15px');
    expect(searchInput.tagName).toBe('INPUT');
    expect(searchInput).toHaveAttribute('placeholder', 'Search');
    expect(within(assistantPane).getByTestId('team-create-agent-picker-body')).not.toHaveClass('bg-fill-1');
    expect(within(assistantPane).getByTestId('team-create-agent-picker-body')).toHaveClass('bg-dialog-fill-0');
    expect(within(assistantPane).getByTestId('team-create-agent-option-bare-aionrs')).toHaveClass('!h-44px');
    expect(within(assistantPane).getByTestId('team-create-agent-option-bare-aionrs')).toHaveClass('hover:!bg-fill-2');
    expect(within(detailsPane).getByText('Selected members 0')).toBeInTheDocument();
    expect(within(detailsPane).getByText('Selected members 0')).toHaveClass('text-15px');
    expect(nameInput).toHaveClass('!h-38px', '!text-13px');
    expect(within(detailsPane).getByTestId('workspace-folder-select')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Create' })).toHaveClass('!h-38px', '!text-13px');
  });

  it('passes assistant identity through when creating a team with an assistant leader', async () => {
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Team name'), {
      target: { value: 'Docs Team' },
    });
    fireEvent.click(screen.getByTestId('team-create-agent-option-bare-aionrs'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));

    await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(1));

    const payload = createTeamInvokeMock.mock.calls[0][0];
    expect(resolveDefaultTeamAgentModelMock).toHaveBeenCalledWith({
      assistant_id: 'bare-aionrs',
      assistant_backend: 'aionrs',
    });
    expect(payload.agents[0]).toMatchObject({
      role: 'leader',
      assistant_id: 'bare-aionrs',
      assistant_name: 'Aion 命令行',
    });
    // Runtime backend / conversation type are derived server-side from the
    // assistant, so the create payload no longer carries legacy agent fields.
    expect(payload.agents[0]).not.toHaveProperty('assistant_backend');
    expect(payload.agents[0]).not.toHaveProperty('conversation_type');
    expect(payload.agents[0]).not.toHaveProperty('custom_agent_id');
    expect(payload.agents[0]).not.toHaveProperty('agent_name');
    expect(payload.agents[0]).not.toHaveProperty('agent_type');
    expect(payload).not.toHaveProperty('assistants');
  });

  it('selectedMembers_allows_duplicate_assistant_instances', async () => {
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Team name'), {
      target: { value: 'Duplicate Team' },
    });
    fireEvent.click(screen.getByTestId('team-create-agent-option-bare-aionrs'));
    fireEvent.click(screen.getByTestId('team-create-agent-option-bare-aionrs'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));

    await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(1));

    const payload = createTeamInvokeMock.mock.calls[0][0];
    expect(payload.agents).toHaveLength(2);
    expect(payload.agents.map((agent: { assistant_id?: string }) => agent.assistant_id)).toEqual([
      'bare-aionrs',
      'bare-aionrs',
    ]);
    expect(payload.agents.filter((agent: { role: string }) => agent.role === 'leader')).toHaveLength(1);
  });

  it('first_selected_member_becomes_leader', async () => {
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Team name'), {
      target: { value: 'Manual Team' },
    });
    fireEvent.click(screen.getByTestId('team-create-agent-option-bare-aionrs'));
    fireEvent.click(screen.getByTestId('team-create-agent-option-remote-runner'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));

    await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(1));

    const payload = createTeamInvokeMock.mock.calls[0][0];
    expect(payload.agents.map((agent: { role: string }) => agent.role)).toEqual(['leader', 'teammate']);
  });

  it('switching_leader_serializes_exactly_one_leader', async () => {
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Team name'), {
      target: { value: 'Switch Leader Team' },
    });
    fireEvent.click(screen.getByTestId('team-create-agent-option-bare-aionrs'));
    fireEvent.click(screen.getByTestId('team-create-agent-option-remote-runner'));
    fireEvent.click(screen.getByRole('button', { name: 'Set as Leader' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));

    await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(1));

    const payload = createTeamInvokeMock.mock.calls[0][0];
    expect(payload.agents.map((agent: { role: string }) => agent.role)).toEqual(['teammate', 'leader']);
    expect(payload.agents.filter((agent: { role: string }) => agent.role === 'leader')).toHaveLength(1);
  });

  it('leader_flag_controls_show_and_switch_a_single_active_leader', () => {
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByTestId('team-create-agent-option-bare-aionrs'));
    fireEvent.click(screen.getByTestId('team-create-agent-option-remote-runner'));
    fireEvent.click(screen.getByTestId('team-create-agent-option-remote-runner'));

    const rows = screen.getAllByTestId(/team-create-member-draft-/);
    expect(rows).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Current Leader' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Set as Leader' })).toHaveLength(2);
    expect(within(rows[0]).getByRole('button', { name: 'Current Leader' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(rows[1]).getByRole('button', { name: 'Set as Leader' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(within(rows[2]).getByRole('button', { name: 'Set as Leader' }));

    expect(screen.getAllByRole('button', { name: 'Current Leader' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Set as Leader' })).toHaveLength(2);
    expect(within(rows[0]).getByRole('button', { name: 'Set as Leader' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(rows[2]).getByRole('button', { name: 'Current Leader' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('removing_leader_promotes_first_remaining_member', async () => {
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Team name'), {
      target: { value: 'Promote Leader Team' },
    });
    fireEvent.click(screen.getByTestId('team-create-agent-option-bare-aionrs'));
    fireEvent.click(screen.getByTestId('team-create-agent-option-remote-runner'));
    fireEvent.click(screen.getAllByTestId(/team-create-member-remove-/)[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));

    await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(1));

    const payload = createTeamInvokeMock.mock.calls[0][0];
    expect(payload.agents).toEqual([
      expect.objectContaining({
        role: 'leader',
        assistant_id: 'remote-runner',
      }),
    ]);
  });

  it('model_resolution_failure_blocks_create_and_names_assistant', async () => {
    resolveDefaultTeamAgentModelMock.mockImplementation(({ assistant_id }: { assistant_id: string }) => {
      if (assistant_id === 'remote-runner') {
        return Promise.reject(new Error('model unavailable'));
      }
      return Promise.resolve('model-ok');
    });
    render(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Team name'), {
      target: { value: 'Model Failure Team' },
    });
    fireEvent.click(screen.getByTestId('team-create-agent-option-bare-aionrs'));
    fireEvent.click(screen.getByTestId('team-create-agent-option-remote-runner'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));

    await waitFor(() => expect(messageErrorMock).toHaveBeenCalled());

    expect(createTeamInvokeMock).not.toHaveBeenCalled();
    expect(String(messageErrorMock.mock.calls[0][0])).toContain('Remote Runner');
  });
});

describe('TeamCreateModal · mobile (narrow screen)', () => {
  beforeEach(() => {
    createTeamInvokeMock.mockReset();
    createTeamInvokeMock.mockResolvedValue({ id: 'team-1', assistants: [], agents: [] });
    deleteAssistantInvokeMock.mockReset();
    deleteAssistantInvokeMock.mockResolvedValue(true);
    resolveDefaultTeamAgentModelMock.mockReset();
    resolveDefaultTeamAgentModelMock.mockResolvedValue(undefined);
    messageErrorMock.mockReset();
  });

  it('renders the single-column mobile layout instead of the desktop two-column one', () => {
    renderMobile(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);

    // Narrow layout root is present; the desktop two-column root is not rendered.
    expect(screen.getByTestId('team-create-layout-mobile')).toBeInTheDocument();
    expect(screen.queryByTestId('team-create-layout')).not.toBeInTheDocument();

    // Header/footer copy stays aligned with desktop (same i18n keys).
    expect(screen.getByRole('heading', { name: 'New Team' })).toBeInTheDocument();
    expect(screen.getByText('Selected members 0')).toBeInTheDocument();
    expect(screen.getByTestId('team-create-name-input')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Create' })).toBeDisabled();

    // The add-member trigger is present; the assistant dropdown is closed until opened.
    expect(screen.getByTestId('team-create-add-member-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('team-create-agent-search')).not.toBeInTheDocument();
  });

  it('shows template stages and team fields on mobile without the custom member picker', async () => {
    renderMobile(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('team.workflow.label'));
    fireEvent.click(await screen.findByText('team.workflow.review'));
    expect(screen.getByTestId('team-workflow-stages')).toHaveTextContent('team.workflow.roles.review');
    expect(screen.getByTestId('team-create-name-input')).toBeInTheDocument();
    expect(screen.queryByTestId('team-create-add-member-btn')).not.toBeInTheDocument();
  });

  it('opens the assistant dropdown, adds a member, and closes on select', async () => {
    renderMobile(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByTestId('team-create-add-member-btn'));

    // Dropdown reveals the reused picker (same search box + options as desktop).
    await waitFor(() => expect(screen.getByTestId('team-create-agent-search')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('team-create-agent-option-bare-aionrs'));

    // Select-and-close: the dropdown collapses so the user sees the result below.
    await waitFor(() => expect(screen.queryByTestId('team-create-agent-search')).not.toBeInTheDocument());

    // The member now shows in the list and create becomes actionable — logic shared with desktop.
    expect(screen.getByText('Selected members 1')).toBeInTheDocument();
    expect(screen.getByTestId('team-create-member-list-box')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('team-create-name-input'), { target: { value: 'Mobile Team' } });
    expect(screen.getByRole('button', { name: 'Confirm Create' })).toBeEnabled();
  });

  it('creates a team from the mobile flow with the first member as leader', async () => {
    renderMobile(<TeamCreateModal visible onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByTestId('team-create-add-member-btn'));
    await waitFor(() => expect(screen.getByTestId('team-create-agent-search')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('team-create-agent-option-bare-aionrs'));
    fireEvent.change(screen.getByTestId('team-create-name-input'), { target: { value: 'Mobile Team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Create' }));

    await waitFor(() => expect(createTeamInvokeMock).toHaveBeenCalledTimes(1));
    const payload = createTeamInvokeMock.mock.calls[0][0];
    expect(payload.name).toBe('Mobile Team');
    expect(payload.agents[0]).toMatchObject({ role: 'leader', assistant_id: 'bare-aionrs' });
  });
});

function assistants(): Assistant[] {
  return [
    assistant({
      id: 'bare-aionrs',
      name: 'Aion CLI',
      name_i18n: { 'zh-CN': 'Aion 命令行' },
      source: 'generated',
      agent_id: 'agent-aionrs',
      agent: { type: 'aionrs', source: 'internal' },
      team_selectable: true,
    }),
    assistant({
      id: 'blocked-reviewer',
      name: 'Reviewer',
      source: 'user',
      agent_id: 'agent-claude',
      agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' },
      team_selectable: false,
      team_block_reason: 'Agent internal error (code -32603)',
      deletable: true,
    }),
    assistant({
      id: 'remote-runner',
      name: 'Remote Runner',
      source: 'generated',
      agent_id: 'agent-remote',
      agent: { type: 'remote', source: 'custom' },
      team_selectable: true,
    }),
  ];
}

function assistant(overrides: Partial<Assistant> & Pick<Assistant, 'id' | 'name' | 'source' | 'agent_id'>): Assistant {
  return {
    id: overrides.id,
    source: overrides.source,
    name: overrides.name,
    name_i18n: {},
    description_i18n: {},
    enabled: true,
    sort_order: 0,
    agent_id: overrides.agent_id,
    enabled_skills: [],
    custom_skill_names: [],
    disabled_builtin_skills: [],
    context_i18n: {},
    prompts: [],
    prompts_i18n: {},
    models: [],
    avatar: undefined,
    agent_status: 'online',
    team_selectable: true,
    team_block_reason: undefined,
    deletable: false,
    ...overrides,
  };
}
