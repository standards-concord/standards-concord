import { useMemo } from 'react';
import { CopyButton, cx } from '../ui';
import { CodeEditor } from './CodeEditor';
import { highlightSegments } from './highlight';
import type { CodeLanguage } from './languages';

/** A read-only, highlighted code view with folding, search (Ctrl/⌘-F) and a copy button. */
export function CodeView({
  code,
  language,
  ariaLabel,
  maxHeight = 640,
  className,
  testId,
}: {
  code: string;
  language: CodeLanguage;
  ariaLabel: string;
  maxHeight?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cx('relative', className)}>
      <div className="absolute top-2 right-5 z-10">
        <CopyButton text={code} />
      </div>
      <CodeEditor value={code} language={language} readOnly ariaLabel={ariaLabel} maxHeight={maxHeight} className="rounded-none border-0" testId={testId} />
    </div>
  );
}

/** A small highlighted snippet rendered as plain spans (no editor), e.g. a competency question's SPARQL. */
export function HighlightedCode({ code, language, className }: { code: string; language: CodeLanguage; className?: string }) {
  const segments = useMemo(() => highlightSegments(code, language), [code, language]);
  return (
    <pre className={cx('overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-xs', className)} data-language={language}>
      <code>
        {segments.map((s, i) =>
          s.cls ? (
            <span key={i} className={s.cls}>
              {s.text}
            </span>
          ) : (
            s.text
          ),
        )}
      </code>
    </pre>
  );
}
