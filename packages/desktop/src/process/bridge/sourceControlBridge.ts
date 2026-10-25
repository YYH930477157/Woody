import { ipcBridge } from '@/common';
import { createGitCommandService, type GitCommandService } from '@process/services/sourceControl/gitCommandService';
import {
  createCommitWorkflowService,
  type CommitWorkflowService,
} from '@process/services/sourceControl/commitWorkflowService';
import { createStaticScanService } from '@process/services/sourceControl/staticScanService';
import type {
  GitWorkflowDraftRequest,
  GitWorkflowPrepareRequest,
  GitWorkflowReasonCode,
  GitWorkflowSession,
} from '@/common/types/sourceControl/gitWorkflowTypes';
import type { StaticScanDiagnostic } from '@/common/types/sourceControl/staticScanTypes';
import { createProjectBuildService } from '@process/services/sourceControl/projectBuildService';
import { createWorkflowAgentService } from '@process/services/sourceControl/workflowAgentService';
import { WorkflowBlockedError } from '@process/services/sourceControl/gitWorkflowModel';

export function initSourceControlBridge(
  service: GitCommandService = createGitCommandService(),
  workflow: CommitWorkflowService = createCommitWorkflowService(service),
  agent = createWorkflowAgentService(),
  builder = createProjectBuildService()
): void {
  ipcBridge.sourceControl.status.provider(({ repoPath }) => service.getStatus(repoPath));
  ipcBridge.sourceControl.branches.provider(({ repoPath }) => service.getBranches(repoPath));
  ipcBridge.sourceControl.checkout.provider(({ repoPath, branch }) => service.checkoutBranch(repoPath, branch));
  ipcBridge.sourceControl.commit.provider(({ repoPath, paths, message }) =>
    service.createCommit(repoPath, paths, message)
  );
  ipcBridge.sourceControl.push.provider(({ repoPath, branch }) => service.push(repoPath, branch));
  const scanner = createStaticScanService();
  const activeRepos = new Set<string>();
  const activeConversations = new Set<string>();
  const blockedSession = (
    request: GitWorkflowDraftRequest | GitWorkflowPrepareRequest,
    reasonCode: GitWorkflowReasonCode,
    reason?: string
  ): GitWorkflowSession => ({
    id: '',
    state: 'blocked' as const,
    repoPath: request.repoPath,
    branch: request.branch,
    selectedPaths: request.selectedPaths,
    diagnostics: [] as StaticScanDiagnostic[],
    reasonCode,
    reason,
  });
  ipcBridge.sourceControl.workflowDraft?.provider(async (request: GitWorkflowDraftRequest) => {
    const repoKey = request.repoPath.replaceAll('\\', '/').replace(/\/+$/, '');
    const conversationKey = request.conversationId ?? '';
    if (!conversationKey || activeRepos.has(repoKey) || activeConversations.has(conversationKey)) {
      return blockedSession(request, !conversationKey ? 'conversationRequired' : 'conversationBusy');
    }
    activeRepos.add(repoKey);
    activeConversations.add(conversationKey);
    const agentTurnIds: string[] = [];
    const onTurnAccepted = (turnId: string): void => {
      agentTurnIds.push(turnId);
    };
    try {
      const draft = await agent.generateMessage(
        request.conversationId,
        request.repoPath,
        request.selectedPaths,
        request.messageFields,
        '',
        onTurnAccepted
      );
      for (const field of ['reason', 'scope', 'solution', 'impact', 'tests'] as const) {
        if (request.messageFields[field].trim()) draft[field] = request.messageFields[field];
      }
      const session: GitWorkflowSession = {
        id: `draft-${Date.now()}`,
        state: 'draft_ready' as const,
        repoPath: request.repoPath,
        branch: request.branch,
        selectedPaths: [...new Set(request.selectedPaths)],
        diagnostics: [],
        messageFields: draft,
        agentTurnIds,
      };
      if (request.requestId) ipcBridge.sourceControl.workflowProgress.emit({ requestId: request.requestId, session });
      return session;
    } catch (error) {
      const reasonCode = error instanceof WorkflowBlockedError ? error.reasonCode : 'agentFailed';
      const session = blockedSession(request, reasonCode, error instanceof Error ? error.message : String(error));
      if (request.requestId) ipcBridge.sourceControl.workflowProgress.emit({ requestId: request.requestId, session });
      return { ...session, agentTurnIds };
    } finally {
      activeRepos.delete(repoKey);
      activeConversations.delete(conversationKey);
    }
  });
  ipcBridge.sourceControl.workflowPrepare?.provider(async (request: GitWorkflowPrepareRequest) => {
    const repoKey = request.repoPath.replaceAll('\\', '/').replace(/\/+$/, '');
    const conversationKey = request.conversationId ?? '';
    if (!conversationKey || activeRepos.has(repoKey) || activeConversations.has(conversationKey)) {
      return {
        id: '',
        state: 'blocked' as const,
        repoPath: request.repoPath,
        branch: request.branch,
        selectedPaths: request.selectedPaths,
        diagnostics: [],
        reasonCode: !conversationKey ? ('conversationRequired' as const) : ('conversationBusy' as const),
      };
    }
    activeRepos.add(repoKey);
    activeConversations.add(conversationKey);
    const agentTurnIds: string[] = [];
    const onTurnAccepted = (turnId: string): void => {
      agentTurnIds.push(turnId);
    };
    try {
      const session = await workflow.prepare({
        ...request,
        messageFields: request.messageFields,
        scan: scanner.scan,
        repair:
          request.checks?.autoRepair === false || request.checks?.scanners.length === 0
            ? undefined
            : agent.repair(request.conversationId, onTurnAccepted),
        compile: request.checks?.compile === false ? undefined : builder.compile,
        onStateChange: (_state, current) => {
          if (request.requestId)
            ipcBridge.sourceControl.workflowProgress.emit({
              requestId: request.requestId,
              session: { ...current, agentTurnIds: [...agentTurnIds] },
            });
        },
      });
      const result = { ...session, agentTurnIds };
      if (request.requestId)
        ipcBridge.sourceControl.workflowProgress.emit({ requestId: request.requestId, session: result });
      return result;
    } finally {
      activeRepos.delete(repoKey);
      activeConversations.delete(conversationKey);
    }
  });
  ipcBridge.sourceControl.workflowCommit?.provider(({ sessionId, messageFields }) =>
    workflow.commitAndPush(sessionId, messageFields)
  );
  ipcBridge.sourceControl.workflowRetryPush?.provider(({ sessionId }) => workflow.retryPush(sessionId));
}
