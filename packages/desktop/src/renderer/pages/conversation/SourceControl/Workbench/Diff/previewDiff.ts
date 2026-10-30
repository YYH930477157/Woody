import { gitWorkbench } from '@/common/adapter/ipcBridge';
import type { GitCommitDiff, GitDiffAnchor, GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import type { ContentRef, ScmFileRef } from '../../scmModel';
import { fetchScmDiff } from '../../scmStore';

export type PreviewDiffRequest =
  | {
      kind: 'workbench';
      scope: GitWorkbenchScope;
      file: string;
      from: GitDiffAnchor;
      to: GitDiffAnchor;
    }
  | {
      kind?: 'webui';
      repository: string;
      file: ScmFileRef;
      from: ContentRef;
      to: ContentRef;
    };

/** Read a desktop comparison through typed project scope; retain the WebUI protocol as-is. */
export async function readPreviewDiff(request: PreviewDiffRequest): Promise<GitCommitDiff> {
  if (request.kind === 'workbench') {
    return gitWorkbench.compare.invoke({
      scope: request.scope,
      request: { file: request.file, from: request.from, to: request.to },
    });
  }
  const result = await fetchScmDiff({
    repository: request.repository,
    file: request.file,
    from: request.from,
    to: request.to,
  });
  return { patch: result.patch ?? '', binary: result.binary, truncated: result.truncated };
}

/** Stable tab identity for either transport. */
export const previewDiffKey = (request: PreviewDiffRequest): string =>
  request.kind === 'workbench'
    ? JSON.stringify([request.scope, request.file, request.from, request.to])
    : JSON.stringify([request.repository, request.file, request.from, request.to]);
