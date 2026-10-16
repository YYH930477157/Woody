import { ipcBridge } from '@/common';
import { createGitCommandService, type GitCommandService } from '@process/services/sourceControl/gitCommandService';
import {
  createCommitWorkflowService,
  type CommitWorkflowService,
} from '@process/services/sourceControl/commitWorkflowService';
import { createStaticScanService } from '@process/services/sourceControl/staticScanService';
import type { GitWorkflowPrepareRequest } from '@/common/types/sourceControl/gitWorkflowTypes';

export function initSourceControlBridge(
  service: GitCommandService = createGitCommandService(),
  workflow: CommitWorkflowService = createCommitWorkflowService(service)
): void {
  ipcBridge.sourceControl.status.provider(({ repoPath }) => service.getStatus(repoPath));
  ipcBridge.sourceControl.branches.provider(({ repoPath }) => service.getBranches(repoPath));
  ipcBridge.sourceControl.checkout.provider(({ repoPath, branch }) => service.checkoutBranch(repoPath, branch));
  ipcBridge.sourceControl.commit.provider(({ repoPath, paths, message }) =>
    service.createCommit(repoPath, paths, message)
  );
  ipcBridge.sourceControl.push.provider(({ repoPath, branch }) => service.push(repoPath, branch));
  const scanner = createStaticScanService();
  ipcBridge.sourceControl.workflowPrepare?.provider((request: GitWorkflowPrepareRequest) =>
    workflow.prepare({
      ...request,
      generateMessage: async () => request.messageFields,
      scan: scanner.scan,
    })
  );
  ipcBridge.sourceControl.workflowCommit?.provider(({ sessionId, messageFields }) =>
    workflow.commitAndPush(sessionId, messageFields)
  );
  ipcBridge.sourceControl.workflowRetryPush?.provider(({ sessionId }) => workflow.retryPush(sessionId));
}
