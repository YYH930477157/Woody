import type {
  StaticScanConfig,
  StaticScanDiagnostic,
  StaticScanResult,
  CommitCheckOptions,
} from '@/common/types/sourceControl/staticScanTypes';
import type {
  CommitMessageFields,
  GitCommitResult,
  GitCommitSnapshot,
  GitPushResult,
  GitWorkflowReasonCode,
  GitWorkflowState,
  GitWorkflowCompileResult,
} from '@/common/types/sourceControl/gitWorkflowTypes';

import {
  formatCommitMessage,
  isSameCommitSnapshot,
  validateCommitMessage,
  WorkflowBlockedError,
} from './gitWorkflowModel';

export type CommitWorkflowScan = (request: {
  repoPath: string;
  selectedPaths: string[];
  config: StaticScanConfig;
}) => Promise<StaticScanResult>;

export type CommitWorkflowRepair = (request: {
  repoPath: string;
  selectedPaths: string[];
  diagnostics: StaticScanDiagnostic[];
  attempt: number;
}) => Promise<{ changedPaths: string[] }>;

export type CommitWorkflowCompile = (request: {
  repoPath: string;
  selectedPaths: string[];
}) => Promise<GitWorkflowCompileResult>;

export type CommitWorkflowGit = {
  getCommitSnapshot: (repoPath: string, paths: string[]) => Promise<GitCommitSnapshot>;
  createCommit: (
    repoPath: string,
    paths: string[],
    message: string,
    expectedSnapshot?: GitCommitSnapshot
  ) => Promise<GitCommitResult>;
  push: (repoPath: string, branch: string) => Promise<GitPushResult>;
};

export type CommitWorkflowInput = {
  checks?: CommitCheckOptions;
  repoPath: string;
  branch: string;
  selectedPaths: string[];
  scannerConfigs: StaticScanConfig[];
  messageFields?: CommitMessageFields;
  generateMessage?: (verification?: GitWorkflowCompileResult) => Promise<CommitMessageFields>;
  scan: CommitWorkflowScan;
  repair?: CommitWorkflowRepair;
  compile?: CommitWorkflowCompile;
  onStateChange?: (state: GitWorkflowState, session: CommitWorkflowSession) => void;
};

export type CommitWorkflowSession = {
  id: string;
  state: GitWorkflowState;
  repoPath: string;
  branch: string;
  selectedPaths: string[];
  diagnostics: StaticScanDiagnostic[];
  scanResults?: StaticScanResult[];
  compileResult?: GitWorkflowCompileResult;
  messageFields?: CommitMessageFields;
  message?: string;
  commit?: string;
  push?: GitPushResult;
  reason?: string;
  reasonCode?: GitWorkflowReasonCode;
};

export type CommitWorkflowService = {
  prepare: (input: CommitWorkflowInput) => Promise<CommitWorkflowSession>;
  commitAndPush: (sessionId: string, fields: CommitMessageFields) => Promise<CommitWorkflowSession>;
  retryPush: (sessionId: string) => Promise<CommitWorkflowSession>;
};

const MAX_REPAIR_ATTEMPTS = 2;
let nextSessionId = 1;

const createSession = (input: CommitWorkflowInput): CommitWorkflowSession => ({
  id: `git-workflow-${nextSessionId++}`,
  state: 'idle',
  repoPath: input.repoPath,
  branch: input.branch,
  selectedPaths: [...new Set(input.selectedPaths)],
  diagnostics: [],
});

const diagnosticsFrom = (results: StaticScanResult[]): StaticScanDiagnostic[] =>
  results.flatMap((result) => result.diagnostics);

const hasPathOutsideSelection = (changedPaths: string[], selectedPaths: string[]): boolean => {
  const selected = new Set(selectedPaths);
  return changedPaths.some((path) => !selected.has(path));
};

