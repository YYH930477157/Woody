/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Tooltip } from '@arco-design/web-react';
import { BranchTwo, FolderCode, FolderCodeOne, RightBranchOne } from '@icon-park/react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { type ScmRepository } from '../scmModel';
import { groupRepositories, type ScmRepoGroup } from '../scmRepoTree';
import { setSelectedRepo } from '../scmStore';

/** Left indent (px) applied to a nested worktree row so it reads as a child of its
 *  primary, matching the tree view's step. */
const REPO_WORKTREE_INDENT = 16;

/**
 * One repository row. Shared by primaries, nested worktree children, and orphan
 * worktrees so selection/branch rendering stays identical across all three — the
 * task's invariant that grouping only changes layering, never per-repo semantics.
 *
 * `leading` is the row's left affordance: a primary with worktrees passes its
 * expand/collapse chevron, a worktree passes its glyph, an ordinary repo passes
 * nothing. Clicking the row always selects `repo.repo_id`; the chevron handles its
 * own toggle and stops propagation so expanding never also re-selects.
 */
const RepoRow: React.FC<{
  repo: ScmRepository;
  isSelected: boolean;
  onSelect: (repoId: string) => void;
  indent?: number;
  leading?: React.ReactNode;
}> = ({ repo, isSelected, onSelect, indent = 0, leading }) => (
  <div
    role='button'
    tabIndex={0}
    data-scm-repo-item={repo.repo_id}
    aria-current={isSelected ? 'true' : undefined}
    onClick={() => onSelect(repo.repo_id)}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(repo.repo_id);
      }
    }}
    className={`flex items-center gap-6px px-8px py-3px rd-4px cursor-pointer hover:bg-2 min-w-0 ${
      isSelected ? 'bg-2' : ''
    }`}
    style={indent ? { paddingInlineStart: 8 + indent } : undefined}
  >
    {leading}
    <span className='flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-13px text-t-primary'>
      {repo.pe_name || repo.label}
    </span>
    {/* Branch info is pinned to the right of the row (`ms-auto`), the branch
        name preceded by a branch glyph. `flex-1` on the repo name above
        claims the slack so the two never touch; both truncate under pressure.
        Rendered only when a head name is known — a detached/unknown head
        shows nothing rather than a lone icon. */}
    {repo.head?.name && (
      <span className='ms-auto flex items-center gap-2px min-w-0 flex-shrink text-t-tertiary text-12px'>
        <BranchTwo theme='outline' size='12' className='flex-shrink-0' />
        <span className='overflow-hidden text-ellipsis whitespace-nowrap'>{repo.head.name}</span>
      </span>
    )}
  </div>
);

/** The worktree glyph shown at the left of a worktree row (nested child or orphan). */
const WorktreeGlyph: React.FC<{ label: string }> = ({ label }) => (
  <Tooltip content={label} mini>
    <span className='flex-shrink-0 flex items-center' aria-label={label}>
      <RightBranchOne theme='outline' size='12' className='text-t-tertiary' />
    </span>
  </Tooltip>
);

/**
 * Repository switcher, shown only for a multi-repo project. Rows come from
 * `groupRepositories`, which folds linked worktrees under the primary they name
 * (VS Code REPOSITORIES parity); a worktree whose primary is out of view is shown
 * flat with a worktree glyph. A primary that has worktrees gets an expand/collapse
 * chevron whose state persists per project. The name uses `||`, not `??`: the
 * backend promises never to emit `Some("")`, but an empty string must still fall
 * back to `label` rather than smear into a blank repo name. Clicking any row changes
 * which repo fills the body — pure front-end, no `scm/*` request (every repo is
 * already subscribed; see `setSelectedRepo`).
 */
