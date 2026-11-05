import { useMemo } from 'react';
import { Marked, type Tokens } from 'marked';
import { cx } from './ui';

/** Escape raw HTML before markdown rendering so chat content can't inject markup. */
function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const attr = (s: string) => s.replace(/"/g, '&quot;');

/**
 * A link target that's safe to follow: http(s), mailto, or a link within the
 * site. Anything else (javascript:, data:, vbscript:, in any case and with
 * any whitespace a browser would ignore) is dropped.
 */
export function safeHref(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  // Browsers ignore control characters and whitespace when reading a scheme.
  const bare = href.replace(/&amp;/g, '&').replace(/[\u0000- \u007F]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(bare)?.[1]?.toLowerCase();
  return !scheme || ['http', 'https', 'mailto'].includes(scheme) ? href : undefined;
}

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    link(this: { parser: { parseInline: (t: Tokens.Generic[]) => string } }, token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      const href = safeHref(token.href);
      if (!href) return text;
      // In-page anchors (#uc-…, #req-…) stay in the same tab.
      const tab = href.startsWith('#') ? '' : ' target="_blank" rel="noreferrer"';
      return `<a${tab} href="${attr(href)}"${token.title ? ` title="${attr(token.title)}"` : ''}>${text}</a>`;
    },
    // No remote images: loading one would tell its server who is reading, and when. Shown as a link instead.
    image(token: Tokens.Image) {
      const label = token.text || 'image';
      const href = safeHref(token.href);
      return href ? `<a target="_blank" rel="noreferrer" href="${attr(href)}">${label}</a>` : label;
    },
  },
});

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => md.parse(escapeHtml(text ?? ''), { async: false }) as string, [text]);
  return <div className={cx('prose-chat text-sm leading-relaxed', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
