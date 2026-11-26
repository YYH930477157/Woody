import React, { useMemo, useRef, useState } from 'react';
import { Button, Input, Message } from '@arco-design/web-react';
import type { RefInputType } from '@arco-design/web-react/es/Input/interface';
import { Plus } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { mutate } from 'swr';
import { ipcBridge } from '@/common';
import type { TTeam } from '@/common/types/team/teamTypes';
import type { ModuleExpert } from '@/common/types/team/moduleExperts';
import type { TeamAssistantInput } from '@/common/adapter/teamMapper';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import AionModal from '@renderer/components/base/AionModal';
import { WorkspaceFolderSelect } from '@renderer/components/workspace';
import { getConversationCreateErrorMessage } from '@renderer/pages/conversation/utils/conversationCreateError';
import { useTeamAssistantOptions } from '../hooks/useTeamAssistantOptions';
import type { TeamAssistantOption } from './assistantSelectUtils';
import { resolveDefaultTeamAgentModel } from './teamCreateModelResolver';
import TeamAssistantPicker from './memberPicker/TeamAssistantPicker';
import TeamAssistantPickerDropdown from './memberPicker/TeamAssistantPickerDropdown';
import TeamMemberDraftList, { type TeamMemberDraft } from './memberPicker/TeamMemberDraftList';
import WorkflowPresets, {
  prepareRoles,
  prepareWorkflow,
  WorkflowPreparationError,
  WORKFLOW_ROLES,
  type WorkflowPresetId,
  type WorkflowRole,
} from '../WorkflowPresets';
import ModuleExperts, {
  buildExpertTeamRoles,
  loadExpertBriefs,
  onboardingIds,
  startOnboarding,
  useModuleExperts,
} from '../WorkflowPresets/ModuleExperts';
import { prepareTeamMemberExtras } from '../WorkflowPresets/memberExtras';
import IsolatedWorkspaceOption, { IsolatedWorkspaceError, useIsolatedWorkspace } from '../IsolatedWorkspace';

/** Reasons the main process reports for a folder that cannot get a separate workspace. */
const ISOLATED_REASONS = new Set(['notRepository', 'detached', 'noCommits']);

// [E2E SYNC] 修改此组件的 DOM 结构（class、标题、关闭按钮等）时，
// 必须同步更新 tests/e2e/cases/teams/team-create.e2e.ts、team-whitelist.e2e.ts、
// team-name-validation.e2e.ts 中的 selector，并立即向上汇报改动情况。
// 注意：迁移到 AionModal variant='standard' 后，关闭按钮为 button[aria-label="Close"]，
// 不再是 .arco-btn-text / .arco-modal-close-icon。
// 窄屏（layout.isMobile，<768px）改为单栏：布局根为 team-create-layout-mobile，
// 助手选择器是锚在 team-create-add-member-btn 上的下拉（选中即关，助手随即出现在下方列表）；
// 桌面双栏为 team-create-layout。
type Props = {
  visible: boolean;
  onClose: () => void;
  onCreated: (team: TTeam) => void;
};