export const RepoList: React.FC<{
  repositories: ScmRepository[];
  selectedRepoId: string;
  onSelect: (repoId: string) => void;
  /** Primary repo ids whose worktree children are currently collapsed. */
  collapsedParents: string[];
  onToggleParent: (repoId: string, collapsed: boolean) => void;
}> = ({ repositories, selectedRepoId, onSelect, collapsedParents, onToggleParent }) => {
  const { t } = useTranslation();
  const groups = useMemo(() => groupRepositories(repositories), [repositories]);
  const collapsed = useMemo(() => new Set(collapsedParents), [collapsedParents]);
  const labels = {
    worktree: t('conversation.explorer.scm.worktree'),
    expand: t('conversation.explorer.scm.expandWorktrees'),
    collapse: t('conversation.explorer.scm.collapseWorktrees'),
  };

  return (
    <div
      data-scm-repo-list
      // No own scroll/max-height: the enclosing section body owns scrolling and the
      // height cap, and measures this list's natural height. A second scroll box here
      // would clip that measurement and reintroduce blank space.
      className='flex flex-col gap-1px px-4px py-4px border-b border-[var(--bg-3)]'
    >
      {groups.map((group) => (
        <RepoGroupRows
          key={group.repo.repo_id}
          group={group}
          selectedRepoId={selectedRepoId}
          onSelect={onSelect}
          isCollapsed={collapsed.has(group.repo.repo_id)}
          onToggleParent={onToggleParent}
          labels={labels}
        />
      ))}
    </div>
  );
};

/** Renders one grouped entry: an orphan worktree row, or a primary row followed by
 *  its (optionally collapsed) worktree children. */
const RepoGroupRows: React.FC<{
  group: ScmRepoGroup;
  selectedRepoId: string;
  onSelect: (repoId: string) => void;
  isCollapsed: boolean;
  onToggleParent: (repoId: string, collapsed: boolean) => void;
  labels: { worktree: string; expand: string; collapse: string };
}> = ({ group, selectedRepoId, onSelect, isCollapsed, onToggleParent, labels }) => {
  if (group.kind === 'orphanWorktree') {
    return (
      <RepoRow
        repo={group.repo}
        isSelected={group.repo.repo_id === selectedRepoId}
        onSelect={onSelect}
        leading={<WorktreeGlyph label={labels.worktree} />}
      />
    );
  }

  const hasWorktrees = group.worktrees.length > 0;
  // Collapsed (or non-expandable) shows the closed repo glyph; expanded shows the open
  // one. A repo with worktrees toggles between the two on click.
  const RepoIcon = isCollapsed ? FolderCode : FolderCodeOne;
  return (
    <>
      <RepoRow
        repo={group.repo}
        isSelected={group.repo.repo_id === selectedRepoId}
        onSelect={onSelect}
        leading={
          hasWorktrees ? (
            <button
              type='button'
              data-scm-repo-toggle={group.repo.repo_id}
              aria-expanded={!isCollapsed}
              aria-label={isCollapsed ? labels.expand : labels.collapse}
              onClick={(e) => {
                e.stopPropagation();
                onToggleParent(group.repo.repo_id, !isCollapsed);
              }}
              className='flex-shrink-0 flex items-center justify-center w-14px h-14px text-t-tertiary hover:text-t-primary bg-transparent border-none p-0 cursor-pointer'
            >
              <RepoIcon theme='outline' size='12' />
            </button>
          ) : (
            // A non-expandable repo (no worktrees) still occupies the same 14px leading
            // slot the toggle would, so its name aligns with expandable rows instead of
            // shifting a glyph-width to the left.
            <span
              data-scm-repo-glyph={group.repo.repo_id}
              className='flex-shrink-0 flex items-center justify-center w-14px h-14px text-t-tertiary'
            >
              <FolderCode theme='outline' size='12' />
            </span>
          )
        }
      />
      {hasWorktrees &&
        !isCollapsed &&
        group.worktrees.map((wt) => (
          <RepoRow
            key={wt.repo_id}
            repo={wt}
            isSelected={wt.repo_id === selectedRepoId}
            onSelect={onSelect}
            indent={REPO_WORKTREE_INDENT}
            leading={<WorktreeGlyph label={labels.worktree} />}
          />
        ))}
    </>
  );
};
