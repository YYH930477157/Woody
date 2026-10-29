/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PreviewMetadata } from '../../context/PreviewContext';
import { resolvePreviewPayload } from '@/renderer/utils/file/previewPayload';
import { getFileTypeInfo } from '@/renderer/utils/file/fileType';
import { useTextSelection } from '@/renderer/hooks/ui/useTextSelection';
import { Checkbox } from '@arco-design/web-react';
import classNames from 'classnames';
import { html } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import SyntaxHighlighter from 'react-syntax-highlighter';
import { vs, vs2015 } from 'react-syntax-highlighter/dist/esm/styles/hljs';
import SelectionToolbar from '../renderers/SelectionToolbar';
import { useTranslation } from 'react-i18next';

interface DiffPreviewProps {
  content: string; // Diff content
  metadata?: PreviewMetadata;
  onClose?: () => void;
  hideToolbar?: boolean;
  viewMode?: 'source' | 'preview';
  onViewModeChange?: (mode: 'source' | 'preview') => void;
}

/**
 * Diff preview component with rich diff2html rendering
 */
const DiffPreview: React.FC<DiffPreviewProps> = ({
  content,
  metadata,
  hideToolbar = false,
  viewMode: externalViewMode,
  onViewModeChange,
}) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const diffContainerRef = useRef<HTMLDivElement>(null);
  const [currentTheme, setCurrentTheme] = useState<'light' | 'dark'>(() => {
    return (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light';
  });
  const [internalViewMode, setInternalViewMode] = useState<'source' | 'preview'>('preview');
  const [sideBySide, setSideBySide] = useState(false);

  const viewMode = externalViewMode !== undefined ? externalViewMode : internalViewMode;
  const [source, setSource] = useState<{ content?: string; notice?: 'loading' | 'failed' | 'oversized' | 'binary' }>({
    notice: 'loading',
  });
  const isScmDiff = Boolean(metadata?.scmDiff && metadata.fileRef);

  useEffect(() => {
    if (!isScmDiff || viewMode !== 'source' || !metadata?.fileRef) return;
    const fileRef = metadata.fileRef;
    let generation = 0;
    const load = async () => {
      const request = ++generation;
      setSource({ notice: 'loading' });
      if (metadata.scmDiff?.binary) {
        setSource({ notice: 'binary' });
        return;
      }
      try {
        const payload = await resolvePreviewPayload(fileRef, 'code');
        if (request !== generation) return;
        setSource(
          payload.oversized
            ? { notice: 'oversized' }
            : payload.content.includes('\0')
              ? { notice: 'binary' }
              : { content: payload.content }
        );
      } catch {
        if (request === generation) setSource({ notice: 'failed' });
      }
    };
    void load();
    window.addEventListener('focus', load);
    return () => {
      generation++;
      window.removeEventListener('focus', load);
    };
  }, [isScmDiff, viewMode, metadata, content]);

  const sourceNotice =
    source.notice === 'loading'
      ? t('preview.loading')
      : source.notice === 'failed'
        ? t('preview.refresh.failed')
        : source.notice === 'oversized'
          ? t('preview.oversized.title')
          : source.notice === 'binary'
            ? t('conversation.explorer.scm.diff.binary')
            : null;

  useEffect(() => {
    const updateTheme = () => {
      const theme = (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light';
      setCurrentTheme(theme);
    };

    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => observer.disconnect();
  }, []);

  const { selectedText, selectedUrl, selectionPosition, clearSelection } = useTextSelection(containerRef);

  const diffHtmlContent = useMemo(() => {
    return html(content, {
      outputFormat: sideBySide ? 'side-by-side' : 'line-by-line',
      drawFileList: false,
      matching: 'lines',
      matchWordsThreshold: 0,
      maxLineLengthHighlight: 20,
      matchingMaxComparisons: 3,
      diffStyle: 'word',
      renderNothingWhenEmpty: false,
    });
  }, [content, sideBySide]);

  // Portal container for injecting side-by-side toggle into d2h-file-header
  const operatorRef = useRef<HTMLDivElement | null>(null);
  if (!operatorRef.current) {
    operatorRef.current = document.createElement('div');
  }

  // Inject operator into d2h-file-header after diff content changes
  useLayoutEffect(() => {
    const el = diffContainerRef.current;
    if (!el || viewMode !== 'preview') return;

    const header = el.querySelector('.d2h-file-header') as HTMLDivElement;
    if (header && operatorRef.current) {
      header.style.alignItems = 'center';
      operatorRef.current.className = 'flex items-center justify-center gap-10px';

      if (!header.contains(operatorRef.current)) {
        header.appendChild(operatorRef.current);
      }
    }
  }, [diffHtmlContent, viewMode]);

  const handleDownload = () => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `diff-${Date.now()}.diff`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleViewModeChange = (mode: 'source' | 'preview') => {
    if (onViewModeChange) {
      onViewModeChange(mode);
    } else {
      setInternalViewMode(mode);
    }
  };

  return (
    <div data-diff-view={viewMode} className='flex flex-col w-full h-full overflow-hidden'>
      {!hideToolbar && (
        <div className='flex items-center justify-between h-40px px-12px bg-bg-2 flex-shrink-0'>
          <div className='flex items-center gap-4px'>
            <div
              className={`px-12px py-4px rd-4px cursor-pointer transition-colors text-12px ${viewMode === 'source' ? 'bg-primary text-white' : 'text-t-secondary hover:bg-bg-3'}`}
              onClick={() => handleViewModeChange('source')}
            >
              {t('preview.source')}
            </div>
            <div
              className={`px-12px py-4px rd-4px cursor-pointer transition-colors text-12px ${viewMode === 'preview' ? 'bg-primary text-white' : 'text-t-secondary hover:bg-bg-3'}`}
              onClick={() => handleViewModeChange('preview')}
            >
              {t('preview.preview')}
            </div>
          </div>

          <div className='flex items-center gap-8px'>
            {viewMode === 'preview' && (
              <Checkbox
                className='whitespace-nowrap text-12px'
                checked={sideBySide}
                onChange={(value) => setSideBySide(value)}
              >
                <span className='text-12px text-t-secondary'>side-by-side</span>
              </Checkbox>
            )}
            <div
              className='flex items-center gap-4px px-8px py-4px rd-4px cursor-pointer hover:bg-bg-3 transition-colors'
              onClick={handleDownload}
              title={t('preview.downloadDiff')}
            >
              <svg
                width='14'
                height='14'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2'
                className='text-t-secondary'
              >
                <path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' />
                <polyline points='7 10 12 15 17 10' />
                <line x1='12' y1='15' x2='12' y2='3' />
              </svg>
              <span className='text-12px text-t-secondary'>{t('common.download')}</span>
            </div>
          </div>
        </div>
      )}

      <div ref={containerRef} className='flex-1 overflow-auto p-16px'>
        {viewMode === 'source' ? (
          isScmDiff && sourceNotice ? (
            <div role='status' className='text-t-secondary'>
              {sourceNotice}
            </div>
          ) : (
            <SyntaxHighlighter
              style={currentTheme === 'dark' ? vs2015 : vs}
              language={isScmDiff ? getFileTypeInfo(metadata?.file_name ?? '').language : 'diff'}
              PreTag='div'
              showLineNumbers
              wrapLongLines
              customStyle={{
                fontSize: '13px',
                fontFamily: 'var(--font-mono)',
                fontWeight: 'var(--font-mono-weight)',
                lineHeight: 1.5,
              }}
            >
              {isScmDiff ? (source.content ?? '') : content}
            </SyntaxHighlighter>
          )
        ) : metadata?.scmDiff && (metadata.scmDiff.binary || metadata.scmDiff.truncated || !content) ? (
          <div role='status' className='text-t-secondary'>
            {metadata.scmDiff.binary
              ? t('conversation.explorer.scm.diff.binary')
              : metadata.scmDiff.truncated
                ? t('preview.oversized.title')
                : t('conversation.explorer.scm.diff.empty')}
          </div>
        ) : (
          <div
            ref={diffContainerRef}
            className={classNames(
              'w-full max-w-full min-w-0',
              '![&_.line-num1]:hidden ![&_.line-num2]:w-30px',
              '[&_td:first-child]:w-40px ![&_td:nth-child(2)>div]:ps-45px',
              '[&_div.d2h-file-wrapper]:rd-[0.3rem_0.3rem_0px_0px]',
              '[&_div.d2h-file-header]:items-center [&_div.d2h-file-header]:bg-bg-3',
              {
                'd2h-dark-color-scheme': currentTheme === 'dark',
              }
            )}
            dangerouslySetInnerHTML={{ __html: diffHtmlContent }}
          />
        )}
      </div>

      {/* Portal: inject side-by-side toggle into d2h-file-header */}
      {viewMode === 'preview' &&
        operatorRef.current &&
        ReactDOM.createPortal(
          <Checkbox className='whitespace-nowrap' checked={sideBySide} onChange={(value) => setSideBySide(value)}>
            <span className='whitespace-nowrap'>side-by-side</span>
          </Checkbox>,
          operatorRef.current
        )}

      {selectedText && (
        <SelectionToolbar
          selectedText={selectedText}
          selectedUrl={selectedUrl}
          position={selectionPosition}
          onClear={clearSelection}
        />
      )}
    </div>
  );
};

export default DiffPreview;