export const createCommitWorkflowService = (git: CommitWorkflowGit): CommitWorkflowService => {
  const sessions = new Map<
    string,
    { session: CommitWorkflowSession; input: CommitWorkflowInput; snapshot?: GitCommitSnapshot }
  >();

  const prepare = async (input: CommitWorkflowInput): Promise<CommitWorkflowSession> => {
    const session = createSession(input);
    sessions.set(session.id, { session, input });
    const update = (state: GitWorkflowState): void => {
      session.state = state;
      input.onStateChange?.(state, session);
    };
    const fail = (error: unknown): CommitWorkflowSession => {
      session.reason = error instanceof Error ? error.message : String(error);
      if (error instanceof WorkflowBlockedError) session.reasonCode = error.reasonCode;
      update(error instanceof WorkflowBlockedError ? 'blocked' : 'failed');
      return session;
    };

    if (session.selectedPaths.length === 0) {
      update('blocked');
      session.reason = 'No files selected';
      return session;
    }
    const scannerConfigs = input.checks
      ? input.checks.scanners.flatMap((tool) => input.scannerConfigs.filter((config) => config.tool === tool))
      : input.scannerConfigs;
    if (
      input.checks?.scanners.some(
        (tool) => !scannerConfigs.some((config) => config.tool === tool && config.executablePath.trim())
      )
    ) {
      session.reasonCode = 'scanConfigRequired';
      update('blocked');
      return session;
    }

    update('collecting');

    let diagnostics: StaticScanDiagnostic[] = [];
    let scannedSnapshot: GitCommitSnapshot | undefined;
    if (scannerConfigs.length === 0) {
      try {
        scannedSnapshot = await git.getCommitSnapshot(session.repoPath, session.selectedPaths);
        if (scannedSnapshot.branch !== session.branch) {
          session.reasonCode = 'snapshotChanged';
          update('blocked');
          return session;
        }
      } catch (error) {
        return fail(error);
      }
    }
    for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
      if (scannerConfigs.length === 0) break;
      update(attempt === 0 ? 'scan' : 'rescan');
      try {
        scannedSnapshot = await git.getCommitSnapshot(session.repoPath, session.selectedPaths);
        if (scannedSnapshot.branch !== session.branch) {
          session.reasonCode = 'snapshotChanged';
          update('blocked');
          return session;
        }
        const results = await Promise.all(
          scannerConfigs.map((config) =>
            input.scan({
              repoPath: session.repoPath,
              selectedPaths: session.selectedPaths,
              config: { ...config, scope: 'selected' },
            })
          )
        );
        diagnostics = diagnosticsFrom(results);
        session.diagnostics = diagnostics;
        session.scanResults = [...(session.scanResults ?? []), ...results];
        const failed = results.find(
          (result) =>
            result.timedOut || result.executableMissing || (result.exitCode !== 0 && result.diagnostics.length === 0)
        );
        if (failed) {
          session.reasonCode = 'scanFailed';
          session.reason = failed.stderr || failed.stdout;
          update('failed');
          return session;
        }
      } catch (error) {
        return fail(error);
      }
      session.diagnostics = diagnostics;
      if (diagnostics.length === 0) break;
      if (attempt === MAX_REPAIR_ATTEMPTS || !input.repair || input.checks?.autoRepair === false) {
        session.reason = 'Static scan diagnostics remain';
        session.reasonCode = attempt === MAX_REPAIR_ATTEMPTS ? 'repairLimit' : 'diagnosticsRemain';
        update('blocked');
        return session;
      }
      update('repair');
      try {
        const repair = await input.repair({
          repoPath: session.repoPath,
          selectedPaths: session.selectedPaths,
          diagnostics,
          attempt: attempt + 1,
        });
        if (hasPathOutsideSelection(repair.changedPaths, session.selectedPaths)) {
          session.reason = 'Automatic repair changed an unselected file';
          session.reasonCode = 'repairOutsideSelection';
          update('blocked');
          return session;
        }
      } catch (error) {
        return fail(error);
      }
    }

    if (input.checks?.compile && !input.compile) {
      session.reasonCode = 'buildConfigRequired';
      update('blocked');
      return session;
    }
    if (input.compile && input.checks?.compile !== false) {
      update('compile');
      try {
        const compile = await input.compile({ repoPath: session.repoPath, selectedPaths: session.selectedPaths });
        session.compileResult = compile;
        if (!compile.ok) {
          session.reasonCode = compile.reasonCode ?? 'buildFailed';
          session.reason = compile.stderr || 'Incremental compile failed';
          update('blocked');
          return session;
        }
      } catch (error) {
        return fail(error);
      }
    }
    try {
      const builtSnapshot = await git.getCommitSnapshot(session.repoPath, session.selectedPaths);
      if (!scannedSnapshot || !isSameCommitSnapshot(scannedSnapshot, builtSnapshot)) {
        session.reasonCode = 'snapshotChanged';
        update('blocked');
        return session;
      }
    } catch (error) {
      return fail(error);
    }
    if (input.messageFields) {
      session.messageFields = input.messageFields;
      session.message = formatCommitMessage(input.messageFields);
    } else if (input.generateMessage) {
      update('message_draft');
      try {
        session.messageFields = await input.generateMessage(session.compileResult);
        session.message = formatCommitMessage(session.messageFields);
      } catch (error) {
        return fail(error);
      }
    }
    try {
      const currentSnapshot = await git.getCommitSnapshot(session.repoPath, session.selectedPaths);
      if (!scannedSnapshot || !isSameCommitSnapshot(scannedSnapshot, currentSnapshot)) {
        session.reasonCode = 'snapshotChanged';
        update('blocked');
        return session;
      }
      sessions.set(session.id, { session, input, snapshot: scannedSnapshot });
    } catch (error) {
      session.reason = error instanceof Error ? error.message : String(error);
      update('failed');
      return session;
    }
    update('confirmation');
    return session;
  };

  const commitAndPush = async (sessionId: string, fields: CommitMessageFields): Promise<CommitWorkflowSession> => {
    const entry = sessions.get(sessionId);
    if (!entry) throw new Error('Unknown workflow session');
    const { session } = entry;
    if (session.state !== 'confirmation' || !entry.snapshot) {
      session.state = 'blocked';
      session.reason = 'Workflow is not ready for confirmation';
      return session;
    }
    const validation = validateCommitMessage(fields);
    if (validation.ok === false) {
      session.state = 'blocked';
      session.reason = `Missing commit message field: ${validation.field}`;
      return session;
    }
    session.messageFields = fields;
    session.message = formatCommitMessage(fields);
    session.state = 'commit';
    const commit: GitCommitResult = await git.createCommit(
      session.repoPath,
      session.selectedPaths,
      session.message,
      entry.snapshot
    );
    if (commit.ok === false) {
      session.state = commit.kind === 'snapshot-changed' ? 'blocked' : 'failed';
      if (commit.kind === 'snapshot-changed') session.reasonCode = 'snapshotChanged';
      session.reason = commit.stderr || 'Git commit failed';
      return session;
    }
    session.commit = commit.commit;
    session.state = 'push';
    const push = await git.push(session.repoPath, session.branch);
    session.push = push;
    if (!push.ok) {
      session.reason = push.stderr || 'Git push failed';
      return session;
    }
    session.state = 'completed';
    return session;
  };

  const retryPush = async (sessionId: string): Promise<CommitWorkflowSession> => {
    const entry = sessions.get(sessionId);
    if (!entry) throw new Error('Unknown workflow session');
    const { session } = entry;
    if (!session.commit || session.state !== 'push') {
      session.state = 'blocked';
      session.reason = 'No local commit is available to push';
      return session;
    }
    session.push = await git.push(session.repoPath, session.branch);
    if (session.push.ok) session.state = 'completed';
    return session;
  };

  return { prepare, commitAndPush, retryPush };
};