const TeamCreateModal: React.FC<Props> = ({ visible, onClose, onCreated }) => {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const { assistants: allAssistants } = useTeamAssistantOptions(i18n?.language ?? 'en-US');
  const [name, setName] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<TeamMemberDraft[]>([]);
  const [leaderSelectionId, setLeaderSelectionId] = useState<string | undefined>(undefined);
  const [workspace, setWorkspace] = useState('');
  const [loading, setLoading] = useState(false);
  const [workflowPreset, setWorkflowPreset] = useState<WorkflowPresetId>();
  const [workflowBaseId, setWorkflowBaseId] = useState<string>();
  const [preparedWorkflow, setPreparedWorkflow] = useState<TeamAssistantInput[]>();
  // Who learns their module once the expert team exists; kept with the prepared roles for a retry.
  const onboardingRef = useRef<
    { experts: ModuleExpert[]; ids: string[]; knowledge: string; business: boolean } | undefined
  >(undefined);
  const isolated = useIsolatedWorkspace(workspace);
  const experts = useModuleExperts(workspace, workflowPreset === 'experts');
  const expertsMissing = workflowPreset === 'experts' && !preparedWorkflow && !experts.ready;
  const workflowBase = allAssistants.find(
    (assistant) => assistant.id === workflowBaseId && assistant.team_selectable !== false
  );
  // 窄屏专用：助手选择器以下拉列表形式，锚在“添加成员”按钮上按需唤出。
  const [assistantDropdownOpen, setAssistantDropdownOpen] = useState(false);
  const nameInputRef = useRef<RefInputType | null>(null);
  const creatingRef = useRef(false);

  const hasOneLeader = useMemo(
    () => Boolean(leaderSelectionId && selectedMembers.some((member) => member.selectionId === leaderSelectionId)),
    [leaderSelectionId, selectedMembers]
  );

  const discardPreparedWorkflow = (agents: TeamAssistantInput[] | undefined) => {
    if (!agents?.length) return;
    void Promise.allSettled(
      agents.map((agent) =>
        agent.assistant_id ? ipcBridge.assistants.delete.invoke({ id: agent.assistant_id }) : Promise.resolve()
      )
    ).then(() =>
      mutate('assistants.list').catch((error: unknown) => console.warn('Failed to refresh workflow roles', error))
    );
  };

  const resetModalState = () => {
    setName('');
    setSelectedMembers([]);
    setLeaderSelectionId(undefined);
    setWorkspace('');
    setAssistantDropdownOpen(false);
    setWorkflowPreset(undefined);
    setWorkflowBaseId(undefined);
    setPreparedWorkflow(undefined);
    onboardingRef.current = undefined;
    isolated.reset();
    onClose();
  };

  const handleClose = () => {
    discardPreparedWorkflow(preparedWorkflow);
    isolated.discard();
    resetModalState();
  };

  const handleSelectAssistant = (assistant: TeamAssistantOption) => {
    const draft = {
      selectionId: `${assistant.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      assistant,
    };
    setSelectedMembers((members) => [...members, draft]);
    setLeaderSelectionId((current) => current ?? draft.selectionId);
  };

  const handleRemoveDraft = (selectionId: string) => {
    const nextMembers = selectedMembers.filter((member) => member.selectionId !== selectionId);
    setSelectedMembers(nextMembers);
    if (leaderSelectionId === selectionId) {
      setLeaderSelectionId(nextMembers[0]?.selectionId);
    }
  };

  const handleCreate = async () => {
    if (creatingRef.current) return;
    if (!name.trim()) {
      Message.warning(t('team.create.nameRequired', { defaultValue: 'Please enter a team name' }));
      nameInputRef.current?.focus();
      return;
    }
    if (workflowPreset ? !workflowBase && !preparedWorkflow : selectedMembers.length === 0) {
      Message.warning(t('team.create.selectAtLeastOneMember', { defaultValue: 'Select at least one team member' }));
      return;
    }
    if (!workflowPreset && !hasOneLeader) {
      Message.warning(t('team.create.selectOneLeader', { defaultValue: 'Select one Team Leader' }));
      return;
    }
    if (expertsMissing) {
      Message.warning(t('team.experts.noneSelected'));
      return;
    }
    const user_id = user?.id ?? 'system_default_user';
    creatingRef.current = true;
    setLoading(true);
    try {
      // The expert list is written first: it is part of the project, and a team must not
      // start from experts that were not saved. Already prepared roles were built from it.
      let chosenExperts: Awaited<ReturnType<typeof experts.save>> | undefined;
      if (workflowPreset === 'experts' && !preparedWorkflow) {
        try {
          chosenExperts = await experts.save();
        } catch (error) {
          Message.error(
            t('team.experts.saveFailed', { message: error instanceof Error ? error.message : String(error) })
          );
          return;
        }
      }
      // The worktree comes next: it fails fast and costs nothing to retry, unlike role copies.
      const teamWorkspace = isolated.enabled ? (await isolated.prepare(name)).workspace : workspace;
      let agents: TeamAssistantInput[];
      if (workflowPreset) {
        if (preparedWorkflow) {
          agents = preparedWorkflow;
        } else {
          if (!workflowBase) throw new Error(t('team.workflow.baseAssistant'));
          if (workflowPreset === 'experts') {
            if (!chosenExperts || !experts.file) throw new Error(t('team.experts.noneSelected'));
            // A separate workspace is a git worktree without the ignored .woody folder:
            // members keep the knowledge in the chosen folder.
            const knowledge = isolated.enabled ? experts.file.replace(/[\\/][^\\/]+$/, '') : '.woody';
            // Briefs Woody has not written yet, or that no longer match the experts, are written now.
            const briefs = experts.hasCards ? await loadExpertBriefs(workspace, i18n.language) : undefined;
            const onboarding = experts.onboard ? onboardingIds(chosenExperts.experts, briefs) : [];
            // The dispatcher leads the meter business: it writes the overview a project lacks.
            const businessOnboarding = experts.onboard && experts.businessMissing;
            agents = await prepareRoles({
              base: workflowBase,
              teamName: name,
              locale: i18n.language,
              workspace,
              roles: buildExpertTeamRoles({
                ...chosenExperts,
                labels: { dispatcher: t('team.experts.roles.dispatcher'), verifier: t('team.experts.roles.verifier') },
                knowledge,
                briefs,
                onboarding,
                businessOnboarding,
              }),
            });
            onboardingRef.current = {
              experts: chosenExperts.experts,
              ids: onboarding,
              knowledge,
              business: businessOnboarding,
            };
          } else {
            const labels = Object.fromEntries(
              WORKFLOW_ROLES.map((role) => [role, t(`team.workflow.roles.${role}`)])
            ) as Record<WorkflowRole, string>;
            agents = await prepareWorkflow({
              preset: workflowPreset,
              base: workflowBase,
              teamName: name,
              locale: i18n.language,
              workspace,
              labels,
            });
          }
          setPreparedWorkflow(agents);
        }
      } else {
        const resolvedModels = await Promise.all(
          selectedMembers.map(async (member) => {
            try {
              const model = await resolveDefaultTeamAgentModel({
                assistant_id: member.assistant.id,
                assistant_backend: member.assistant.backend,
              });
              return [member.selectionId, model] as const;
            } catch (error) {
              throw new Error(`${member.assistant.name}: ${getConversationCreateErrorMessage(error, t)}`, {
                cause: error,
              });
            }
          })
        );
        const modelBySelectionId = new Map(resolvedModels);
        agents = selectedMembers.map((member) => ({
          role: member.selectionId === leaderSelectionId ? 'leader' : 'teammate',
          assistant_name: member.assistant.name,
          assistant_id: member.assistant.id,
          model: modelBySelectionId.get(member.selectionId),
        }));
      }

      // Members picked by hand get the codebase memory tools a chat in this folder has (template
      // roles carry them already), and the whole team gets one folder for the files it creates.
      // Both live in the chosen folder, which outlasts a separate workspace.
      const memberExtras = await prepareTeamMemberExtras({
        workspace,
        teamName: name,
        names: {
          root: t('conversation.sessionFiles.rootFolder'),
          work: t('conversation.sessionFiles.workFolder'),
          output: t('conversation.sessionFiles.outputFolder'),
          untitled: t('conversation.sessionFiles.untitled'),
        },
        withCodebaseMemory: !workflowPreset,
      });
      const team = await ipcBridge.team.create.invoke({
        user_id,
        name,
        workspace: teamWorkspace,
        workspace_mode: isolated.enabled ? 'isolated' : 'shared',
        agents,
        ...(memberExtras ? { member_extras: memberExtras } : {}),
      });

      // The platform bridge swallows provider errors and returns a sentinel object
      const result = team as unknown as { __bridgeError?: boolean; message?: string };
      if (result.__bridgeError) {
        Message.error(getConversationCreateErrorMessage(result.message ?? t('team.create.error'), t));
        return;
      }

      const learning = workflowPreset === 'experts' ? onboardingRef.current : undefined;
      onCreated(team);
      resetModalState();
      // The team exists whatever happens here: a failed request is reported, not undone.
      if (learning && (learning.ids.length || learning.business))
        void startOnboarding({
          team,
          agents,
          experts: learning.experts,
          ids: learning.ids,
          knowledge: learning.knowledge,
          message: (card) => t('team.experts.onboardMessage', { card }),
          lead: learning.business
            ? {
                name: t('team.experts.roles.dispatcher'),
                message: t('team.experts.leadOnboardMessage', { file: `${learning.knowledge}/business.md` }),
              }
            : undefined,
        }).then((failed) => {
          if (failed.length) Message.warning(t('team.experts.onboardFailed', { names: failed.join(', ') }));
        });
    } catch (error) {
      Message.error(
        error instanceof WorkflowPreparationError
          ? t('team.workflow.prepareFailed', { ids: error.remainingAssistantIds.join(', ') || '—' })
          : error instanceof IsolatedWorkspaceError
            ? t('team.create.isolated.failed', {
                message:
                  error.reason && ISOLATED_REASONS.has(error.reason)
                    ? t(`team.create.isolated.${error.reason}`)
                    : error.message,
              })
            : getConversationCreateErrorMessage(error, t)
      );
    } finally {
      creatingRef.current = false;
      if (workflowPreset) {
        void mutate('assistants.list').catch((error: unknown) =>
          console.warn('Failed to refresh workflow roles', error)
        );
      }
      setLoading(false);
    }
  };
  // 助手选择器：桌面端嵌在左栏，窄屏端复用同一份放进底部面板。空态文案与逻辑完全一致。
  const assistantPicker = (
    <>
      {allAssistants.length === 0 ? (
        <div className='flex min-h-112px items-center justify-center rounded-8px border border-dashed border-border-2 bg-fill-1 py-14px text-13px text-t-tertiary'>
          {t('team.create.noSupportedAgents', { defaultValue: 'No supported assistants available' })}
        </div>
      ) : (
        <TeamAssistantPicker
          assistants={allAssistants}
          onSelect={handleSelectAssistant}
          testIdPrefix='team-create-agent'
          density='modal'
        />
      )}
    </>
  );

  // 团队名 + 工作空间：桌面端与窄屏端共用同一份字段（文案、testId、交互一致）。
  const teamFields = (
    <div className='grid grid-cols-[76px_minmax(0,1fr)] items-center gap-x-14px gap-y-10px'>
      <div className='text-14px font-600 leading-21px text-t-secondary'>
        {t('team.create.nameLabel', { defaultValue: 'Team name' })}
        <span className='ms-4px text-danger-6'>*</span>
      </div>
      <div>
        <Input
          ref={nameInputRef}
          placeholder={t('team.create.namePlaceholder', { defaultValue: 'Team name' })}
          value={name}
          disabled={loading || Boolean(preparedWorkflow)}
          onChange={setName}
          data-testid='team-create-name-input'
          className='!h-38px !rounded-8px !text-13px'
        />
      </div>

      <div className='text-14px font-500 leading-21px text-t-secondary'>
        {t('team.create.workspaceLabel', { defaultValue: 'Workspace' })}
      </div>
      <div>
        <WorkspaceFolderSelect
          value={workspace}
          onChange={setWorkspace}
          placeholder={t('team.create.selectFolder', { defaultValue: 'Select folder' })}
          recentLabel={t('team.create.recentLabel', { defaultValue: 'Recent' })}
          chooseDifferentLabel={t('team.create.chooseDifferentFolder', {
            defaultValue: 'Choose a different folder',
          })}
          triggerTestId='team-create-workspace-trigger'
          menuTestId='team-create-workspace-menu'
        />
      </div>
      <IsolatedWorkspaceOption state={isolated} disabled={loading} />
    </div>
  );

  // 桌面端：左右双栏，通栏竖分隔线（保持原样，宽屏不受窄屏改动影响）。
  const desktopBody = (
    <div
      data-testid='team-create-layout'
      className='grid min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'
      style={{ height: 'min(54vh, 470px)', minHeight: 390 }}
    >
      <section
        className='flex min-h-0 flex-col border-e border-border-3 px-20px pb-18px pt-12px'
        data-testid='team-create-assistant-pane'
      >
        <div className='mb-12px text-15px font-600 leading-22px text-t-secondary'>
          {t('team.create.allAssistantsWithCount', {
            count: allAssistants.length,
            defaultValue: `All assistants (${allAssistants.length})`,
          })}
        </div>
        {assistantPicker}
      </section>

      <section className='flex min-h-0 flex-col px-20px pb-14px pt-12px' data-testid='team-create-details-pane'>
        <TeamMemberDraftList
          members={selectedMembers}
          leaderSelectionId={leaderSelectionId}
          onLeaderChange={setLeaderSelectionId}
          onRemove={handleRemoveDraft}
        />
        <div className='mt-14px shrink-0 border-t border-border-2 pt-14px'>{teamFields}</div>
      </section>
    </div>
  );

  // 窄屏端：单栏——只留“已选成员”与团队字段；助手选择器做成锚在“添加成员”按钮上的下拉列表。
  // 选中即关：下拉收起后，用户直接看到助手出现在下方的已选成员列表里（这就是“加成功了”的反馈）。
  const handleSelectFromDropdown = (assistant: TeamAssistantOption) => {
    handleSelectAssistant(assistant);
    setAssistantDropdownOpen(false);
  };
  const addMemberDropdown = (
    <TeamAssistantPickerDropdown
      assistants={allAssistants}
      onSelect={handleSelectFromDropdown}
      visible={assistantDropdownOpen}
      onVisibleChange={setAssistantDropdownOpen}
      testIdPrefix='team-create-agent'
      panelTestId='team-create-assistant-pane'
      emptyText={t('team.create.noSupportedAgents', { defaultValue: 'No supported assistants available' })}
    >
      <Button
        type='outline'
        size='small'
        icon={<Plus theme='outline' size='14' fill='currentColor' />}
        data-testid='team-create-add-member-btn'
        className='!h-30px !rounded-999px !px-12px !text-13px'
      >
        {t('team.addMember.title', { defaultValue: 'Add member' })}
      </Button>
    </TeamAssistantPickerDropdown>
  );
  const mobileBody = (
    <div data-testid='team-create-layout-mobile' className='flex min-h-0 flex-col gap-16px px-20px py-16px'>
      {/* 窄屏无固定高度的父级：给成员列表框一个固定 max-height（同桌面思路），成员变多时框内滚动，
          团队字段区始终留在下方可见。 */}
      <section className='flex min-h-0 flex-col' data-testid='team-create-details-pane'>
        <TeamMemberDraftList
          members={selectedMembers}
          leaderSelectionId={leaderSelectionId}
          onLeaderChange={setLeaderSelectionId}
          onRemove={handleRemoveDraft}
          headerAction={addMemberDropdown}
          listBoxClassName='!max-h-[38vh]'
        />
      </section>

      <section className='shrink-0'>{teamFields}</section>
    </div>
  );

  return (
    <AionModal
      variant='standard'
      visible={visible}
      onCancel={() => {
        if (!loading) handleClose();
      }}
      className='team-create-modal'
      style={{
        width: isMobile ? 'calc(100vw - 32px)' : 900,
        maxWidth: isMobile ? 'calc(100vw - 32px)' : 'calc(100vw - 72px)',
      }}
      wrapStyle={{ zIndex: 10000 }}
      maskStyle={{ zIndex: 9999 }}
      autoFocus={false}
      unmountOnExit={false}
      // 桌面通栏双栏是团队创建独有的布局：关闭内容区默认内边距，让中间竖分隔线贴边贯穿。
      // 窄屏改为单栏（自带内边距），标题区 / 按钮区 / 居中 / 最大高度均沿用 standard 统一规则。
      contentStyle={{ padding: 0, overflow: 'hidden' }}
      header={{
        title: t('team.create.title', { defaultValue: 'New Team' }),
        subtitle: t('team.create.subtitle', {
          defaultValue:
            'Let multiple AI assistants team up and collaborate. We suggest one team focuses on a single goal — create separate teams for different tasks.',
        }),
        showClose: true,
      }}
      footer={{
        render: () => (
          <div className='flex justify-end gap-10px'>
            <Button
              onClick={handleClose}
              disabled={loading}
              className='!h-38px min-w-84px !rounded-8px !px-18px !text-13px'
            >
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button
              type='primary'
              onClick={handleCreate}
              loading={loading}
              disabled={
                loading ||
                !name.trim() ||
                expertsMissing ||
                (workflowPreset ? !workflowBase && !preparedWorkflow : selectedMembers.length === 0 || !hasOneLeader)
              }
              className='!h-38px min-w-100px !rounded-8px !px-18px !text-13px'
            >
              {t('team.create.confirm', { defaultValue: 'Confirm Create' })}
            </Button>
          </div>
        ),
      }}
    >
      <WorkflowPresets
        preset={workflowPreset}
        baseId={workflowBaseId}
        assistants={allAssistants}
        disabled={loading || Boolean(preparedWorkflow)}
        onPresetChange={setWorkflowPreset}
        onBaseChange={setWorkflowBaseId}
      />
      {workflowPreset ? (
        <div className='flex flex-col gap-14px px-20px py-16px'>
          {teamFields}
          {workflowPreset === 'experts' && (
            <ModuleExperts
              key={workspace}
              workspace={workspace}
              state={experts}
              disabled={loading || Boolean(preparedWorkflow)}
            />
          )}
        </div>
      ) : isMobile ? (
        mobileBody
      ) : (
        desktopBody
      )}
    </AionModal>
  );
};

export default TeamCreateModal;
