/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { type ChatFileRef, chatFileRefPath } from '@/common/types/chatFile';
import type { IMcpServer, TProviderWithModel } from '@/common/config/storage';
import { toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';
import { emitter } from '@/renderer/utils/emitter';
import { updateWorkspaceTime } from '@/renderer/utils/workspace/workspaceHistory';
import { Message } from '@arco-design/web-react';
import { useCallback, useRef } from 'react';
import { type TFunction } from 'i18next';
import type { NavigateFunction } from 'react-router-dom';
import { mutate as swrMutate } from 'swr';
import { getConversationCreateErrorMessage } from '@/renderer/pages/conversation/utils/conversationCreateError';
import { prepareCodebaseMemorySession } from '@/common/adapter/codebaseMemory/session';
import { CODEBASE_MEMORY_SKILL_NAME } from '@/common/types/codebaseMemory/constants';
import { getSelectedWorkspace } from '@/renderer/components/workspace/workspaceSelection';
import { workspaceConversationExtra } from '@/renderer/utils/workspace/managedWorkspace';

export type GuidSendDeps = {
  // Input state
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  files: ChatFileRef[];
  setFiles: React.Dispatch<React.SetStateAction<ChatFileRef[]>>;
  dir: string;
  setDir: React.Dispatch<React.SetStateAction<string>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  loading: boolean;

  // Assistant state
  selectedAssistantId: string | null;
  selectedAssistantBackend: string;
  selectedMode: string;
  selectedAcpModel: string | null;
  selectedThoughtLevelValue?: string;
  current_model: TProviderWithModel | undefined;

  guidDisabledBuiltinSkills: string[] | undefined;
  guidEnabledSkills: string[] | undefined;
  assistantDefaultSkillIds?: string[];
  assistantDefaultDisabledBuiltinSkillIds?: string[];
  availableMcpServers: IMcpServer[];
  selectedMcpServerIds: string[] | undefined;
  assistantDefaultMcpIds?: string[];
  isGoogleAuth: boolean;

  // Mention state reset
  setMentionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMentionQuery: React.Dispatch<React.SetStateAction<string | null>>;
  setMentionSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMentionActiveIndex: React.Dispatch<React.SetStateAction<number>>;

  // Navigation
  navigate: NavigateFunction;
  t: TFunction;
  localeKey: string;
};

export type GuidSendResult = {
  handleSend: () => Promise<void>;
  sendMessageHandler: () => void;
  isButtonDisabled: boolean;
};

/**
 * Hook that manages the send logic for ACP and Aion CLI conversations.
 */
export const useGuidSend = (deps: GuidSendDeps): GuidSendResult => {
  const {
    input,
    setInput,
    files,
    setFiles,
    dir,
    setDir,
    setLoading,
    loading,
    selectedAssistantId,
    selectedAssistantBackend,
    selectedMode,
    selectedAcpModel,
    selectedThoughtLevelValue,
    current_model,
    guidDisabledBuiltinSkills,
    guidEnabledSkills,
    assistantDefaultSkillIds,
    assistantDefaultDisabledBuiltinSkillIds,
    availableMcpServers,
    selectedMcpServerIds,
    assistantDefaultMcpIds,
    setMentionOpen,
    setMentionQuery,
    setMentionSelectorOpen,
    setMentionActiveIndex,
    navigate,
    t,
    localeKey,
  } = deps;
  const sendingRef = useRef(false);

  const handleSend = useCallback(async () => {
    if (!selectedAssistantId) {
      return;
    }

    const selectedWorkspace = selectedAssistantBackend === 'aionrs' ? getSelectedWorkspace() : null;
    const managedExtra = selectedWorkspace ? workspaceConversationExtra(selectedWorkspace) : undefined;
    const isCustomWorkspace = managedExtra ? managedExtra.custom_workspace : !!dir;
    const finalWorkspace = managedExtra ? managedExtra.workspace : dir || '';

    const assistantConversationId = selectedAssistantId;
    const assistantBackend = selectedAssistantBackend;
    const enabled_skills_to_send = guidEnabledSkills ?? assistantDefaultSkillIds;
    const excludeBuiltinSkills = guidDisabledBuiltinSkills ?? assistantDefaultDisabledBuiltinSkillIds;
    const selectedAllMcpServerIds = selectedMcpServerIds ?? [];
    const selectedMcpServerIdSet = new Set(selectedAllMcpServerIds);
    const selectedUserMcpServerIds = availableMcpServers
      .filter((server) => selectedMcpServerIdSet.has(server.id) && server.builtin !== true)
      .map((server) => server.id);
    const selectedAllSessionMcpServers = availableMcpServers
      .filter((server) => selectedMcpServerIdSet.has(server.id))
      .map((server) => toSessionMcpServer(server));
    const selectedSessionMcpServers = availableMcpServers
      .filter((server) => selectedMcpServerIdSet.has(server.id) && server.builtin === true)
      .map((server) => toSessionMcpServer(server));
    const defaultSelectedMcpServerIds = assistantDefaultMcpIds;
    const defaultSelectedUserMcpServerIds = availableMcpServers
      .filter((server) => (defaultSelectedMcpServerIds ?? []).includes(server.id) && server.builtin !== true)
      .map((server) => server.id);
    const assistantOverrideMcpIds =
      selectedMcpServerIds !== undefined ? selectedAllMcpServerIds : defaultSelectedMcpServerIds;
    let selectedUserMcpServerIdsToSend =
      selectedMcpServerIds !== undefined ? selectedUserMcpServerIds : defaultSelectedUserMcpServerIds;
    /**
     * aionui-todo 默认附加:后端把「空数组」视为显式零个 MCP,所以 enabled
     * 状态不足以让 todo 工具进入会话。用户没动过 MCP 选择器时把 aionui-todo
     * 的 id 补进发送列表;用户动过(哪怕全不勾)则完全尊重其选择。
     *
     * Auto-attach aionui-todo: the backend treats an empty selection array as
     * an explicit zero, so the enabled flag alone never gets the todo tools
     * into a conversation. When the user has not touched the MCP picker, append
     * the aionui-todo id to the outgoing list; once the user has made any
     * explicit selection (including none), respect it verbatim.
     */
    if (selectedMcpServerIds === undefined) {
      const todoServer = availableMcpServers.find((server) => server.name === 'aionui-todo' && server.enabled);
      if (todoServer && !selectedUserMcpServerIdsToSend.includes(todoServer.id)) {
        selectedUserMcpServerIdsToSend = [...selectedUserMcpServerIdsToSend, todoServer.id];
      }
    }
    const selectedSessionMcpServersToSend =
      selectedMcpServerIds !== undefined
        ? selectedAllSessionMcpServers
        : availableMcpServers
            .filter((server) => (defaultSelectedMcpServerIds ?? []).includes(server.id))
            .map((server) => toSessionMcpServer(server));

    // `current_model` is the aionrs provider selection and means nothing to a
    // CLI agent, which owns its own model list. Used as a blanket fallback it
    // leaked into the FIRST turn of every CLI conversation: before the agent's
    // catalog has been probed the two preceding options are empty, so a brand
    // new Antigravity conversation started with e.g. `gemini-3.1-pro-preview`
    // — a provider model agy has never heard of — and the turn failed with
    // USER_LLM_PROVIDER_MODEL_NOT_FOUND. Once the catalog lands the second
    // option wins, which is why it only ever reproduced on first use.
    //
    // Omitting it lets the agent start on its own default, which is what a user
    // who has not picked a model means. The cron dialog already gates the same
    // value this way (`resolvedBackend !== 'aionrs' → undefined`).
    //
    // The cached `current_model_id` is NOT a fallback for the same reason, and it
    // used to defeat the very intent described above. It is whatever the LAST
    // session of this agent wrote back, so an unpicked conversation inherited a
    // stranger's choice: for claude that was usually its `default` row, which
    // PINS the account default and overrides the user's own ANTHROPIC_MODEL — so
    // the app ran a different model than `claude` in a terminal did, and the
    // picker contradicted itself (the row promised one model, the session used
    // another). Omit it: no pick means no override, and the agent resolves the
    // model from the user's own config.
    const assistantOverrideModel =
      selectedAcpModel || (assistantBackend === 'aionrs' ? current_model?.use_model : undefined) || undefined;
    const codebaseMemory = await prepareCodebaseMemorySession(
      {
        repoPath: typeof window !== 'undefined' && window.electronAPI ? finalWorkspace : '',
        catalog: availableMcpServers,
        selectedIds: selectedMcpServerIds,
        skillSelection: guidEnabledSkills,
        excludedSkills: excludeBuiltinSkills,
        servers:
          assistantBackend !== 'aionrs' && selectedMcpServerIds !== undefined
            ? selectedSessionMcpServers
            : selectedSessionMcpServersToSend,
      },
      {
        resolve: (repoPath) => ipcBridge.codebaseMemory.session.invoke({ repoPath }),
        ensureSkill: async (skillPath) => {
          const skills = await ipcBridge.fs.listAvailableSkills.invoke();
          if (skills.some((skill) => skill.name === CODEBASE_MEMORY_SKILL_NAME)) return CODEBASE_MEMORY_SKILL_NAME;
          const imported = await ipcBridge.fs.importSkill.invoke({ skill_path: skillPath });
          return imported.skill_name;
        },
      }
    );
    const assistantOverrides = {
      model: assistantOverrideModel,
      permission: selectedMode || undefined,
      thought_level: selectedThoughtLevelValue || undefined,
      skill_ids: enabled_skills_to_send,
      disabled_builtin_skill_ids: excludeBuiltinSkills,
      mcp_ids: assistantOverrideMcpIds,
    };

    if (assistantBackend === 'aionrs') {
      if (!current_model) {
        Message.warning(t('conversation.noModelConfigured'));
        return;
      }
      try {
        const conversation = await ipcBridge.conversation.create.invoke({
          name: input,
          model: current_model,
          assistant: {
            id: assistantConversationId,
            locale: localeKey,
            conversation_overrides: assistantOverrides,
          },
          extra: {
            default_files: files.map(chatFileRefPath),
            workspace: finalWorkspace,
            workspace_project_id: managedExtra?.workspace_project_id,
            custom_workspace: isCustomWorkspace,
            selected_mcp_server_ids: selectedUserMcpServerIdsToSend,
            selected_session_mcp_servers: codebaseMemory.servers,
            preset_enabled_skills: codebaseMemory.skills.length ? codebaseMemory.skills : undefined,
          },
        });

        if (!conversation || !conversation.id) {
          Message.error(t('conversation.createFailed'));
          return;
        }

        if (isCustomWorkspace) {
          updateWorkspaceTime(finalWorkspace);
        }

        if (assistantConversationId) {
          await Promise.all([
            swrMutate(`guid.assistant.detail.${assistantConversationId}.${localeKey}`),
            swrMutate('assistants.list'),
          ]);
        }

        emitter.emit('chat.history.refresh');

        // Empty input = "start chat": create the conversation but do not stash an
        // initial message, so the window opens idle on the empty state instead of
        // auto-sending a blank first turn.
        if (input.trim()) {
          const initialMessage = {
            input,
            files: files.length > 0 ? files : undefined,
          };
          sessionStorage.setItem(`aionrs_initial_message_${conversation.id}`, JSON.stringify(initialMessage));
        }

        await navigate(`/conversation/${conversation.id}`);
      } catch (error: unknown) {
        console.error('Failed to create Aion CLI conversation:', error);
        throw error;
      }
      return;
    }

    try {
      const conversation = await ipcBridge.conversation.create.invoke({
        name: input,
        assistant: {
          id: assistantConversationId,
          locale: localeKey,
          conversation_overrides: assistantOverrides,
        },
        extra: {
          workspace: finalWorkspace,
          custom_workspace: isCustomWorkspace,
          default_files: files.map(chatFileRefPath),
          selected_mcp_server_ids: selectedUserMcpServerIdsToSend,
          selected_session_mcp_servers: codebaseMemory.servers,
          preset_enabled_skills: codebaseMemory.skills.length ? codebaseMemory.skills : undefined,
        },
      });
      if (!conversation || !conversation.id) {
        console.error('Failed to create ACP conversation - conversation object is null or missing id');
        return;
      }

      if (isCustomWorkspace) {
        updateWorkspaceTime(finalWorkspace);
      }

      if (assistantConversationId) {
        await Promise.all([
          swrMutate(`guid.assistant.detail.${assistantConversationId}.${localeKey}`),
          swrMutate('assistants.list'),
        ]);
      }

      emitter.emit('chat.history.refresh');

      // Empty input = "start chat": create the conversation but do not stash an
      // initial message, so the window opens idle on the empty state instead of
      // auto-sending a blank first turn.
      if (input.trim()) {
        const initialMessage = {
          input,
          files: files.length > 0 ? files : undefined,
        };
        sessionStorage.setItem(`acp_initial_message_${conversation.id}`, JSON.stringify(initialMessage));
      }

      await navigate(`/conversation/${conversation.id}`);
    } catch (error: unknown) {
      console.error('Failed to create ACP conversation:', error);
      throw error;
    }
  }, [
    input,
    files,
    dir,
    selectedAssistantId,
    selectedAssistantBackend,
    selectedMode,
    selectedAcpModel,
    selectedThoughtLevelValue,
    current_model,
    guidDisabledBuiltinSkills,
    guidEnabledSkills,
    assistantDefaultSkillIds,
    assistantDefaultDisabledBuiltinSkillIds,
    availableMcpServers,
    selectedMcpServerIds,
    assistantDefaultMcpIds,
    navigate,
    t,
    localeKey,
  ]);

  const sendMessageHandler = useCallback(() => {
    if (loading || sendingRef.current) return;
    sendingRef.current = true;
    setLoading(true);
    handleSend()
      .then(() => {
        setInput('');
        setMentionOpen(false);
        setMentionQuery(null);
        setMentionSelectorOpen(false);
        setMentionActiveIndex(0);
        setFiles([]);
        setDir('');
      })
      .catch((error) => {
        console.error('Failed to send message:', error);
        Message.error(getConversationCreateErrorMessage(error, t));
      })
      .finally(() => {
        sendingRef.current = false;
        setLoading(false);
      });
  }, [
    loading,
    handleSend,
    setLoading,
    setInput,
    setMentionOpen,
    setMentionQuery,
    setMentionSelectorOpen,
    setMentionActiveIndex,
    setFiles,
    setDir,
    t,
  ]);

  // Calculate button disabled state
  // Calculate button disabled state. Empty input is allowed once an assistant is
  // picked — that path creates an empty conversation ("start chat") rather than
  // sending a message, so the gate only blocks while loading or with no assistant.
  const isButtonDisabled = loading || !selectedAssistantId;

  return {
    handleSend,
    sendMessageHandler,
    isButtonDisabled,
  };
};
