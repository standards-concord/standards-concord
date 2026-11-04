import { Marked, type Tokens } from 'marked';

export const escapeHtml = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Links may point to the web, to anchors on the page or to the site itself. */
export const safeHref = (href: string) => /^(https?:|mailto:|#|\/(?!\/))/i.test(href.trim());

/**
 * Markdown for public pages. Raw HTML is shown as text, links are limited to
 * safe schemes and images become plain links, so content written by
 * contributors (or a model) can't inject markup or track readers.
 */
const md = new Marked({
  gfm: true,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text);
    },
    link(token: Tokens.Link) {
      const inner = this.parser.parseInline(token.tokens);
      if (!safeHref(token.href)) return inner;
      const external = /^https?:/i.test(token.href);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(token.href)}"${title}${external ? ' rel="noreferrer"' : ''}>${inner}</a>`;
    },
    image(token: Tokens.Image) {
      const text = escapeHtml(token.text || token.href);
      return safeHref(token.href) ? `<a href="${escapeHtml(token.href)}" rel="noreferrer">${text}</a>` : text;
    },
  },
});

export function renderMarkdown(text: string | undefined): string {
  if (!text?.trim()) return '';
  return md.parse(text, { async: false }) as string;
}
