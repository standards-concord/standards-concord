import { useMemo } from 'react';
import { marked } from 'marked';
import { cx } from './ui';

marked.setOptions({ gfm: true, breaks: true });

/** Escape raw HTML before markdown rendering so chat content can't inject markup. */
function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const out = marked.parse(escapeHtml(text ?? ''), { async: false }) as string;
    // Make links open in a new tab and drop javascript: URLs.
    // In-page anchors (#uc-…, #req-…) stay in the same tab.
    return out.replace(/<a href="(?!javascript:|#)/g, '<a target="_blank" rel="noreferrer" href="').replace(/href="javascript:[^"]*"/g, 'href="#"');
  }, [text]);
  return <div className={cx('prose-chat text-sm leading-relaxed', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
