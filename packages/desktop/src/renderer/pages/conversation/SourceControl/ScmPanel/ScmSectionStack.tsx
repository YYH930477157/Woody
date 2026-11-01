/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Select, Tooltip } from '@arco-design/web-react';
import { Plus, SendOne, TreeList, Undo, ViewList } from '@icon-park/react';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitBranch } from '@/common/types/sourceControl/gitWorkflowTypes';
import { discardAllTargets, ScmChangesView, stageAllTargets } from '../ScmChangesView';
import { ScmSection, ScmSectionDivider } from '../ScmSection';
import { type ScmActionKind, type ScmRepository, type ScmResource, type ScmStatus } from '../scmModel';
import type { useScm } from '../scmStore';
import {
  clearSectionHeight,
  setRepoWorktreesCollapsed,
  setScmMonitorScope,
  setScmViewMode,
  setSectionCollapsed,
  setSectionHeight,
  type ScmViewMode,
  type ScmMonitorScope,
  type useScmUi,
} from '../scmUiStore';
import { RepoList } from './RepoList';

/** Section ids — the persistence keys and the extensible section registry. */
const SECTION_REPOSITORIES = 'repositories';

const SECTION_CHANGES = 'changes';

/** Height of a section header row, in px (mirror of ScmSection's `h-24px`). Used to
 *  bound section body heights so at least one header row always stays on screen. */
const SECTION_HEADER_PX = 24;

/** Minimum body height a sized (bottom-anchored) section keeps when dragged small. */
const SECTION_MIN_BODY_PX = 40;

/** Default body height for a sized section when nothing is stored: a fraction of the
 *  panel height (the Changes section should open roomy, ~60%). */
const SECTION_DEFAULT_FRACTION = 0.6;

/**
 * The section stack: the collapsible/resizable body of the panel below the header
 * bar. Renders the Repositories section (multi-repo only) and the Changes section,
 * with a drag divider between them. The Changes section always flexes to fill and
 * its header is `flex-shrink-0`, so it can never lose its header no matter how many
 * repos the list holds — the hard layout requirement.
 *
 * Extensible by construction: a future graph section is one more `ScmSection` +
 * divider in this stack; collapse/height persistence is already id-keyed in the UI
 * store, so no mechanism here is hard-wired to exactly two sections.
 */
