import type {
  StaticScanConfig,
  StaticScanDiagnostic,
  StaticScanResult,
} from '@/common/types/sourceControl/staticScanTypes';
import type {
  CommitMessageFields,
  GitCommitResult,
  GitCommitSnapshot,
  GitPushResult,
  GitWorkflowReasonCode,
  GitWorkflowState,
} from '@/common/types/sourceControl/gitWorkflowTypes';

import { formatCommitMessage, isSameCommitSnapshot, validateCommitMessage } from './gitWorkflowModel';

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
}) => Promise<{ ok: boolean; stdout?: string; stderr?: string }>;

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
  repoPath: string;
  branch: string;
  selectedPaths: string[];
  scannerConfigs: StaticScanConfig[];
  generateMessage: () => Promise<CommitMessageFields>;
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

    if (session.selectedPaths.length === 0) {
      update('blocked');
      session.reason = 'No files selected';
      return session;
    }
    if (input.scannerConfigs.length === 0) {
      update('blocked');
      session.reason = 'No static scanner configured';
      return session;
    }

    update('collecting');
    update('message_draft');
    try {
      session.messageFields = await input.generateMessage();
      session.message = formatCommitMessage(session.messageFields);
    } catch (error) {
      update('failed');
      session.reason = error instanceof Error ? error.message : String(error);
      return session;
    }

    let diagnostics: StaticScanDiagnostic[] = [];
    let scannedSnapshot: GitCommitSnapshot | undefined;
    for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
      update(attempt === 0 ? 'scan' : 'rescan');
      try {
        scannedSnapshot = await git.getCommitSnapshot(session.repoPath, session.selectedPaths);
        if (scannedSnapshot.branch !== session.branch) {
          session.reasonCode = 'snapshotChanged';
          update('blocked');
          return session;
        }
        const results = await Promise.all(
          input.scannerConfigs.map((config) =>
            input.scan({ repoPath: session.repoPath, selectedPaths: session.selectedPaths, config })
          )
        );
        diagnostics = diagnosticsFrom(results);
        session.diagnostics = diagnostics;
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
        update('failed');
        session.reason = error instanceof Error ? error.message : String(error);
        return session;
      }
      session.diagnostics = diagnostics;
      if (diagnostics.length === 0) break;
      if (attempt === MAX_REPAIR_ATTEMPTS || !input.repair) {
        update('blocked');
        session.reason = 'Static scan diagnostics remain';
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
          update('blocked');
          session.reason = 'Automatic repair changed an unselected file';
          return session;
        }
      } catch (error) {
        update('failed');
        session.reason = error instanceof Error ? error.message : String(error);
        return session;
      }
    }

    update('compile');
    if (input.compile) {
      try {
        const compile = await input.compile({ repoPath: session.repoPath, selectedPaths: session.selectedPaths });
        if (!compile.ok) {
          update('blocked');
          session.reason = compile.stderr || 'Incremental compile failed';
          return session;
        }
      } catch (error) {
        update('failed');
        session.reason = error instanceof Error ? error.message : String(error);
        return session;
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
