import { ipcBridge } from '@/common';
import { app } from 'electron';
import path from 'node:path';
import { createGitMergeService } from '@process/services/sourceControl/workbench/merge';
import {
  createGitCommandRunner,
  createGitCommandService,
  type GitCommandService,
} from '@process/services/sourceControl/gitCommandService';
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
import { createGitWorkbenchService } from '@process/services/sourceControl/workbench/service';
import { createGitOperationService, type RepositoryRun } from '@process/services/sourceControl/workbench/operations';
import { repositoryCoordinator } from '@process/services/sourceControl/workbench/coordinator';
import { safeOutput } from '@process/services/sourceControl/workbench/operations/engine';
import { createProjectRootResolver } from '@process/services/sourceControl/workbench/workspace';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { ProjectDetailDto } from '@/common/types/project';
import { getGitBridgeRuntime, getGitRuntimeStatus, type GitBridgeRuntime } from './runtime';
import { initGitStorageBridge } from './storage';

/** Register the project-scoped Git workbench independently from the checked-commit workflow. */
export function initGitWorkbenchBridge(runtimePromise: Promise<GitBridgeRuntime> = getGitBridgeRuntime()): void {
  initGitStorageBridge(runtimePromise);
  const servicesPromise = runtimePromise.then((runtime) => {
    const options = {
      resolveRoot: createProjectRootResolver((id) =>
        httpRequest<ProjectDetailDto>('GET', `/api/projects/${encodeURIComponent(id)}`)
      ),
      git: runtime.git,
    };
    const service = createGitWorkbenchService(options);
    const operations = createGitOperationService({
      ...options,
      run: runtime.coordinator.run,
      capabilities: runtime.runtime.capabilities,
      storeDir: path.join(app.getPath('userData'), 'git-history-recovery'),
    });
    const merge = createGitMergeService({
      ...options,
      run: runtime.coordinator.run,
      storeDir: path.join(app.getPath('userData'), 'git-merge-recovery'),
    });
    return { service, operations, merge };
  });
  ipcBridge.gitWorkbench.runtime.provider(() => getGitRuntimeStatus());
  ipcBridge.gitWorkbench.mergeList.provider(async ({ scope }) => (await servicesPromise).merge.list(scope));
  ipcBridge.gitWorkbench.mergeRead.provider(async ({ scope, file }) => (await servicesPromise).merge.read(scope, file));
  ipcBridge.gitWorkbench.mergeSave.provider(async ({ scope, request }) =>
    (await servicesPromise).merge.save(scope, request)
  );
  ipcBridge.gitWorkbench.mergeFinish.provider(async ({ scope, request }) =>
    (await servicesPromise).merge.finish(scope, request)
  );
  ipcBridge.gitWorkbench.operate.provider(async ({ scope, request, operationId }) =>
    (await servicesPromise).operations.operate(scope, request, operationId)
  );
  ipcBridge.gitWorkbench.cancel.provider(async ({ scope, operationId }) =>
    (await servicesPromise).operations.cancel(scope, operationId)
  );
  ipcBridge.gitWorkbench.history.provider(async ({ scope, query }) =>
    (await servicesPromise).service.history(scope, query)
  );
  ipcBridge.gitWorkbench.refs.provider(async ({ scope }) => (await servicesPromise).service.refs(scope));
  ipcBridge.gitWorkbench.details.provider(async ({ scope, hash }) =>
    (await servicesPromise).service.details(scope, hash)
  );
  ipcBridge.gitWorkbench.diff.provider(async ({ scope, hash, file }) =>
    (await servicesPromise).service.diff(scope, hash, file)
  );
  ipcBridge.gitWorkbench.compare.provider(async ({ scope, request }) =>
    (await servicesPromise).service.compare(scope, request)
  );
  ipcBridge.gitWorkbench.fileHistory.provider(async ({ scope, query }) =>
    (await servicesPromise).service.fileHistory(scope, query)
  );
  ipcBridge.gitWorkbench.readRevision.provider(async ({ scope, anchor, file }) =>
    (await servicesPromise).service.readRevision(scope, anchor, file)
  );
  ipcBridge.gitWorkbench.blame.provider(async ({ scope, file }) => (await servicesPromise).service.blame(scope, file));
}

