/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Changes panel — the Source Control component hosted in the project panel's
 * `changes` tab (see `formal/runtime/source-control.md` §前端).
 *
 * Lifecycle, and why it is the way it is: the subscription is **project-scoped,
 * not tab-scoped**. This component may be unmounted whenever the user switches to
 * the Files tab, so it must NOT unsubscribe on unmount — doing so would drop the
 * backend watch and the warm status on every tab click, making a switch back cost
 * a full recompute. Ownership of the subscription therefore sits with the store,
 * keyed by project id: mounting calls `openScmProject` (a no-op when the project
 * is already open) and nothing here ever closes it. Release happens on project
 * switch (the store's own guard) or reconnect.
 *
 * Refresh: besides backend pushes, the panel pulls on window focus. An external
 * editor writing a working-tree file — and editing `.gitignore` itself — produces
 * no `.git` event, so the backend watch cannot observe it; only this signal can
 * (source-control.md §三信号 ③).
 *
 * Layout: the body is a stack of collapsible/resizable sections (VS Code SCM
 * sidebar). Repositories and Changes are the two sections today; a future graph
 * section drops in as a third with no framework change (see `ScmSectionStack`).
 */

import { changelistChanges, Changelists, useChangelists } from '../Workbench/Storage/Changelists';
import { Message } from '@arco-design/web-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type {
  CommitMessageFields,
  GitBranch,
  GitWorkflowState,
  GitWorkflowSession,
  GitWorkflowPrepareRequest,
} from '@/common/types/sourceControl/gitWorkflowTypes';
import {
  defaultCommitChecks,
  type CommitCheckOptions,
  type StaticScanConfig,
  type StaticScanDiagnostic,
} from '@/common/types/sourceControl/staticScanTypes';
import { CommitWorkflowModal } from '../CommitWorkflowModal';
import {
  filterScmResources,
  fileKey,
  resourceKey,
  type ScmRepository,
  type ScmResource,
  type ScmStatus,
} from '../scmModel';
import { openScmProject, refreshAllRepos, setSelectedRepo, useScm } from '../scmStore';
import { initScmRuntime } from '../scmTransport';
import { migrateLegacyScmRepository, openScmUi, setScmSelectedRepo, useScmUi, type ScmViewMode } from '../scmUiStore';
import { useScmActions } from '../useScmActions';
import {
  clearUnavailableSelections,
  getSelectedResources,
  resolveRepositoryPath,
  toggleResourceSelection,
} from '../scmSelectionStore';
import { ScmSectionStack } from './ScmSectionStack';
import { ScmDiffPreviewBridge } from './ScmDiffPreviewBridge';
import { ActionReportSummary, ActionReportExtras, PanelNotice } from './ScmNotices';

const emptyMessageFields = (): CommitMessageFields => ({
  reason: '',
  scope: '',
  solution: '',
  impact: '',
  tests: '',
});

export type ScmPanelProps = {
  changelists?: boolean;
  /** Owning project id — scopes the store's repositories + statuses. */
  projectId: string;
  /** Absolute paths keyed by project-explorer id, used by the local Git bridge. */
  repoPaths?: Record<string, string>;
  conversationId?: string | null;
  defaultViewMode?: ScmViewMode;
};

