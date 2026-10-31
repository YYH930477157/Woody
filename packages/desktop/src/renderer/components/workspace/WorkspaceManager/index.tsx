import React, { useEffect, useRef, useState } from 'react';
import { Button, Empty, Input, Message, Modal, Select, Space, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { ProjectDetailDto, WorkspaceUpdate } from '@/common/types/project';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { hydrateSelectedWorkspace, selectWorkspace, useSelectedWorkspace } from '../workspaceSelection';
import { buildWorkspaceUpdate, moveWorkspaceRoot, pathToFileUri, removeWorkspaceRoot } from './model';
import {
  addWorkspaceRoot,
  closeRootEditors,
  confirmRootEditors,
  confirmWorkspaceLeave,
  publishWorkspaceDetail,
  saveWorkspaceConfiguration,
} from './lifecycle';

export type WorkspaceManagerProps = {
  projectId?: string;
  onWorkspaceChange?: (detail: ProjectDetailDto) => void;
};

/** Desktop aionrs workspace settings, also available before creating a conversation. */
const WorkspaceManager: React.FC<WorkspaceManagerProps> = ({ projectId, onWorkspaceChange }) => {
  const { t } = useTranslation();
  const selected = useSelectedWorkspace();
  const id = projectId || selected?.project_id;
  const { data, mutate } = useSWR(id ? `explorer-project/${id}` : null, (key: string) =>
    ipcBridge.project.get.invoke({ project_id: key.slice('explorer-project/'.length) })
  );
  const detail = data?.project_id === id ? data : selected?.project_id === id ? selected : undefined;
  const preview = useOptionalPreviewContext();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const operationPending = useRef(false);
  const [name, setName] = useState('');
  useEffect(() => {
    void hydrateSelectedWorkspace((project_id) => ipcBridge.project.get.invoke({ project_id })).catch(() =>
      Message.error(t('conversation.managedWorkspace.failed'))
    );
  }, [t]);
  useEffect(() => setName(detail?.name || ''), [detail?.name]);
  const managed = detail?.workspace?.managed === true;
  const perform = async (action: () => Promise<void>): Promise<void> => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      // Older AionCore builds do not mount the workspace routes at all; say so instead of a generic failure.
      const unsupported = isBackendHttpError(error) && (error.status === 404 || error.status === 405);
      const code = isBackendHttpError(error) ? error.code : undefined;
      Message.error(
        t(
          unsupported
            ? 'conversation.managedWorkspace.unsupported'
            : code === 'project_workspace_busy'
              ? 'conversation.managedWorkspace.busy'
              : code === 'project_explorer_duplicate'
                ? 'conversation.explorer.attachDuplicate'
                : code === 'project_explorer_overlap'
                  ? 'conversation.explorer.attachOverlap'
                  : 'conversation.managedWorkspace.failed'
        )
      );
      void mutate();
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  };
  const update = async (body: WorkspaceUpdate): Promise<void> => {
    if (!id) return;
    const next = await ipcBridge.project.updateWorkspace.invoke({ project_id: id, ...body });
    await mutate(next, false);
    if (selected?.project_id === id) selectWorkspace(next);
  };
  const choose = async (next: ProjectDetailDto): Promise<void> => {
    await publishWorkspaceDetail(next);
    selectWorkspace(next);
    onWorkspaceChange?.(next);
    setVisible(false);
  };
  const leave = async (): Promise<boolean> => {
    if (id && managed && !(await confirmWorkspaceLeave(id))) return false;
    return !selected || selected.project_id === id || (await confirmWorkspaceLeave(selected.project_id));
  };
  const create = () =>
    perform(async () => {
      if (!(await leave())) return;
      await choose(
        await ipcBridge.project.createWorkspace.invoke({ name: t('conversation.managedWorkspace.untitled') })
      );
    });
  const open = () =>
    perform(async () => {
      const path = await ipcBridge.dialog.selectWorkspaceFile.invoke();
      if (!path || !(await leave())) return;
      const affected = detail?.explorer.entries.map((root) => root.pe_id) || [];
      if (!(await confirmRootEditors(preview, affected))) return;
      const opened = await ipcBridge.project.openWorkspace.invoke({ path });
      if (opened.project_id === id) closeRootEditors(preview, affected);
      await choose(opened);
    });
  const add = () =>
    perform(async () => {
      if (!detail) return;
      const paths = await ipcBridge.dialog.showOpen.invoke({ properties: ['openDirectory', 'createDirectory'] });
      if (!paths?.[0]) return;
      const next = await addWorkspaceRoot(detail, pathToFileUri(paths[0]));
      await mutate(next, false);
      if (selected?.project_id === id) selectWorkspace(next);
    });
  const remove = (peId: string) =>
    perform(async () => {
      if (!detail || !(await confirmRootEditors(preview, [peId]))) return;
      await update(removeWorkspaceRoot(buildWorkspaceUpdate(detail), peId));
      closeRootEditors(preview, [peId]);
    });
  const relocate = (peId: string) =>
    perform(async () => {
      if (!detail) return;
      const paths = await ipcBridge.dialog.showOpen.invoke({ properties: ['openDirectory'] });
      if (!paths?.[0] || !(await confirmRootEditors(preview, [peId]))) return;
      const body = buildWorkspaceUpdate(detail);
      await update({
        ...body,
        roots: body.roots.map((root) => (root.pe_id === peId ? { ...root, uri: pathToFileUri(paths[0]) } : root)),
      });
      closeRootEditors(preview, [peId]);
    });
  return (
    <>
      <Button
        size='small'
        type='text'
        aria-label={t('conversation.managedWorkspace.manage')}
        onClick={() => setVisible(true)}
      >
        {managed ? detail.name : t('conversation.managedWorkspace.manage')}
        {detail?.workspace?.dirty ? ' *' : ''}
      </Button>
      <Modal
        title={t('conversation.managedWorkspace.manage')}
        visible={visible}
        onCancel={() => setVisible(false)}
        footer={null}
        style={{ width: 680, maxWidth: '95vw' }}
      >
        <Space wrap className='mb-16px'>
          <Button disabled={busy} onClick={create}>
            {t('conversation.managedWorkspace.new')}
          </Button>
          <Button disabled={busy} onClick={open}>
            {t('conversation.managedWorkspace.open')}
          </Button>
          {managed && (
            <>
              <Button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (selected && selected.project_id !== id && !(await confirmWorkspaceLeave(selected.project_id)))
                      return;
                    await choose(detail!);
                  })
                }
              >
                {t('conversation.managedWorkspace.useForNewChat')}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (await saveWorkspaceConfiguration(id!)) await mutate();
                  })
                }
              >
                {t('common.save')}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (await saveWorkspaceConfiguration(id!, true)) await mutate();
                  })
                }
              >
                {t('conversation.managedWorkspace.saveAs')}
              </Button>
              <Button
                disabled={busy || !detail.workspace?.dirty}
                onClick={() =>
                  void perform(async () => {
                    if (
                      !(await confirmRootEditors(
                        preview,
                        detail.explorer.entries.map((root) => root.pe_id)
                      ))
                    )
                      return;
                    const next = await ipcBridge.project.discardWorkspace.invoke({ project_id: id! });
                    closeRootEditors(
                      preview,
                      detail.explorer.entries.map((root) => root.pe_id)
                    );
                    await mutate(next, false);
                    if (selected?.project_id === id) selectWorkspace(next);
                  })
                }
              >
                {t('conversation.managedWorkspace.discard')}
              </Button>
            </>
          )}
        </Space>
        {managed && detail ? (
          <div className='flex flex-col gap-12px'>
            <label className='flex flex-col gap-4px'>
              <span>{t('conversation.managedWorkspace.name')}</span>
              <Input
                value={name}
                disabled={busy}
                onChange={setName}
                onBlur={() => {
                  if (name.trim() && name.trim() !== detail.name)
                    void perform(() => update({ ...buildWorkspaceUpdate(detail), name: name.trim() }));
                }}
                aria-label={t('conversation.managedWorkspace.name')}
              />
            </label>
            <div className='text-12px text-t-secondary break-all'>
              {detail.workspace?.config_path || t('conversation.managedWorkspace.unsavedFile')}
            </div>
            <label className='flex flex-col gap-4px'>
              <span>{t('conversation.managedWorkspace.defaultRoot')}</span>
              <Select
                disabled={busy}
                value={detail.workspace?.default_pe_id || ''}
                aria-label={t('conversation.managedWorkspace.defaultRoot')}
                onChange={(value: string) =>
                  void perform(() => update({ ...buildWorkspaceUpdate(detail), default_pe_id: value || null }))
                }
                options={[
                  { label: t('conversation.managedWorkspace.noDefault'), value: '' },
                  ...detail.explorer.entries.map((root) => ({
                    value: root.pe_id,
                    label: root.display_name ? `${root.display_name} · ${root.display_path}` : root.display_path,
                    disabled: root.runtime_status !== 'available',
                  })),
                ]}
              />
            </label>
            <div className='flex justify-between items-center'>
              <span>{t('conversation.managedWorkspace.roots')}</span>
              <Button disabled={busy} onClick={add}>
                {t('conversation.explorer.addFolder')}
              </Button>
            </div>
            {!detail.explorer.entries.length && <Empty description={t('conversation.managedWorkspace.empty')} />}
            {detail.explorer.entries.map((root, index) => (
              <div key={root.pe_id} className='border border-[var(--bg-3)] rounded-8px p-12px flex flex-col gap-8px'>
                <Input
                  key={`${root.pe_id}:${root.display_name || ''}`}
                  disabled={busy}
                  defaultValue={root.display_name || ''}
                  placeholder={t('conversation.managedWorkspace.alias')}
                  aria-label={t('conversation.managedWorkspace.alias')}
                  onBlur={(event) => {
                    const alias = event.target.value.trim();
                    if (alias === (root.display_name || '')) return;
                    const body = buildWorkspaceUpdate(detail);
                    void perform(() =>
                      update({
                        ...body,
                        roots: body.roots.map((item) =>
                          item.pe_id === root.pe_id ? { ...item, display_name: alias } : item
                        ),
                      })
                    );
                  }}
                />
                <div dir='ltr' className='text-12px text-t-secondary break-all'>
                  {root.display_path}
                </div>
                {root.runtime_status !== 'available' && (
                  <Tag color='orange'>{t('conversation.managedWorkspace.unavailable')}</Tag>
                )}
                <Space wrap>
                  <Button
                    disabled={busy || index === 0}
                    size='mini'
                    onClick={() =>
                      void perform(() => update(moveWorkspaceRoot(buildWorkspaceUpdate(detail), root.pe_id, -1)))
                    }
                  >
                    {t('conversation.managedWorkspace.moveUp')}
                  </Button>
                  <Button
                    disabled={busy || index === detail.explorer.entries.length - 1}
                    size='mini'
                    onClick={() =>
                      void perform(() => update(moveWorkspaceRoot(buildWorkspaceUpdate(detail), root.pe_id, 1)))
                    }
                  >
                    {t('conversation.managedWorkspace.moveDown')}
                  </Button>
                  <Button disabled={busy} size='mini' onClick={() => void relocate(root.pe_id)}>
                    {t('conversation.managedWorkspace.relocate')}
                  </Button>
                  <Button disabled={busy} size='mini' status='danger' onClick={() => void remove(root.pe_id)}>
                    {t('conversation.explorer.removeFolder')}
                  </Button>
                </Space>
              </div>
            ))}
            <div className='text-12px text-t-secondary'>{t('conversation.managedWorkspace.appliedHint')}</div>
          </div>
        ) : (
          <Empty description={t('conversation.managedWorkspace.startHint')} />
        )}
      </Modal>
    </>
  );
};
export default WorkspaceManager;
