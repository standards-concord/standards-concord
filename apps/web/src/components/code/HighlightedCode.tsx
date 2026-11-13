import { lazy, Suspense } from 'react';
import { pageChunk } from '../../lib/routeChunks';
import { cx } from '../ui';
import type { CodeLanguage } from './languages';

const HighlightedSpans = lazy(pageChunk('highlighted-code', () => import('./HighlightedSpans').then((m) => ({ default: m.HighlightedSpans }))));

/** A small highlighted snippet rendered as plain spans (no editor), e.g. a competency question's SPARQL. */
export function HighlightedCode({ code, language, className }: { code: string; language: CodeLanguage; className?: string }) {
  return (
    <pre className={cx('overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-xs', className)} data-language={language}>
      <code>
        <Suspense fallback={code}><HighlightedSpans code={code} language={language} /></Suspense>
      </code>
    </pre>
  );
}
