import { ipcBridge } from '@/common';
import { createGitCommandService, type GitCommandService } from '@process/services/sourceControl/gitCommandService';
import {
  createCommitWorkflowService,
  type CommitWorkflowService,
} from '@process/services/sourceControl/commitWorkflowService';
import { createStaticScanService } from '@process/services/sourceControl/staticScanService';
import type { GitWorkflowPrepareRequest } from '@/common/types/sourceControl/gitWorkflowTypes';
import { createProjectBuildService } from '@process/services/sourceControl/projectBuildService';
import { createWorkflowAgentService } from '@process/services/sourceControl/workflowAgentService';

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
        generateMessage: async (verification) => {
          const draft = await agent.generateMessage(
            request.conversationId,
            request.repoPath,
            request.selectedPaths,
            request.messageFields,
            JSON.stringify(verification ?? {}),
            onTurnAccepted
          );
          // User-authored values take precedence over generated content.
          for (const field of ['reason', 'scope', 'solution', 'impact', 'tests'] as const) {
            if (request.messageFields[field].trim()) draft[field] = request.messageFields[field];
          }
          return draft;
        },
        scan: scanner.scan,
        repair: agent.repair(request.conversationId, onTurnAccepted),
        compile: builder.compile,
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
