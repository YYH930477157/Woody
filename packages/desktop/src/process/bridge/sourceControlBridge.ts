import { ipcBridge } from '@/common';
import { createGitCommandService, type GitCommandService } from '@process/services/sourceControl/gitCommandService';

export function initSourceControlBridge(service: GitCommandService = createGitCommandService()): void {
  ipcBridge.sourceControl.status.provider(({ repoPath }) => service.getStatus(repoPath));
  ipcBridge.sourceControl.branches.provider(({ repoPath }) => service.getBranches(repoPath));
  ipcBridge.sourceControl.checkout.provider(({ repoPath, branch }) => service.checkoutBranch(repoPath, branch));
  ipcBridge.sourceControl.commit.provider(({ repoPath, paths, message }) =>
    service.createCommit(repoPath, paths, message)
  );
  ipcBridge.sourceControl.push.provider(({ repoPath, branch }) => service.push(repoPath, branch));
}
