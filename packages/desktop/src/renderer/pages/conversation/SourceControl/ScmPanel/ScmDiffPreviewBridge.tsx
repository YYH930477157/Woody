/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo } from 'react';
import { usePreviewContext } from '../../Preview';
import { projectFileRef } from '@/common/types/chatFile';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import { diffAnchors, resourceName, type ScmResource } from '../scmModel';
import { readPreviewDiff, type PreviewDiffRequest } from '../Workbench/Diff/previewDiff';

/**
 * Bridges a selected change to the shared preview panel: on selection (or when the
 * selected row's staged/working identity changes) it fetches the unified diff and
 * hands it to `openPreview` as a `'diff'` tab, exactly the mechanism the file tree
 * uses for file previews — the diff no longer lives in a pane docked under this
 * panel. Renders nothing itself.
 *
 * A per-effect `cancelled` flag guards the async fetch: rapid row switches must not
 * let a slow earlier response open a stale tab over the newer one. Binary/empty
 * diffs carry metadata so the viewer can show a notice. File identity lets Source
 * read the current working file, while the anchors preserve the comparison. Fetch
 * failures are swallowed here (the row stays selected, no tab opens); surfacing them
 * belongs to the action-report path, not this passive bridge.
 */
export const ScmDiffPreviewBridge: React.FC<{
  repoId: string;
  staging: boolean;
  resource: ScmResource;
  scope?: GitWorkbenchScope;
}> = ({ repoId, staging, resource, scope }) => {
  const { openPreview } = usePreviewContext();
  const name = resourceName(resource);
  const { pe_id: peId, relative_path: relativePath } = resource.file;
  const { from, to } = diffAnchors(resource, staging);
  const request = useMemo<PreviewDiffRequest | undefined>(
    () =>
      scope
        ? {
            kind: 'workbench',
            scope,
            file: resource.repo_relative_path,
            from:
              from === 'committed' ? { kind: 'head' } : from === 'staged' ? { kind: 'index' } : { kind: 'worktree' },
            to: to === 'committed' ? { kind: 'head' } : to === 'staged' ? { kind: 'index' } : { kind: 'worktree' },
          }
        : { repository: repoId, file: { pe_id: peId, relative_path: relativePath }, from, to },
    [
      scope?.projectId,
      scope?.peId,
      scope?.relativePath,
      resource.repo_relative_path,
      repoId,
      peId,
      relativePath,
      from,
      to,
    ]
  );

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await readPreviewDiff(request);
        if (cancelled) return;
        openPreview(result.patch ?? '', 'diff', {
          file_name: name,
          title: name,
          fileRef: projectFileRef(peId, relativePath),
          editable: false,
          scmDiff: {
            request,
            binary: result.binary,
            truncated: result.truncated,
          },
        });
      } catch {
        // Passive bridge: a failed diff fetch leaves the selection intact and opens
        // nothing. Error surfacing is the action-report path's job, not this effect's.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request, name, openPreview]);

  return null;
};