export const ScmSectionStack: React.FC<{
  view: ReturnType<typeof useScm>;
  ui: ReturnType<typeof useScmUi>;
  selectedRepo: ScmRepository;
  selectedStatus: ScmStatus | undefined;
  multiRepo: boolean;
  onRepoSelect: (repoId: string) => void;
  onAction: (action: ScmActionKind, repoId: string, resources: ScmResource[]) => void;
  busy: boolean;
  failedRowKeys: string[];
  commitSelection: ReadonlySet<string>;
  onCommitSelection: (resource: ScmResource) => void;
  selectedResources: ScmResource[];
  onCommitAndPush: () => void;
  branches: GitBranch[];
  branchBusy: boolean;
  onBranchChange: (branch: string) => void;
}> = ({
  view,
  ui,
  selectedRepo,
  selectedStatus,
  multiRepo,
  onRepoSelect,
  onAction,
  busy,
  failedRowKeys,
  commitSelection,
  onCommitSelection,
  selectedResources,
  onCommitAndPush,
  branches,
  branchBusy,
  onBranchChange,
}) => {
  const { t } = useTranslation();
  const reposCollapsed = ui.collapsed[SECTION_REPOSITORIES] === true;
  const changesCollapsed = ui.collapsed[SECTION_CHANGES] === true;

  // Measure the stack's own pixel height so a sized section can default to a fraction
  // of it and so drags can be clamped to "leave at least the other headers on screen".
  const stackRef = React.useRef<HTMLDivElement>(null);
  const [stackPx, setStackPx] = React.useState<number>(0);
  React.useLayoutEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    setStackPx(el.clientHeight);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setStackPx(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Bottom-anchored stack model. Screen order is fixed (repositories on top, changes
  // below, a future graph further below). The FIRST open section is the "filler": it
  // flexes to take whatever space the sized sections below leave. Every other open
  // section keeps its own persisted body height and anchors from the bottom up. This
  // is what lets the Changes header be dragged all the way to full height (repositories
  // shrinks to just its header) or down to just its own header (repositories fills).
  const repoOpen = multiRepo && !reposCollapsed;
  // With only two sections today, the filler is repositories when it is open, else the
  // changes section fills. Generalizes to "first open section fills" when graph lands.
  const changesIsFiller = !repoOpen;

  // Body height a bottom-anchored (non-filler) section uses. Absent stored value ⇒ a
  // fraction of the panel. Always clamped so the filler above keeps at least its header
  // visible (min body) and so the sized body itself never collapses below a usable min.
  const sizedBodyHeight = (id: string): number => {
    const stored = ui.heights[id];
    const fallback = stackPx > 0 ? Math.round(stackPx * SECTION_DEFAULT_FRACTION) : 240;
    const desired = stored ?? fallback;
    // Reserve room above for the filler's header (and its own header is outside the body).
    const upperReserve = SECTION_HEADER_PX + SECTION_MIN_BODY_PX;
    const maxBody = stackPx > 0 ? Math.max(SECTION_MIN_BODY_PX, stackPx - upperReserve) : desired;
    return Math.max(SECTION_MIN_BODY_PX, Math.min(desired, maxBody));
  };

  // Dragging the divider above the Changes section: up (negative cumulative delta)
  // grows the Changes body, down shrinks it; the filler (repositories) absorbs the
  // inverse. `totalDeltaY` is measured from the drag start, so the base height is
  // captured once when the drag begins — reading `ui.heights` on every move would
  // hit the stale closure captured at pointerdown and drop all but the last step.
  const changesDragBase = React.useRef<number | null>(null);
  const onChangesDividerDrag = (totalDeltaY: number): void => {
    changesDragBase.current ??= ui.heights[SECTION_CHANGES] ?? sizedBodyHeight(SECTION_CHANGES);
    setSectionHeight(SECTION_CHANGES, changesDragBase.current - totalDeltaY);
  };
  const onChangesDividerDragEnd = (): void => {
    changesDragBase.current = null;
  };

  const viewMode: ScmViewMode = ui.viewMode;
  const changesStatus = selectedStatus;
  const stageTargets = stageAllTargets(changesStatus, selectedRepo.capabilities.staging);
  const discardTargets = discardAllTargets(changesStatus, selectedRepo.capabilities.staging);

  const changesActions = (
    <ChangesHeaderActions
      mode={viewMode}
      onChangeMode={setScmViewMode}
      monitorScope={ui.monitorScope}
      onChangeMonitorScope={setScmMonitorScope}
      stageTargets={stageTargets}
      discardTargets={discardTargets}
      busy={busy}
      onStageAll={() => onAction('stage', selectedRepo.repo_id, stageTargets)}
      onDiscardAll={() => onAction('discard', selectedRepo.repo_id, discardTargets)}
      commitCount={selectedResources.length}
      onCommitAndPush={onCommitAndPush}
      branches={branches}
      currentBranch={selectedRepo.head?.name}
      branchBusy={branchBusy}
      onBranchChange={onBranchChange}
    />
  );

  const changesBody = (
    <div className='flex-1 min-h-0 overflow-auto ps-4px pe-4px pb-8px'>
      <ScmChangesView
        repo={selectedRepo}
        status={changesStatus}
        selectedKey={view.selectedResource}
        commitSelection={commitSelection}
        onCommitSelection={onCommitSelection}
        onAction={onAction}
        busy={busy}
        failedRowKeys={failedRowKeys}
        viewMode={viewMode}
        treeExpanded={ui.treeExpanded}
      />
    </div>
  );

  return (
    <div data-scm-section-stack ref={stackRef} className='flex-1 min-h-0 flex flex-col'>
      {multiRepo && (
        <div
          data-scm-section-slot={SECTION_REPOSITORIES}
          // Repositories is the filler when open (flex-1); when collapsed it is just
          // its header (flex-shrink-0). It never carries a stored height — it always
          // takes the space the sized sections below leave.
          className={repoOpen ? 'flex-1 min-h-0 flex flex-col' : 'flex-shrink-0 flex flex-col'}
        >
          <ScmSection
            id={SECTION_REPOSITORIES}
            title={t('conversation.explorer.scm.sections.repositories')}
            collapsed={reposCollapsed}
            onToggleCollapsed={() => setSectionCollapsed(SECTION_REPOSITORIES, !reposCollapsed)}
          >
            <div className='flex-1 min-h-0 overflow-auto'>
              <RepoList
                repositories={view.repositories}
                selectedRepoId={selectedRepo.repo_id}
                onSelect={onRepoSelect}
                collapsedParents={ui.repoCollapsed}
                onToggleParent={setRepoWorktreesCollapsed}
              />
            </div>
          </ScmSection>
        </div>
      )}
      {/* Divider above Changes: only meaningful when the section above it (repositories)
          is open and Changes is sized (not itself the filler / not collapsed). */}
      {repoOpen && !changesCollapsed && (
        <ScmSectionDivider
          onDrag={onChangesDividerDrag}
          onDragEnd={onChangesDividerDragEnd}
          onDoubleReset={() => clearSectionHeight(SECTION_CHANGES)}
        />
      )}
      <div
        data-scm-section-slot={SECTION_CHANGES}
        // Changes fills only when it is the first open section (repositories collapsed
        // or single-repo); otherwise it is bottom-anchored at its stored/derived height.
        // Collapsed ⇒ just its header.
        className={
          changesIsFiller && !changesCollapsed ? 'flex-1 min-h-0 flex flex-col' : 'flex-shrink-0 flex flex-col'
        }
        style={
          changesIsFiller || changesCollapsed
            ? undefined
            : { height: SECTION_HEADER_PX + sizedBodyHeight(SECTION_CHANGES) }
        }
      >
        <ScmSection
          id={SECTION_CHANGES}
          title={t('conversation.explorer.scm.sections.changes')}
          collapsed={changesCollapsed}
          onToggleCollapsed={() => setSectionCollapsed(SECTION_CHANGES, !changesCollapsed)}
          actions={changesActions}
        >
          {changesBody}
        </ScmSection>
      </div>
    </div>
  );
};

/**
 * The Changes section header's action cluster (VS Code parity — the actions sit on
 * the section they act on, not on a separate top toolbar): stage-all, refresh, and
 * the view-as-tree/list toggle, in that right-to-left importance order. Stage-all
 * only appears when there is something to stage; refresh acts on every repo.
 * `stopPropagation` keeps a click on any action from also toggling the section's
 * collapse (the header row owns that click otherwise).
 */
const ChangesHeaderActions: React.FC<{
  mode: ScmViewMode;
  onChangeMode: (mode: ScmViewMode) => void;
  monitorScope: ScmMonitorScope;
  onChangeMonitorScope: (scope: ScmMonitorScope) => void;
  stageTargets: ScmResource[];
  discardTargets: ScmResource[];
  busy: boolean;
  onStageAll: () => void;
  onDiscardAll: () => void;
  commitCount: number;
  onCommitAndPush: () => void;
  branches: GitBranch[];
  currentBranch?: string;
  branchBusy: boolean;
  onBranchChange: (branch: string) => void;
}> = ({
  mode,
  onChangeMode,
  monitorScope,
  onChangeMonitorScope,
  stageTargets,
  discardTargets,
  busy,
  onStageAll,
  onDiscardAll,
  commitCount,
  onCommitAndPush,
  branches,
  currentBranch,
  branchBusy,
  onBranchChange,
}) => {
  const { t } = useTranslation();
  return (
    <>
      <Tooltip content={t('conversation.explorer.scm.monitorScope.tooltip')} position='br'>
        <Select
          size='mini'
          value={monitorScope}
          disabled={busy}
          data-scm-monitor-scope
          onChange={(value) => onChangeMonitorScope(value as ScmMonitorScope)}
          aria-label={t('conversation.explorer.scm.monitorScope.label')}
          style={{ maxWidth: 130 }}
        >
          <Select.Option value='project'>{t('conversation.explorer.scm.monitorScope.project')}</Select.Option>
          <Select.Option value='software'>{t('conversation.explorer.scm.monitorScope.software')}</Select.Option>
        </Select>
      </Tooltip>
      {branches.length > 0 && (
        <Select
          size='mini'
          value={currentBranch}
          loading={branchBusy}
          disabled={busy || branchBusy}
          data-scm-branch-select
          onChange={(value) => onBranchChange(value)}
          aria-label={t('conversation.explorer.scm.branch.select')}
          style={{ maxWidth: 140 }}
        >
          {branches.map((branch) => (
            <Select.Option key={branch.name} value={branch.name}>
              {branch.name}
            </Select.Option>
          ))}
        </Select>
      )}
      <Tooltip content={t('conversation.explorer.scm.commit.action')} mini position='br'>
        <Button
          type='text'
          size='mini'
          disabled={busy || commitCount === 0}
          data-scm-commit-and-push
          className='flex-shrink-0 !px-4px'
          icon={<SendOne theme='outline' size='14' />}
          aria-label={t('conversation.explorer.scm.commit.action')}
          title={t('conversation.explorer.scm.commit.action')}
          onClick={onCommitAndPush}
        />
      </Tooltip>
      {discardTargets.length > 0 && (
        <Tooltip content={t('conversation.explorer.scm.actions.discard')} mini position='br'>
          <Button
            type='text'
            size='mini'
            disabled={busy}
            data-scm-header-discard-all
            className='flex-shrink-0'
            icon={<Undo theme='outline' size='14' />}
            aria-label={t('conversation.explorer.scm.actions.discard')}
            onClick={onDiscardAll}
          />
        </Tooltip>
      )}
      {stageTargets.length > 0 && (
        <Tooltip content={t('conversation.explorer.scm.actions.stageAll')} mini position='br'>
          <Button
            type='text'
            size='mini'
            disabled={busy}
            data-scm-header-stage-all
            className='flex-shrink-0'
            icon={<Plus theme='outline' size='14' />}
            aria-label={t('conversation.explorer.scm.actions.stageAll')}
            onClick={onStageAll}
          />
        </Tooltip>
      )}
      <ViewModeToggle mode={mode} onChange={onChangeMode} />
    </>
  );
};

/**
 * The Changes section header's view-as-tree / view-as-list toggle (VS Code parity).
 * A single button that flips to the other mode; the icon shows the mode it switches
 * TO, matching VS Code's toolbar affordance.
 */
const ViewModeToggle: React.FC<{ mode: ScmViewMode; onChange: (mode: ScmViewMode) => void }> = ({ mode, onChange }) => {
  const { t } = useTranslation();
  const next: ScmViewMode = mode === 'tree' ? 'list' : 'tree';
  const label = t(next === 'tree' ? 'conversation.explorer.scm.viewAsTree' : 'conversation.explorer.scm.viewAsList');
  return (
    <Tooltip content={label} mini position='br'>
      <Button
        type='text'
        size='mini'
        data-scm-view-toggle={mode}
        className='flex-shrink-0'
        icon={next === 'tree' ? <TreeList theme='outline' size='14' /> : <ViewList theme='outline' size='14' />}
        aria-label={label}
        onClick={() => onChange(next)}
      />
    </Tooltip>
  );
};
