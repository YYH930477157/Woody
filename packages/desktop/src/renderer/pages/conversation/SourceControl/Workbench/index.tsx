import React, { useEffect, useMemo, useState } from 'react';
import { Button, Modal, Select, Tabs } from '@arco-design/web-react';
import { BranchTwo } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { isElectronDesktop } from '@renderer/utils/platform';
import { gitWorkbench } from '@/common/adapter/ipcBridge';
import type { GitRuntimeStatus } from '@/common/types/sourceControl/workbenchTypes';
import { ScmPanel, type ScmPanelProps } from '../ScmPanel';
import { openScmProject, setSelectedRepo, useScm } from '../scmStore';
import { initScmRuntime } from '../scmTransport';
import { setScmSelectedRepo, useScmUi } from '../scmUiStore';
import { HistoryView } from './History';
import { Operations } from './Operations';
import { Merge } from './Merge';
import { Shelves } from './Storage/Shelves';
import { LocalHistory } from './Storage/LocalHistory';
import styles from './Workbench.module.css';

/** Native history workbench sharing the Changes panel's repository and commit workflow. */
export const Workbench: React.FC<ScmPanelProps> = (props) => {
  const { t } = useTranslation();
  const view = useScm();
  const ui = useScmUi();
  const [visible, setVisible] = useState(false);
  const [tab, setTab] = useState('history');
  const [operationBusy, setOperationBusy] = useState(false);
  const [gitRuntime, setGitRuntime] = useState<GitRuntimeStatus>();
  const desktop = isElectronDesktop();
  useEffect(() => {
    initScmRuntime();
    void openScmProject(props.projectId);
    if (desktop) {
      void gitWorkbench.runtime
        .invoke()
        .then(setGitRuntime)
        .catch(() => setGitRuntime({ available: false }));
    }
  }, [desktop, props.projectId]);
  const repositories = view.projectId === props.projectId ? view.repositories : [];
  const selectedRepoId = view.selectedRepoId ?? (ui.projectId === props.projectId ? ui.selectedRepoId : null);
  const repository = repositories.find((repo) => repo.repo_id === selectedRepoId) ?? repositories[0];
  const peId = repository?.root.pe_id;
  const relativePath = repository?.root.relative_path;
  const scope = useMemo(
    () =>
      peId !== undefined && relativePath !== undefined ? { projectId: props.projectId, peId, relativePath } : undefined,
    [props.projectId, peId, relativePath]
  );

  const historyScope = useMemo(() => (scope ? { ...scope, relativePath: '' } : undefined), [scope]);

  return (
    <div className='flex flex-col h-full min-h-0'>
      <div className='flex items-center justify-between gap-8px px-12px py-8px border-b border-b-base'>
        <span className='text-t-secondary text-12px'>{t('conversation.explorer.scm.sections.changes')}</span>
        {desktop && (
          <Button
            size='small'
            icon={<BranchTwo />}
            disabled={!repository || repository.provider_id !== 'git'}
            onClick={() => setVisible(true)}
          >
            {t('conversation.gitWorkbench.history')}
          </Button>
        )}
      </div>
      <div className='flex-1 min-h-0'>
        <ScmPanel {...props} changelists={desktop} />
      </div>
      <Modal
        className={styles.modal}
        visible={desktop && visible}
        title={t('conversation.gitWorkbench.history')}
        footer={null}
        onCancel={() => {
          if (!operationBusy) setVisible(false);
        }}
        closable={!operationBusy}
        maskClosable={!operationBusy}
        escToExit={!operationBusy}
        unmountOnExit
      >
        {desktop && visible && scope && repository?.provider_id === 'git' && (
          <>
            <Select
              aria-label={t('conversation.gitWorkbench.repository')}
              className={styles.repository}
              value={repository.repo_id}
              disabled={operationBusy}
              onChange={(repoId) => {
                setScmSelectedRepo(repoId);
                setSelectedRepo(repoId);
              }}
              options={repositories
                .filter((repo) => repo.provider_id === 'git')
                .map((repo) => ({ label: repo.label, value: repo.repo_id }))}
            />
            <Tabs activeTab={tab} onChange={setTab}>
              <Tabs.TabPane key='history' title={t('conversation.gitWorkbench.history')} disabled={operationBusy}>
                {tab === 'history' && (
                  <HistoryView
                    key={JSON.stringify(scope)}
                    scope={scope}
                    repoId={repository.repo_id}
                    canRewrite={gitRuntime?.capabilities?.memoryHistoryEdit ?? true}
                    onBusyChange={setOperationBusy}
                    onResolve={() => setTab('merge')}
                  />
                )}
              </Tabs.TabPane>
              <Tabs.TabPane
                key='operations'
                title={t('conversation.gitWorkbench.operations.title')}
                disabled={operationBusy && tab !== 'operations'}
              >
                {tab === 'operations' && (
                  <Operations
                    key={JSON.stringify(scope)}
                    scope={scope}
                    repoId={repository.repo_id}
                    onBusyChange={setOperationBusy}
                  />
                )}
              </Tabs.TabPane>
              <Tabs.TabPane
                key='merge'
                title={t('conversation.gitWorkbench.merge.title')}
                disabled={operationBusy && tab !== 'merge'}
              >
                {tab === 'merge' && (
                  <Merge
                    key={JSON.stringify(scope)}
                    scope={scope}
                    repoId={repository.repo_id}
                    onBusyChange={setOperationBusy}
                  />
                )}
              </Tabs.TabPane>
              <Tabs.TabPane
                key='shelves'
                title={t('conversation.gitWorkbench.storage.shelves')}
                disabled={operationBusy && tab !== 'shelves'}
              >
                {tab === 'shelves' && (
                  <Shelves
                    key={JSON.stringify(scope)}
                    scope={scope}
                    paths={[
                      ...new Set(
                        (view.statuses[repository.repo_id]?.resources ?? []).flatMap((file) => [
                          file.repo_relative_path,
                          ...(file.rename_from ? [file.rename_from] : []),
                        ])
                      ),
                    ]}
                    onBusyChange={setOperationBusy}
                  />
                )}
              </Tabs.TabPane>
              <Tabs.TabPane
                key='localHistory'
                title={t('conversation.gitWorkbench.storage.localHistory')}
                disabled={operationBusy && tab !== 'localHistory'}
              >
                {tab === 'localHistory' && historyScope && (
                  <LocalHistory
                    key={JSON.stringify(historyScope)}
                    scope={historyScope}
                    onBusyChange={setOperationBusy}
                  />
                )}
              </Tabs.TabPane>
            </Tabs>
          </>
        )}
      </Modal>
    </div>
  );
};
