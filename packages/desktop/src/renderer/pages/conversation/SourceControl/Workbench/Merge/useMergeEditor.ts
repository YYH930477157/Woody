import { useCallback, useEffect, useRef, useState } from 'react';
import { gitWorkbench } from '@/common/adapter/ipcBridge';
import type { GitMergeDocument, GitMergeFinishRequest } from '@/common/types/sourceControl/mergeTypes';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import { refreshRepo } from '../../scmStore';
import {
  createEditorState,
  editResult,
  progressOf,
  rebuildResult,
  resultText,
  type MergeEditorState,
} from './editorState';

export function useMergeEditor(scope: GitWorkbenchScope, repoId: string, file: string, onFinished: () => void) {
  const [document, setDocument] = useState<GitMergeDocument>();
  const [editor, setEditor] = useState<MergeEditorState>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const running = useRef(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const epoch = ++generation.current;
    setLoading(true);
    setError(undefined);
    setDocument(undefined);
    setEditor(undefined);
    setDirty(false);
    void gitWorkbench.mergeRead
      .invoke({ scope, file })
      .then((value) => {
        if (epoch !== generation.current) return;
        setDocument(value);
        setEditor(createEditorState(value));
      })
      .catch((failure: unknown) => {
        if (epoch === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (epoch === generation.current) setLoading(false);
      });
    return () => {
      ++generation.current;
    };
  }, [scope, file, revision]);
  const mutate = (change: (current: MergeEditorState) => MergeEditorState) => {
    if (running.current || !editor) return;
    setEditor(change(editor));
    setDirty(true);
    setError(undefined);
  };
  const save = useCallback(async () => {
    if (running.current || !document || !editor || document.binary) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    const epoch = generation.current;
    try {
      const saved = await gitWorkbench.mergeSave.invoke({
        scope,
        request: {
          file,
          version: document.version,
          result: resultText(editor, document.crlf),
          progress: progressOf(editor),
        },
      });
      if (epoch === generation.current) {
        setDocument(saved);
        setEditor(createEditorState(saved));
        setDirty(false);
      }
    } catch (failure) {
      if (epoch === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      running.current = false;
      if (epoch === generation.current) setBusy(false);
    }
  }, [document, editor, scope, file]);
  const finish = useCallback(
    async (resolution: GitMergeFinishRequest['resolution'], reviewedManual = false) => {
      if (running.current || !document || !editor) return;
      running.current = true;
      setBusy(true);
      setError(undefined);
      const epoch = generation.current;
      try {
        const outcome = await gitWorkbench.mergeFinish.invoke({
          scope,
          request: {
            file,
            version: document.version,
            resolution,
            confirmed: true,
            ...(resolution === 'result' ? { result: resultText(editor, document.crlf), reviewedManual } : {}),
          },
        });
        if (epoch !== generation.current) return;
        if (outcome.state !== 'complete') {
          setError(outcome.output);
          return;
        }
        setDirty(false);
        // The file is already staged even if SCM refresh fails; never invite a second finish.
        await refreshRepo(repoId).catch(() => {});
        if (epoch === generation.current) onFinished();
      } catch (failure) {
        if (epoch === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        running.current = false;
        if (epoch === generation.current) setBusy(false);
      }
    },
    [scope, repoId, file, document, editor, onFinished]
  );
  return {
    document,
    editor,
    text: editor?.model.lines.join('\n') ?? '',
    loading,
    busy,
    dirty,
    error,
    save,
    finish,
    retry: () => {
      if (!running.current && !dirty) setRevision((value) => value + 1);
    },
    discard: () => {
      if (!running.current && document) {
        setEditor(createEditorState(document));
        setDirty(false);
        setError(undefined);
      }
    },
    edit: (text: string) => mutate((current) => editResult(current, text)),
    recover: () => {
      const draft = document?.recoveryResult;
      if (draft !== undefined) mutate((current) => editResult(current, draft));
    },
    rebuild: () => {
      if (document) mutate(() => rebuildResult(document));
    },
    accept: (index: number, side: 'left' | 'right') =>
      mutate((current) => {
        if (current.manual) return current;
        const model = current.model.clone();
        model.replaceChange(index, side, true);
        model.takeEdits();
        return { model, manual: false };
      }),
  };
}