export function initSourceControlBridge(
  suppliedService: GitCommandService | undefined = undefined,
  suppliedWorkflow: CommitWorkflowService | undefined = undefined,
  agent = createWorkflowAgentService(),
  builder = createProjectBuildService(),
  suppliedRun: RepositoryRun | undefined = undefined
): void {
  const runtimePromise = suppliedService ? undefined : getGitBridgeRuntime();
  const servicePromise = suppliedService
    ? Promise.resolve(suppliedService)
    : runtimePromise!.then((runtime) => createGitCommandService(createGitCommandRunner(runtime.runtime.executable)));
  const runPromise = suppliedRun
    ? Promise.resolve(suppliedRun)
    : suppliedService
      ? Promise.resolve(repositoryCoordinator.run)
      : runtimePromise!.then((runtime) => runtime.coordinator.run);
  const workflowPromise = suppliedWorkflow
    ? Promise.resolve(suppliedWorkflow)
    : Promise.all([servicePromise, runPromise]).then(([service, run]) => createCommitWorkflowService(service, { run }));
  ipcBridge.sourceControl.status.provider(async ({ repoPath }) => (await servicePromise).getStatus(repoPath));
  ipcBridge.sourceControl.branches.provider(async ({ repoPath }) => (await servicePromise).getBranches(repoPath));
  const failureMessage = (error: unknown) =>
    safeOutput(error instanceof Error ? error.message : 'Git operation failed');
  ipcBridge.sourceControl.checkout.provider(async ({ repoPath, branch }) => {
    try {
      const [service, run] = await Promise.all([servicePromise, runPromise]);
      return await run(repoPath, () => service.checkoutBranch(repoPath, branch));
    } catch (error) {
      return { ok: false, kind: 'command-failed', stdout: '', stderr: failureMessage(error) };
    }
  });
  ipcBridge.sourceControl.commit.provider(async ({ repoPath, paths, message }) => {
    try {
      const [service, run] = await Promise.all([servicePromise, runPromise]);
      return await run(repoPath, () => service.createCommit(repoPath, paths, message));
    } catch (error) {
      return { ok: false, kind: 'command-failed', stdout: '', stderr: failureMessage(error) };
    }
  });
  ipcBridge.sourceControl.push.provider(async ({ repoPath, branch }) => {
    try {
      const [service, run] = await Promise.all([servicePromise, runPromise]);
      return await run(repoPath, () => service.push(repoPath, branch));
    } catch (error) {
      return { ok: false, retryable: true, stdout: '', stderr: failureMessage(error) };
    }
  });
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
      const run = await runPromise;
      const draft = await run(request.repoPath, () =>
        agent.generateMessage(
          request.conversationId,
          request.repoPath,
          request.selectedPaths,
          request.messageFields,
          '',
          onTurnAccepted
        )
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
    const requiresRepair = !request.checks || (request.checks.autoRepair && request.checks.scanners.length > 0);
    if (requiresRepair && !conversationKey) {
      return blockedSession(request, 'conversationRequired');
    }
    if (activeRepos.has(repoKey) || (conversationKey && activeConversations.has(conversationKey))) {
      return blockedSession(request, 'conversationBusy');
    }
    activeRepos.add(repoKey);
    if (conversationKey) activeConversations.add(conversationKey);
    const agentTurnIds: string[] = [];
    const onTurnAccepted = (turnId: string): void => {
      agentTurnIds.push(turnId);
    };
    try {
      const workflow = await workflowPromise;
      const session = await workflow.prepare({
        ...request,
        messageFields: request.messageFields,
        scan: scanner.scan,
        repair: requiresRepair ? agent.repair(request.conversationId, onTurnAccepted) : undefined,
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
      if (conversationKey) activeConversations.delete(conversationKey);
    }
  });
  ipcBridge.sourceControl.workflowCommit?.provider(async ({ sessionId, messageFields, push = true }) => {
    const workflow = await workflowPromise;
    return push ? workflow.commitAndPush(sessionId, messageFields) : workflow.commit(sessionId, messageFields);
  });
  ipcBridge.sourceControl.workflowRetryPush?.provider(async ({ sessionId }) =>
    (await workflowPromise).retryPush(sessionId)
  );
}