export const ScmPanel: React.FC<ScmPanelProps> = ({
  projectId,
  repoPaths = {},
  conversationId,
  defaultViewMode,
  changelists = false,
}) => {
  const { t } = useTranslation();
  const view = useScm();
  const ui = useScmUi();
  const actions = useScmActions();
  const [commitSelections, setCommitSelections] = useState<Record<string, ReadonlySet<string>>>({});
  const [workflowVisible, setWorkflowVisible] = useState(false);
  const [workflowState, setWorkflowState] = useState<GitWorkflowState>('idle');
  const workflowStateRef = useRef(workflowState);
  workflowStateRef.current = workflowState;
  const [workflowMessage, setWorkflowMessage] = useState<string>();
  const [workflowSessionId, setWorkflowSessionId] = useState<string>();
  const [workflowDiagnostics, setWorkflowDiagnostics] = useState<StaticScanDiagnostic[]>([]);
  const [workflowOutput, setWorkflowOutput] = useState('');
  const [commitMode, setCommitMode] = useState<GitWorkflowPrepareRequest['mode']>();
  const [amendLoading, setAmendLoading] = useState(false);
  const amendRequest = useRef(0);
  useEffect(
    () => () => {
      ++amendRequest.current;
    },
    []
  );
  const [draftReady, setDraftReady] = useState(false);
  const [checkSettings, setCheckSettings] = useState<{ repoPath: string; checks: CommitCheckOptions }>();
  const [checkConfigError, setCheckConfigError] = useState<string>();
  const activeRequest = useRef<string | undefined>(undefined);
  const workflowBusy = useRef(false);
  const ownAgentTurns = useRef(new Set<string>());
  const autoScanPending = useRef(false);
  const [autoScanRevision, setAutoScanRevision] = useState(0);
  const startWorkflowRef = useRef<() => void>(() => {});
  const workflowTarget = useRef<{ repo: ScmRepository; resources: ScmResource[] } | undefined>(undefined);
  startWorkflowRef.current = () => {};
  const [messageFields, setMessageFields] = useState<CommitMessageFields>(emptyMessageFields);
  const editedMessageFields = useRef<{ context: string; fields: Partial<CommitMessageFields> }>({
    context: '',
    fields: {},
  });
  const [branches, setBranches] = useState<Record<string, GitBranch[]>>({});
  const [branchBusy, setBranchBusy] = useState(false);
  const [softwareDirectory, setSoftwareDirectory] = useState<{ repoPath: string; exists: boolean } | null>(null);
  useEffect(() => {
    if (autoScanRevision > 0) startWorkflowRef.current();
  }, [autoScanRevision]);
  const applyWorkflowSession = (session: GitWorkflowSession): void => {
    session.agentTurnIds?.forEach((id) => ownAgentTurns.current.add(id));
    setWorkflowSessionId(session.id);
    setWorkflowState(session.state);
    if (session.state === 'draft_ready' || session.messageFields) setDraftReady(true);
    setWorkflowDiagnostics(session.diagnostics);
    if (session.messageFields) setMessageFields(session.messageFields);
    setWorkflowMessage(
      session.reasonCode ? t(`conversation.explorer.scm.commit.${session.reasonCode}`) : session.reason
    );
    setWorkflowOutput(
      [
        ...(session.scanResults ?? []).map((result) =>
          [result.tool, result.stdout, result.stderr].filter(Boolean).join('\n')
        ),
        ...(session.compileResult?.commands ?? []),
        session.compileResult?.stdout,
        session.compileResult?.stderr,
        session.reason,
      ]
        .filter(Boolean)
        .join('\n')
    );
  };

  useEffect(
    () =>
      ipcBridge.sourceControl?.workflowProgress?.on((event) => {
        if (event.requestId === activeRequest.current) applyWorkflowSession(event.session);
      }),
    [t]
  );

  useEffect(
    () =>
      ipcBridge.conversation?.turnCompleted?.on((event) => {
        if (
          event.session_id !== conversationId ||
          event.status !== 'finished' ||
          event.state !== 'ai_waiting_input' ||
          workflowBusy.current ||
          ownAgentTurns.current.has(event.turn_id)
        )
          return;
        // The store refresh includes files created by the completed turn.
        if (autoScanPending.current) return;
        autoScanPending.current = true;
        void refreshAllRepos()
          .then(() => setAutoScanRevision((revision) => revision + 1))
          .finally(() => {
            autoScanPending.current = false;
          });
      }),
    [conversationId]
  );

  // Wire the WS runtime (idempotent) and declare the project. Deliberately no
  // cleanup: unmount here means "tab switched", not "project closed". The UI store
  // is opened alongside so collapse/height/view-mode restore for this project.
  useEffect(() => {
    initScmRuntime();
    void openScmProject(projectId);
    openScmUi(projectId, defaultViewMode);
  }, [projectId, defaultViewMode]);

  useEffect(() => {
    if (view.projectId !== projectId || view.loadState !== 'ready') return;
    migrateLegacyScmRepository(
      projectId,
      view.repositories.map((repository) => repository.repo_id)
    );
  }, [projectId, view.loadState, view.projectId, view.repositories]);

  // The repo whose changes the body shows. A stale or absent `selectedRepoId`
  // (default on open, or after the selected repo was removed) resolves to the first
  // repo — so the body never renders nothing while a repo exists.
  const selectedRepo = useMemo(
    () =>
      view.repositories.find(
        (r) => r.repo_id === (view.selectedRepoId ?? (ui.projectId === projectId ? ui.selectedRepoId : null))
      ) ?? view.repositories[0],
    [view.repositories, view.selectedRepoId, ui.projectId, ui.selectedRepoId, projectId]
  );

  const selectedRepoStatus = selectedRepo ? view.statuses[selectedRepo.repo_id] : undefined;
  const selectedRepoPath = selectedRepo ? resolveRepositoryPath(selectedRepo, repoPaths) : undefined;
  const checks = checkSettings?.repoPath === selectedRepoPath ? checkSettings?.checks : undefined;

  useEffect(() => {
    if (!workflowVisible || !selectedRepoPath) return;
    if (workflowBusy.current && checkSettings?.repoPath === selectedRepoPath) return;
    let cancelled = false;
    setCheckSettings(undefined);
    setCheckConfigError(undefined);
    void ipcBridge.staticScan.getProjectConfig
      .invoke({ repoPath: selectedRepoPath })
      .then((config) => {
        if (cancelled) return;
        setCheckSettings({
          repoPath: selectedRepoPath,
          checks: config.commitChecks ?? defaultCommitChecks(config),
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setCheckConfigError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [workflowVisible, selectedRepoPath]);

  const updateChecks = (next: CommitCheckOptions): void => {
    if (!selectedRepoPath || workflowBusy.current) return;
    setCheckSettings({ repoPath: selectedRepoPath, checks: next });
    activeRequest.current = undefined;
    setWorkflowSessionId(undefined);
    setWorkflowState(draftReady ? 'draft_ready' : 'idle');
    setWorkflowMessage(undefined);
    setWorkflowDiagnostics([]);
    setWorkflowOutput('');
  };

  useEffect(() => {
    if (ui.monitorScope !== 'software') {
      setSoftwareDirectory(null);
      return;
    }
    if (!selectedRepoPath || !ipcBridge.fs?.getFileMetadata) {
      setSoftwareDirectory(null);
      return;
    }
    let cancelled = false;
    const softwarePath = `${selectedRepoPath.replace(/[\\/]+$/, '')}/software`;
    void ipcBridge.fs.getFileMetadata
      .invoke({ path: softwarePath })
      .then((metadata) => {
        if (!cancelled) setSoftwareDirectory({ repoPath: selectedRepoPath, exists: metadata.isDirectory === true });
      })
      .catch(() => {
        if (!cancelled) setSoftwareDirectory({ repoPath: selectedRepoPath, exists: false });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRepoPath, ui.monitorScope]);

  const softwareDirectoryExists =
    !selectedRepoPath || !ipcBridge.fs?.getFileMetadata
      ? false
      : softwareDirectory?.repoPath === selectedRepoPath
        ? softwareDirectory.exists
        : null;
  const effectiveMonitorScope =
    ui.monitorScope === 'software' && softwareDirectoryExists !== false ? 'software' : 'project';
  const lists = useChangelists(
    changelists && selectedRepo?.provider_id === 'git'
      ? { projectId, peId: selectedRepo.root.pe_id, relativePath: selectedRepo.root.relative_path }
      : undefined,
    selectedRepoStatus && changelistChanges(selectedRepoStatus.resources)
  );
  const selectedStatus = useMemo<ScmStatus | undefined>(() => {
    if (!selectedRepoStatus) return undefined;
    return {
      ...selectedRepoStatus,
      resources: filterScmResources(selectedRepoStatus.resources, effectiveMonitorScope),
    };
  }, [selectedRepoStatus, effectiveMonitorScope]);
  // The list filter only hides rows: checked files stay checked, and a reload of the lists never clears them.
  const listedStatus = useMemo<ScmStatus | undefined>(
    () =>
      selectedStatus && changelists
        ? {
            ...selectedStatus,
            resources: selectedStatus.resources.filter((resource) => lists.includes(fileKey(resource))),
          }
        : selectedStatus,
    [selectedStatus, changelists, lists.filter, lists.data]
  );
  const selectedResources = selectedRepo
    ? getSelectedResources(selectedStatus?.resources ?? [], commitSelections[selectedRepo.repo_id] ?? new Set())
    : [];
  const workflowOwnerContext = JSON.stringify([
    projectId,
    selectedRepo?.repo_id,
    selectedRepoPath,
    conversationId,
    selectedRepo?.head?.name,
  ]);
  const previousOwnerContext = useRef(workflowOwnerContext);
  const draftContext = JSON.stringify([
    workflowOwnerContext,
    [...new Set(selectedResources.map((resource) => resource.repo_relative_path))].toSorted(),
  ]);

  useEffect(() => {
    const ownerChanged = previousOwnerContext.current !== workflowOwnerContext;
    previousOwnerContext.current = workflowOwnerContext;
    editedMessageFields.current = { context: draftContext, fields: {} };
    // A commit removes its files from status before pushing finishes. Keep the
    // committed workflow available for retry even when its selection disappears.
    if (!ownerChanged && ['commit', 'push', 'completed'].includes(workflowStateRef.current)) return;
    ++amendRequest.current;
    setAmendLoading(false);
    setCommitMode(undefined);
    activeRequest.current = undefined;
    workflowTarget.current = undefined;
    setMessageFields(emptyMessageFields());
    setDraftReady(false);
    setWorkflowSessionId(undefined);
    setWorkflowMessage(undefined);
    setWorkflowDiagnostics([]);
    setWorkflowOutput('');
    if (!workflowBusy.current) setWorkflowState('idle');
  }, [draftContext, workflowOwnerContext]);

  const updateMessageFields = (fields: CommitMessageFields): void => {
    if (editedMessageFields.current.context !== draftContext) {
      editedMessageFields.current = { context: draftContext, fields: {} };
    }
    for (const key of Object.keys(fields) as (keyof CommitMessageFields)[]) {
      if (fields[key] !== messageFields[key]) editedMessageFields.current.fields[key] = fields[key];
    }
    setMessageFields(fields);
  };

  useEffect(() => {
    if (!selectedRepo) return;
    const resources = selectedStatus?.resources ?? [];
    setCommitSelections((previous) => {
      const current = previous[selectedRepo.repo_id];
      if (!current) return previous;
      const next = clearUnavailableSelections(resources, current);
      if (next.size === current.size && [...next].every((key) => current.has(key))) return previous;
      return { ...previous, [selectedRepo.repo_id]: next };
    });
  }, [selectedRepo, selectedStatus]);

  useEffect(() => {
    if (!selectedRepo || !selectedRepoPath || !ipcBridge.sourceControl?.branches) return;
    let cancelled = false;
    void ipcBridge.sourceControl.branches
      .invoke({ repoPath: selectedRepoPath })
      .then((result) => {
        if (!cancelled) setBranches((previous) => ({ ...previous, [selectedRepo.repo_id]: result.branches }));
      })
      .catch(() => {
        if (!cancelled) setBranches((previous) => ({ ...previous, [selectedRepo.repo_id]: [] }));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRepo, selectedRepoPath]);

  // Focus refresh — the only signal that catches an external editor's write and a
  // `.gitignore` edit.
  useEffect(() => {
    const onFocus = (): void => {
      void refreshAllRepos();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // Diff selection is scoped to the shown repo: only its rows are on screen, and a
  // repo switch clears `selectedResource` (see `setSelectedRepo`), so a resolved row
  // always belongs to `selectedRepo`. A whole-frame replace that drops the row
  // resolves to null and closes the diff.
  const selected = useMemo(() => {
    if (!selectedRepo || !view.selectedResource) return null;
    const resource = selectedStatus?.resources.find((r) => resourceKey(r) === view.selectedResource);
    return resource ? { repo: selectedRepo, resource } : null;
  }, [selectedRepo, selectedStatus, view.selectedResource]);

  if (view.loadState === 'loading' && view.repositories.length === 0) {
    return <PanelNotice text={t('conversation.explorer.scm.loading')} />;
  }
  if (view.loadState === 'error') {
    return (
      <PanelNotice
        text={t('conversation.explorer.scm.loadFailed')}
        details={
          view.error ? [{ label: t('conversation.explorer.scm.diagnostics.backendReason'), values: [view.error] }] : []
        }
      />
    );
  }
  // No pe root of this project is a repository → say so, do not fabricate a repo.
  // The checked folders and the next step turn that dead end into a reportable state.
  // A folder whose repository failed to open is not "no repository": show the backend's reason instead.
  if (view.repositories.length === 0 || !selectedRepo) {
    const checked = [...new Set(Object.values(repoPaths).filter(Boolean))];
    const failures = view.discoveryFailures;
    return (
      <PanelNotice
        text={t(failures.length ? 'conversation.explorer.scm.openFailed' : 'conversation.explorer.scm.notARepository')}
        details={[
          ...(checked.length
            ? [{ label: t('conversation.explorer.scm.diagnostics.checkedFolders'), values: checked }]
            : []),
          ...(failures.length
            ? [
                {
                  label: t('conversation.explorer.scm.diagnostics.backendReason'),
                  values: failures.map((failure) => `${failure.path}: ${failure.message}`),
                },
              ]
            : []),
        ]}
        hint={t(
          failures.length
            ? 'conversation.explorer.scm.diagnostics.openFailedHint'
            : 'conversation.explorer.scm.diagnostics.notARepositoryHint'
        )}
      />
    );
  }

  const multiRepo = view.repositories.length > 1;

  const toggleCommitSelection = (resource: ScmResource): void => {
    if (!selectedRepo) return;
    setCommitSelections((previous) => ({
      ...previous,
      [selectedRepo.repo_id]: toggleResourceSelection(previous[selectedRepo.repo_id] ?? new Set(), resource),
    }));
  };

  const openCommitWorkflow = (): void => {
    if (selectedResources.length === 0) return;
    if (workflowBusy.current) {
      setWorkflowVisible(true);
      return;
    }
    workflowTarget.current = { repo: selectedRepo, resources: [...selectedResources] };
    ++amendRequest.current;
    setCommitMode(undefined);
    setAmendLoading(false);
    setWorkflowState('idle');
    setWorkflowMessage(undefined);
    setWorkflowSessionId(undefined);
    setDraftReady(false);
    setWorkflowDiagnostics([]);
    setWorkflowOutput('');
    editedMessageFields.current = { context: draftContext, fields: {} };
    setMessageFields(emptyMessageFields());
    setWorkflowVisible(true);
  };

  const changeAmend = (enabled: boolean): void => {
    if (workflowBusy.current) return;
    const request = ++amendRequest.current;
    setCommitMode(undefined);
    setWorkflowSessionId(undefined);
    setWorkflowState(draftReady ? 'draft_ready' : 'idle');
    setWorkflowMessage(undefined);
    setAmendLoading(enabled);
    if (!enabled) return;
    void ipcBridge.gitWorkbench.operate
      .invoke({
        scope: { projectId, peId: selectedRepo.root.pe_id, relativePath: selectedRepo.root.relative_path },
        request: { kind: 'inspect' },
      })
      .then((result) => {
        if (request !== amendRequest.current) return;
        const head = result.data?.head;
        if (
          result.state !== 'complete' ||
          !head ||
          !result.data?.branch ||
          result.data.operation ||
          result.data.branch !== selectedRepo.head?.name ||
          !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)
        ) {
          throw new Error(t('conversation.explorer.scm.commit.amendUnavailable'));
        }
        setCommitMode({ kind: 'amend', expectedHead: head });
      })
      .catch((error: unknown) => {
        if (request === amendRequest.current) {
          setWorkflowState('blocked');
          setWorkflowMessage(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (request === amendRequest.current) setAmendLoading(false);
      });
  };

  const generateCommitDraft = (): void => {
    if (workflowBusy.current || amendLoading || selectedResources.length === 0) return;
    if (workflowVisible && workflowTarget.current && workflowTarget.current.repo.repo_id !== selectedRepo.repo_id) {
      setWorkflowState('blocked');
      setWorkflowMessage(t('conversation.explorer.scm.commit.snapshotChanged'));
      return;
    }
    if (!selectedRepoPath || selectedResources.length === 0) {
      setWorkflowState('blocked');
      setWorkflowMessage(t('conversation.explorer.scm.commit.repoPathUnavailable'));
      return;
    }
    // A new automatic draft must reload disk settings, unlike reopening a running workflow.
    if (!workflowVisible) {
      setCheckSettings(undefined);
      setCommitMode(undefined);
    }
    workflowBusy.current = true;
    const requestId = crypto.randomUUID();
    activeRequest.current = requestId;
    workflowTarget.current = { repo: selectedRepo, resources: [...selectedResources] };
    setWorkflowVisible(true);
    setWorkflowSessionId(undefined);
    setWorkflowDiagnostics([]);
    setWorkflowOutput('');
    setDraftReady(false);
    setWorkflowState('message_draft');
    setWorkflowMessage(t('conversation.explorer.scm.commit.generating'));
    const selectedPaths = [...new Set(selectedResources.map((resource) => resource.repo_relative_path))];
    const draftFields = {
      ...emptyMessageFields(),
      ...(editedMessageFields.current.context === draftContext ? editedMessageFields.current.fields : {}),
    };
    setMessageFields(draftFields);
    void ipcBridge.sourceControl.workflowDraft
      .invoke({
        repoPath: selectedRepoPath,
        branch: selectedRepo.head?.name ?? '',
        selectedPaths,
        messageFields: draftFields,
        conversationId: conversationId ?? undefined,
        requestId,
      })
      .then((session) => {
        if (activeRequest.current === requestId) applyWorkflowSession(session);
      })
      .catch(() => {
        if (activeRequest.current !== requestId) return;
        setDraftReady(false);
        setWorkflowState('failed');
        setWorkflowMessage(t('conversation.explorer.scm.commit.draftFailed'));
      })
      .finally(() => {
        workflowBusy.current = false;
        if (activeRequest.current !== requestId) setWorkflowState('idle');
      });
  };

  const startStaticScanWorkflow = (): void => {
    if (workflowBusy.current || amendLoading || selectedResources.length === 0 || !checks) return;
    if (workflowVisible && workflowTarget.current && workflowTarget.current.repo.repo_id !== selectedRepo.repo_id) {
      setWorkflowState('blocked');
      setWorkflowMessage(t('conversation.explorer.scm.commit.snapshotChanged'));
      return;
    }
    if (!selectedRepoPath || selectedResources.length === 0) {
      setWorkflowState('blocked');
      setWorkflowMessage(t('conversation.explorer.scm.commit.repoPathUnavailable'));
      return;
    }
    workflowBusy.current = true;
    const requestId = crypto.randomUUID();
    activeRequest.current = requestId;
    workflowTarget.current = { repo: selectedRepo, resources: [...selectedResources] };
    setWorkflowVisible(true);
    setWorkflowDiagnostics([]);
    setWorkflowOutput('');
    setWorkflowState('collecting');
    setWorkflowMessage(t('conversation.explorer.scm.commit.readingGit'));
    const selectedPaths = [...new Set(selectedResources.map((resource) => resource.repo_relative_path))];
    void Promise.all([
      ipcBridge.staticScan.saveCommitChecks.invoke({ repoPath: selectedRepoPath, checks }),
      ipcBridge.staticScan.getMachineConfig.invoke(),
    ])
      .then(([projectConfig, machineConfig]) => {
        if (activeRequest.current !== requestId) return;
        if (!projectConfig || !machineConfig) throw new Error('Static scan configuration is unavailable');
        const scannerConfigs: StaticScanConfig[] = [];
        for (const tool of checks.scanners) {
          const config = tool === 'clang-tidy' ? projectConfig.clangTidy : projectConfig.pcLint;
          const executablePath = config?.executablePath ?? machineConfig.tools[tool];
          if (!config || !executablePath?.trim())
            throw new Error(`${tool}: ${t('conversation.explorer.scm.commit.scanConfigRequired')}`);
          scannerConfigs.push({ ...config, tool, executablePath });
        }
        return ipcBridge.sourceControl.workflowPrepare.invoke({
          ...(commitMode ? { mode: commitMode } : {}),
          repoPath: selectedRepoPath,
          branch: selectedRepo.head?.name ?? '',
          selectedPaths,
          scannerConfigs,
          checks,
          messageFields,
          conversationId: conversationId ?? undefined,
          requestId,
        });
      })
      .then((session) => {
        if (activeRequest.current !== requestId || !session) return;
        applyWorkflowSession(session);
        void refreshAllRepos();
      })
      .catch((error: unknown) => {
        if (activeRequest.current !== requestId) return;
        setWorkflowState('failed');
        setWorkflowMessage(t('conversation.explorer.scm.commit.checksFailed'));
        setWorkflowOutput(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        workflowBusy.current = false;
        if (activeRequest.current !== requestId) setWorkflowState('idle');
      });
  };
  startWorkflowRef.current = generateCommitDraft;

  const commitWorkflow = (push = true): void => {
    if (workflowBusy.current || !workflowSessionId || !ipcBridge.sourceControl.workflowCommit) return;
    const requestId = activeRequest.current;
    setWorkflowState('commit');
    workflowBusy.current = true;
    void ipcBridge.sourceControl.workflowCommit
      .invoke({ sessionId: workflowSessionId, messageFields, push })
      .then((session) => {
        if (activeRequest.current !== requestId) return;
        applyWorkflowSession(session);
        void refreshAllRepos();
      })
      .catch(() => {
        if (activeRequest.current !== requestId) return;
        setWorkflowState('failed');
        setWorkflowMessage(t('conversation.explorer.scm.commit.commitFailed'));
      })
      .finally(() => {
        workflowBusy.current = false;
        if (activeRequest.current !== requestId) setWorkflowState('idle');
      });
  };

  const retryWorkflowPush = (): void => {
    if (!workflowSessionId || !ipcBridge.sourceControl.workflowRetryPush) return;
    const requestId = activeRequest.current;
    setWorkflowState('push');
    workflowBusy.current = true;
    void ipcBridge.sourceControl.workflowRetryPush
      .invoke({ sessionId: workflowSessionId })
      .then((session) => {
        if (activeRequest.current !== requestId) return;
        setWorkflowState(session.state);
        setWorkflowMessage(
          session.reasonCode ? t(`conversation.explorer.scm.commit.${session.reasonCode}`) : session.reason
        );
      })
      .catch(() => {
        if (activeRequest.current !== requestId) return;
        setWorkflowState('push');
        setWorkflowMessage(t('conversation.explorer.scm.commit.pushFailed'));
      })
      .finally(() => {
        workflowBusy.current = false;
        if (activeRequest.current !== requestId) setWorkflowState('idle');
      });
  };

  const selectBranch = (branch: string): void => {
    if (!selectedRepoPath || branchBusy || branch === selectedRepo.head?.name) return;
    setBranchBusy(true);
    void ipcBridge.sourceControl.checkout
      .invoke({ repoPath: selectedRepoPath, branch })
      .then((result) => {
        if (result.ok === false) {
          if (result.kind === 'dirty-worktree') Message.warning(t('conversation.explorer.scm.branch.dirtyWorktree'));
          else Message.error(t('conversation.explorer.scm.branch.checkoutFailed'));
          return;
        }
        void refreshAllRepos();
      })
      .catch(() => Message.error(t('conversation.explorer.scm.branch.checkoutFailed')))
      .finally(() => setBranchBusy(false));
  };

  return (
    <div data-scm-panel className='h-full flex flex-col min-h-0'>
      {/* Action-report banner. The bulk/view controls live on the Changes section
          header (VS Code parity — actions sit on the section they act on) and the
          refresh moved to the shared explorer top bar (scoped to the visible tab;
          on Changes it re-discovers repos AND re-pulls status), so this row exists
          only to surface an action report and collapses
          away entirely when there is none, leaving no empty toolbar strip on top.
          The report's secondary parts (a failed-file detail line, a retry button)
          are rare and wide, so they drop to their own full-width row underneath via
          `ActionReportExtras`; the common success case stays a single line. */}
      {actions.report && (
        <div className='flex-shrink-0 flex items-center gap-8px px-8px py-2px min-h-28px'>
          <ActionReportSummary report={actions.report} onDismiss={actions.clearReport} />
        </div>
      )}
      {actions.report && <ActionReportExtras report={actions.report} busy={actions.busy} onRetry={actions.retry} />}
      {changelists && (
        <Changelists
          controller={lists}
          selectedKeys={[...new Set(selectedResources.map(fileKey))]}
          disabled={actions.busy || workflowBusy.current || branchBusy}
        />
      )}
      <ScmSectionStack
        view={view}
        ui={ui}
        selectedRepo={selectedRepo}
        selectedStatus={listedStatus}
        multiRepo={multiRepo}
        onRepoSelect={(repoId) => {
          setScmSelectedRepo(repoId);
          setSelectedRepo(repoId);
        }}
        onAction={actions.run}
        busy={actions.busy || workflowBusy.current}
        failedRowKeys={actions.report?.failedRowKeys ?? []}
        commitSelection={commitSelections[selectedRepo.repo_id] ?? new Set()}
        onCommitSelection={toggleCommitSelection}
        selectedResources={selectedResources}
        onCommitAndPush={openCommitWorkflow}
        branches={branches[selectedRepo.repo_id] ?? []}
        branchBusy={branchBusy}
        onBranchChange={selectBranch}
      />
      <CommitWorkflowModal
        visible={workflowVisible}
        repo={workflowTarget.current?.repo ?? selectedRepo}
        branch={(workflowTarget.current?.repo ?? selectedRepo).head?.name}
        resources={workflowTarget.current?.resources ?? selectedResources}
        state={workflowState}
        statusMessage={workflowMessage}
        messageFields={messageFields}
        diagnostics={workflowDiagnostics}
        output={workflowOutput}
        draftReady={draftReady}
        checks={checks}
        checkConfigError={checkConfigError}
        onChecksChange={updateChecks}
        onCancel={() => setWorkflowVisible(false)}
        onDraft={generateCommitDraft}
        onStart={startStaticScanWorkflow}
        onCommit={commitWorkflow}
        onRetryPush={retryWorkflowPush}
        onMessageFieldsChange={updateMessageFields}
        mode={commitMode}
        amendLoading={amendLoading}
        onAmendChange={ipcBridge.gitWorkbench?.operate && selectedRepo.provider_id === 'git' ? changeAmend : undefined}
      />
      {/* Selecting a change opens its diff in the shared preview panel (a `'diff'`
          tab, reusing the same `openPreview` mechanism the file tree uses) rather
          than a fixed pane docked below this panel. Rendered as a hookless bridge
          so the fetch/open effect only exists while a row is selected and unmounts
          cleanly when it clears. */}
      {selected && (
        <ScmDiffPreviewBridge
          repoId={selected.repo.repo_id}
          staging={selected.repo.capabilities.staging}
          resource={selected.resource}
          scope={
            selected.repo.provider_id === 'git'
              ? { projectId, peId: selected.repo.root.pe_id, relativePath: selected.repo.root.relative_path }
              : undefined
          }
        />
      )}
    </div>
  );
};
