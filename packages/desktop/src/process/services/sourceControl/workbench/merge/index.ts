import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import type {
  GitMergeDocument,
  GitMergeList,
  GitMergeSaveRequest,
  GitMergeFinishRequest,
  GitMergeOutcome,
} from '@/common/types/sourceControl/mergeTypes';
import { createGitExecutor, type GitExecutor } from '../executor';
import { createWorkbenchRootResolver, type GitWorkbenchOptions } from '../service';
import { repositoryCoordinator } from '../coordinator';
import type { RepositoryRun } from '../operations';
import { conflictedFiles, inspectOperation, OperationBlocked, safeOutput } from '../operations/engine';
import { createMergeRecoveryStore } from './storage';
import { mergePathSchema, saveSchema, finishSchema } from './validation';
import { decode, fileVersion, repositoryState, replaceWorking, stageFor, workingBytes } from './repository';
import { stageReviewed } from './staging';

/** Project-scoped conflict reads and snapshot-checked saves; every write shares the repository coordinator. */
export function createGitMergeService(
  options: GitWorkbenchOptions & { storeDir: string; git?: GitExecutor; run?: RepositoryRun }
) {
  const git = options.git ?? createGitExecutor(options.gitPath);
  const rootFor = createWorkbenchRootResolver(options, git);
  const run = options.run ?? repositoryCoordinator.run;
  const recovery = createMergeRecoveryStore(options.storeDir);
  const readCurrent = async (root: string, file: string) => {
    mergePathSchema.parse(file);
    const state = await repositoryState(root, git);
    const bytes = await workingBytes(root, file);
    const [base, ours, theirs] = await Promise.all([1, 2, 3].map((stage) => stageFor(root, git, state, file, stage)));
    if (base.view.deleted && ours.view.deleted && theirs.view.deleted)
      throw new OperationBlocked('File no longer has unmerged index stages');
    const decoded = decode(bytes);
    const version = fileVersion(state, file, bytes);
    if (
      (await repositoryState(root, git)).identity !== state.identity ||
      fileVersion(state, file, await workingBytes(root, file)) !== version
    )
      throw new OperationBlocked('Repository changed while reading merge document; refresh');
    const stored = await recovery.read(root, file);
    const document: GitMergeDocument = {
      file,
      version,
      head: state.head,
      branch: state.branch,
      operation: state.operation,
      stages: { base: base.view, ours: ours.view, theirs: theirs.view },
      result: decoded.text,
      binary: decoded.binary || base.view.binary || ours.view.binary || theirs.view.binary,
      crlf: /\r\n/.test(decoded.text ?? ours.view.text ?? theirs.view.text ?? ''),
      ...(stored?.version === version && stored.result === decoded.text
        ? { progress: stored.progress }
        : stored
          ? { recoveryStale: true }
          : {}),
      ...(typeof stored?.result === 'string' && stored.result !== decoded.text
        ? { recoveryResult: stored.result }
        : {}),
    };
    return { document, state, base, ours, theirs, bytes };
  };
  const check = async (root: string, file: string, version: string) => {
    const current = await readCurrent(root, file);
    if (current.document.version !== version)
      throw new OperationBlocked('Merge snapshot changed; reopen before saving');
    return current;
  };
  return {
    async list(scope: GitWorkbenchScope): Promise<GitMergeList> {
      const root = await rootFor(scope);
      // Inspection may finish a pending history publication; read stages only after that recovery.
      const operation = await inspectOperation(root, git);
      return { files: await conflictedFiles(root, git), operation };
    },
    async read(scope: GitWorkbenchScope, file: string): Promise<GitMergeDocument> {
      const root = await rootFor(scope);
      return (await readCurrent(root, file)).document;
    },
    async save(scope: GitWorkbenchScope, request: GitMergeSaveRequest): Promise<GitMergeDocument> {
      const req = saveSchema.parse(request) as GitMergeSaveRequest;
      const root = await rootFor(scope);
      return run(root, async () => {
        const current = await check(root, req.file, req.version);
        if (current.document.binary)
          throw new OperationBlocked('Binary or unsupported text encoding requires accepting an exact side');
        await recovery.write(root, req.file, { version: req.version, result: req.result, progress: req.progress });
        await check(root, req.file, req.version);
        await replaceWorking(
          root,
          req.file,
          Buffer.from(req.result, 'utf8'),
          current.ours.view.mode ?? current.theirs.view.mode
        );
        const saved = await readCurrent(root, req.file);
        if (saved.state.identity !== current.state.identity || saved.document.result !== req.result)
          throw new OperationBlocked('Repository or working file changed during save; recovery retained');
        const document = saved.document;
        await recovery.write(root, req.file, { version: document.version, result: req.result, progress: req.progress });
        return { ...document, progress: req.progress, recoveryStale: false };
      });
    },
    async finish(scope: GitWorkbenchScope, request: GitMergeFinishRequest): Promise<GitMergeOutcome> {
      try {
        const req = finishSchema.parse(request);
        const root = await rootFor(scope);
        return await run(root, async () => {
          const current = await check(root, req.file, req.version);
          if (req.resolution === 'result' && (req.result === undefined || current.document.binary))
            throw new OperationBlocked('A valid UTF-8 text result is required');
          if (
            req.resolution === 'result' &&
            !req.reviewedManual &&
            /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?: |\r?$)/m.test(req.result!)
          )
            throw new OperationBlocked(
              'Unresolved conflict markers remain; review the manual result before confirming'
            );
          const selected =
            req.resolution === 'ours' ? current.ours : req.resolution === 'theirs' ? current.theirs : undefined;
          const bytes = selected
            ? selected.bytes
            : req.resolution === 'delete'
              ? null
              : Buffer.from(req.result!, 'utf8');
          const previous = await recovery.read(root, req.file);
          await recovery.write(root, req.file, {
            version: req.version,
            result: decode(bytes).text,
            progress: previous?.progress,
            resolution: req.resolution,
          });
          await check(root, req.file, req.version);
          await replaceWorking(
            root,
            req.file,
            bytes,
            selected?.view.mode ?? current.ours.view.mode ?? current.theirs.view.mode
          );
          await stageReviewed(
            root,
            req.file,
            bytes,
            selected?.view.mode ?? current.ours.view.mode ?? current.theirs.view.mode ?? '100644',
            selected?.view.oid ?? null,
            current.state,
            git
          );
          if ((await conflictedFiles(root, git)).includes(req.file))
            throw new Error('Git did not resolve the selected file');
          await recovery.remove(root, req.file);
          return { state: 'complete' as const, output: '' };
        });
      } catch (error) {
        return {
          state: error instanceof OperationBlocked ? 'blocked' : 'error',
          output: safeOutput(error instanceof Error ? error.message : 'Unable to resolve conflict'),
        };
      }
    },
  };
}
