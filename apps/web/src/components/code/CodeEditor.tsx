import { useEffect, useRef } from 'react';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, foldService, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion, type CompletionSource } from '@codemirror/autocomplete';
import { languageSupport, type CodeLanguage } from './languages';
import { highlighter } from './highlight';
import { cx } from '../ui';

/**
 * A CodeMirror 6 view used for every code surface: read-only serialisations
 * on the Formats tab (with folding, search and line numbers) and the editable
 * SPARQL and Turtle boxes on the Query tab (with autocomplete and Mod-Enter
 * to run).
 */

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface-2)', color: 'var(--fg)', fontSize: '0.8rem' },
  '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--fg)', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--muted)', border: 'none', borderRight: '1px solid var(--line)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent-soft) 55%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--accent-soft)', color: 'var(--fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--syn-selection) !important' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--syn-selection) 60%, transparent)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--accent-soft)', border: 'none', color: 'var(--accent)', padding: '0 6px' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--fg)', borderColor: 'var(--line)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '0.8rem' },
  '.cm-textfield': { backgroundColor: 'var(--surface-2)', border: '1px solid var(--line-strong)', borderRadius: '4px', color: 'var(--fg)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--surface-2)', border: '1px solid var(--line-strong)', borderRadius: '4px', color: 'var(--fg)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: '6px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px !important', fontFamily: 'var(--font-mono)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-fg)' },
  '.cm-completionDetail': { color: 'inherit', opacity: '0.7', marginLeft: '8px', fontStyle: 'normal' },
  '.cm-placeholder': { color: 'var(--subtle)' },
});

/**
 * Indentation-based folding for the RDF-family languages (Turtle subject
 * blocks, Manchester frames). XML, JSON and YAML fold from their grammars.
 */
const indentFolding = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart);
  const indent = (s: string) => s.length - s.trimStart().length;
  if (!line.text.trim()) return null;
  const base = indent(line.text);
  let end = line.number;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const next = state.doc.line(n);
    if (!next.text.trim()) continue;
    if (indent(next.text) <= base) break;
    end = n;
  }
  return end > line.number ? { from: line.to, to: state.doc.line(end).to } : null;
});

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language: CodeLanguage;
  readOnly?: boolean;
  /** Called on Mod-Enter. */
  onRun?: () => void;
  /** Extra completions (ontology terms) on top of the language's keywords. */
  completions?: Completion[];
  ariaLabel: string;
  placeholder?: string;
  minHeight?: number;
  maxHeight?: number;
  wrap?: boolean;
  className?: string;
  testId?: string;
}

const SPARQL_COMPLETIONS: Completion[] = [
  ...'SELECT DISTINCT WHERE OPTIONAL FILTER ORDER BY LIMIT OFFSET GROUP BY HAVING UNION MINUS BIND VALUES ASK CONSTRUCT DESCRIBE PREFIX'
    .split(' ')
    .map((label) => ({ label, type: 'keyword' })),
  ...'COUNT STR LANG CONTAINS STRSTARTS REGEX LCASE UCASE isIRI isLiteral BOUND COALESCE GROUP_CONCAT SAMPLE'
    .split(' ')
    .map((label) => ({ label, type: 'function', apply: `${label}()` })),
];

function completionSource(language: CodeLanguage, extra: () => Completion[]): CompletionSource {
  return (ctx) => {
    const word = ctx.matchBefore(/[?$]?[\w-]*:?[\w.-]*/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    const options = [...extra(), ...(language === 'sparql' ? SPARQL_COMPLETIONS : [])];
    if (language === 'sparql' && word.text.startsWith('?')) {
      // Suggest variables already used in the query.
      const vars = new Set(ctx.state.doc.toString().match(/[?$][A-Za-z_][\w]*/g) ?? []);
      return { from: word.from, options: [...vars].map((v) => ({ label: v, type: 'variable' })) };
    }
    return { from: word.from, options, validFor: /^[\w:.-]*$/ };
  };
}

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  onRun,
  completions,
  ariaLabel,
  placeholder,
  minHeight,
  maxHeight = 520,
  wrap = false,
  className,
  testId,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  // Keep callbacks fresh without rebuilding the editor.
  const latest = useRef({ onChange, onRun, completions });
  latest.current = { onChange, onRun, completions };

  useEffect(() => {
    if (!host.current) return;
    const support = languageSupport(language);
    const extensions: Extension[] = [
      lineNumbers(),
      foldGutter(),
      highlightSpecialChars(),
      drawSelection(),
      syntaxHighlighting(highlighter),
      bracketMatching(),
      highlightSelectionMatches(),
      search({ top: true }),
      indentFolding,
      theme,
      langComp.current.of(support ?? []),
      EditorView.contentAttributes.of({ 'aria-label': ariaLabel, ...(testId ? { 'data-testid': testId } : {}) }),
      // Read-only views stay focusable (no editable:false) so keyboard selection,
      // copy and Ctrl/⌘-F search work in them.
      EditorState.readOnly.of(readOnly),
      wrap ? EditorView.lineWrapping : [],
      placeholder ? placeholderExt(placeholder) : [],
      keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
    ];
    if (!readOnly) {
      extensions.push(
        history(),
        dropCursor(),
        indentOnInput(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        autocompletion({ override: [completionSource(language, () => latest.current.completions ?? [])], activateOnTyping: true }),
        // Above the default keymap, which binds Mod-Enter to "insert blank line".
        Prec.highest(keymap.of([{ key: 'Mod-Enter', preventDefault: true, run: () => (latest.current.onRun?.(), true) }])),
        keymap.of([
          ...closeBracketsKeymap,
          ...historyKeymap,
          ...completionKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current.onChange?.(u.state.doc.toString());
        }),
      );
    }
    const v = new EditorView({ state: EditorState.create({ doc: value, extensions }), parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is rebuilt only when its mode changes; value is synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly, wrap, ariaLabel]);

  // Sync external value changes (e.g. the query builder writing a query).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return (
    <div
      ref={host}
      className={cx('overflow-hidden rounded-md border border-line [&_.cm-editor]:max-h-[var(--cm-max)] [&_.cm-editor]:min-h-[var(--cm-min)]', className)}
      style={{ ['--cm-max' as string]: `${maxHeight}px`, ['--cm-min' as string]: minHeight ? `${minHeight}px` : 'auto' }}
      data-language={language}
    />
  );
}
