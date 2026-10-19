import React from 'react';
import TerminalPanel from './TerminalPanel';
import { Alert } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';

export default function TerminalPage() {
  const { t } = useTranslation();
  if (!window.electronAPI) return <Alert type='info' content={t('tools.terminal.noDesktop')} />;
  return <TerminalPanel />;
}
