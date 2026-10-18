/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@arco-design/web-react';
import { Mail } from '@icon-park/react';
import classNames from 'classnames';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

interface SiderEmailScanEntryProps {
  isMobile: boolean;
  isActive: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onClick: () => void;
}

const SiderEmailScanEntry: React.FC<SiderEmailScanEntryProps> = ({
  isMobile,
  isActive,
  collapsed,
  siderTooltipProps,
  onClick,
}) => {
  const { t } = useTranslation();
  const title = t('todo.emailScan.title');
  const icon = (
    <Mail theme='outline' size={collapsed ? '20' : '16'} fill='currentColor' className='block leading-none shrink-0' />
  );

  return (
    <Tooltip {...siderTooltipProps} content={title} position='right'>
      <div
        className={classNames(
          collapsed
            ? 'w-full h-34px flex items-center justify-center cursor-pointer transition-colors rd-8px text-t-primary'
            : 'box-border group h-34px w-full flex items-center justify-start gap-8px ps-10px pe-8px rd-0.5rem cursor-pointer shrink-0 transition-all text-t-primary',
          isMobile && !collapsed && 'sider-action-btn-mobile',
          isActive ? 'bg-fill-3' : 'hover:bg-fill-3 active:bg-fill-4'
        )}
        onClick={onClick}
      >
        {collapsed ? (
          icon
        ) : (
          <span className='size-22px flex items-center justify-center shrink-0 text-t-primary'>{icon}</span>
        )}
        {!collapsed && (
          <span className='collapsed-hidden text-t-primary text-14px font-[500] leading-24px'>{title}</span>
        )}
      </div>
    </Tooltip>
  );
};

export default SiderEmailScanEntry;
