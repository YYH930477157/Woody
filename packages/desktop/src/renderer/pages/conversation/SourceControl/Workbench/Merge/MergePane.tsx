import React, { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { Prec, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useThemeContext } from '@/renderer/hooks/context/ThemeContext';
import {
  codeEditorFontTheme,
  codeEditorSurfaceTheme,
  getCodeEditorBaseTheme,
} from '../../../Preview/theme/codeEditorTheme';
import { loadLanguageSupport, shouldDisableHighlighting } from '../../../Preview/theme/languageLoader';
import styles from './Merge.module.css';

/** Native CodeMirror pane using Woody's local language bundles and theme. */
export function MergePane({
  title,
  value,
  file,
  readOnly = true,
  onChange,
  line,
}: {
  title: string;
  value: string;
  file: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  line?: number;
}) {
  const { theme } = useThemeContext();
  const [language, setLanguage] = useState<Extension[]>([]);
  const view = useRef<EditorView | undefined>(undefined);
  const large = shouldDisableHighlighting(value.length);
  useEffect(() => {
    let alive = true;
    if (large) {
      setLanguage([]);
      return;
    }
    void loadLanguageSupport(undefined, file).then((support) => {
      if (alive) setLanguage(support ? [support] : []);
    });
    return () => {
      alive = false;
    };
  }, [file, large]);
  const extensions = useMemo(
    () => [codeEditorFontTheme(), Prec.highest(codeEditorSurfaceTheme()), ...language],
    [language]
  );
  useEffect(() => {
    if (!view.current || line === undefined) return;
    const number = Math.min(Math.max(1, line + 1), view.current.state.doc.lines);
    view.current.dispatch({
      effects: EditorView.scrollIntoView(view.current.state.doc.line(number).from, { y: 'center' }),
    });
  }, [line]);
  return (
    <section className={styles.pane} aria-label={title}>
      <h4>{title}</h4>
      <CodeMirror
        value={value}
        height='100%'
        theme={getCodeEditorBaseTheme(theme)}
        extensions={extensions}
        readOnly={readOnly}
        editable={!readOnly}
        onChange={onChange}
        onCreateEditor={(editor) => {
          view.current = editor;
        }}
        basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: !readOnly }}
      />
    </section>
  );
}
