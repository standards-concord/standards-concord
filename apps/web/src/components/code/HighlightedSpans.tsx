import { useMemo } from 'react';
import { highlightSegments } from './highlight';
import type { CodeLanguage } from './languages';

/** Code as highlighted spans (no editor), for the inside of a <code>. No language means plain text. */
export function HighlightedSpans({ code, language }: { code: string; language?: CodeLanguage }) {
  const segments = useMemo(() => (language ? highlightSegments(code, language) : [{ text: code }]), [code, language]);
  return (
    <>
      {segments.map((s, i) =>
        s.cls ? (
          <span key={i} className={s.cls}>
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
    </>
  );
}
