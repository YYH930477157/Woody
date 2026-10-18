/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, Empty, Message, Spin, Tag } from '@arco-design/web-react';
import { ArrowRight, Calendar, Check, Mail, Refresh } from '@icon-park/react';
import dayjs from 'dayjs';
import { ipcBridge } from '@/common';
import type { TodoScanSession, TodoStatusInfo } from '@/common/types/todo/todoTypes';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';

const EmailScanPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useLayoutContext()?.isMobile ?? false;
  const isDesktop = typeof window !== 'undefined' && Boolean((window as { electronAPI?: unknown }).electronAPI);
  const [status, setStatus] = useState<TodoStatusInfo | null>(null);
  const [sessions, setSessions] = useState<TodoScanSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [statusInfo, scanSessions] = await Promise.all([
        ipcBridge.todo.status.invoke(),
        ipcBridge.todo.scanSessions.invoke(),
      ]);
      setStatus(statusInfo);
      setSessions(
        (scanSessions || []).toSorted((a, b) => (b.updated_at || b.created_at) - (a.updated_at || a.created_at))
      );
    } catch (error) {
      console.error('[EmailScanPage] failed to load scan state:', error);
      setStatus(null);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isDesktop) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [isDesktop, refresh]);

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await ipcBridge.todo.scanNow.invoke();
      if (result?.ok) {
        Message.success(t('todo.scan.started', { count: result.emails_fetched ?? 0 }));
        await refresh();
        if (result.conversation_id) navigate(`/conversation/${result.conversation_id}`);
      } else if (result?.message === 'no_scan_job') {
        Message.warning(t('todo.scan.noJob', { count: result.emails_fetched ?? 0 }));
      } else if (result?.message === 'scan_in_progress') {
        Message.info(t('todo.scan.inProgress'));
      } else {
        Message.warning(result?.message || t('todo.scan.failed'));
      }
    } catch {
      Message.error(t('todo.scan.failed'));
    } finally {
      setScanning(false);
      void refresh();
    }
  }, [navigate, refresh, t]);

  if (!isDesktop) {
    return (
      <div className='w-full h-full flex-center'>
        <Empty description={t('todo.desktopOnly')} />
      </div>
    );
  }

  return (
    <div className='w-full h-full min-h-0 overflow-y-auto bg-1 px-16px py-20px'>
      <div className='mx-auto max-w-960px'>
        <div className='flex items-start justify-between gap-16px mb-20px'>
          <div className='min-w-0'>
            <div className='flex items-center gap-8px text-18px font-bold text-t-primary'>
              <Mail theme='outline' size='20' />
              <span>{t('todo.emailScan.title')}</span>
            </div>
            <p className='mt-6px text-13px text-t-secondary'>{t('todo.emailScan.description')}</p>
          </div>
          <Button
            type='primary'
            loading={scanning}
            icon={<Refresh theme='outline' size='15' />}
            onClick={() => void handleScan()}
          >
            {!isMobile && t('todo.scan.button')}
          </Button>
        </div>

        <div className='grid grid-cols-1 md:grid-cols-2 gap-12px mb-20px'>
          <div className='bg-fill-1 border border-solid border-border-2 rd-8px p-14px'>
            <div className='flex items-center justify-between gap-8px'>
              <span className='text-12px text-t-secondary'>{t('todo.emailScan.source')}</span>
              <Tag color={status?.source_ready ? 'green' : 'orange'}>
                {status?.source_ready ? t('todo.emailScan.ready') : t('todo.emailScan.needsSetup')}
              </Tag>
            </div>
            <div className='mt-10px text-15px font-[600] text-t-primary'>
              {status?.source_message || t('todo.emailScan.unknownSource')}
            </div>
            <div className='mt-6px text-12px text-t-tertiary'>{t('todo.emailScan.sourceHint')}</div>
          </div>
          <div className='bg-fill-1 border border-solid border-border-2 rd-8px p-14px'>
            <div className='flex items-center gap-8px text-12px text-t-secondary'>
              <Calendar theme='outline' size='14' />
              <span>{t('todo.emailScan.lastScan')}</span>
            </div>
            <div className='mt-10px text-15px font-[600] text-t-primary'>
              {status?.last_scan_at ? dayjs(status.last_scan_at).format('YYYY-MM-DD HH:mm') : t('todo.emailScan.never')}
            </div>
            <div className='mt-6px text-12px text-t-tertiary truncate'>
              {status?.last_scan_status || t('todo.emailScan.waiting')}
            </div>
          </div>
        </div>

        <div className='flex items-center justify-between gap-12px mb-10px'>
          <div>
            <div className='text-15px font-[600] text-t-primary'>{t('todo.emailScan.sessions')}</div>
            <div className='mt-3px text-12px text-t-tertiary'>{t('todo.emailScan.sessionsHint')}</div>
          </div>
          <Button type='text' size='small' onClick={() => navigate('/todo')}>
            {t('todo.emailScan.openTodos')}
          </Button>
        </div>

        {loading ? (
          <div className='h-180px flex-center'>
            <Spin />
          </div>
        ) : sessions.length === 0 ? (
          <div className='bg-fill-1 border border-solid border-border-2 rd-8px py-36px'>
            <Empty description={t('todo.emailScan.empty')} />
          </div>
        ) : (
          <div className='flex flex-col gap-8px'>
            {sessions.map((session) => (
              <div
                key={session.id}
                className='bg-1 border border-solid border-border-2 rd-8px px-14px py-12px flex items-center justify-between gap-12px hover:border-primary-5 transition-colors'
              >
                <div className='min-w-0'>
                  <div className='flex items-center gap-8px min-w-0'>
                    <Check theme='outline' size='15' className='text-success-6 shrink-0' />
                    <span className='text-13px font-[600] text-t-primary truncate'>{session.name}</span>
                  </div>
                  <div className='mt-5px text-12px text-t-tertiary'>
                    {dayjs(session.updated_at || session.created_at).format('YYYY-MM-DD HH:mm')}
                  </div>
                </div>
                <Button
                  type='text'
                  size='small'
                  icon={<ArrowRight theme='outline' size='15' />}
                  aria-label={t('todo.emailScan.openSession')}
                  onClick={() => navigate(`/conversation/${session.id}`)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default EmailScanPage;
