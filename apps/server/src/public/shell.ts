import { PAGE_CSS } from './assets.js';
import { escapeHtml as esc } from './markdown.js';

/** Bump when refreshReleasePages must regenerate the stored release pages. */
export const PAGE_GENERATOR = 'Concord public page 11';

export const formatDate = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** Shared document and landmarks for the public catalogue and ontology pages. Content slots are escaped by their renderers. */
export function publicPage(input: {
  title: string;
  description: string;
  url: string;
  alternates: { mediaType: string; href: string; label: string }[];
  jsonLd: unknown;
  header: string;
  main: string;
  footer: string;
  mainId?: string;
  beforeMain?: string;
  script?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)}</title>
<meta name="description" content="${esc(input.description)}">
<meta name="generator" content="${PAGE_GENERATOR}">
<link rel="canonical" href="${esc(input.url)}">
${input.alternates.map((d) => `<link rel="alternate" type="${esc(d.mediaType)}" href="${esc(d.href)}" title="${esc(d.label)}">`).join('\n')}
<script type="application/ld+json">${JSON.stringify(input.jsonLd).replace(/</g, '\\u003c')}</script>
<style>${PAGE_CSS}</style>
</head>
<body>
<a class="skip" href="#${esc(input.mainId ?? 'main')}">Skip to content</a>
<header class="masthead">
  <div class="wrap">${input.header}</div>
</header>
${input.beforeMain ?? ''}
<main id="${esc(input.mainId ?? 'main')}" class="wrap">
  ${input.main}
</main>
<footer class="foot wrap">${input.footer}</footer>
${input.script ? `<script>${input.script}</script>` : ''}
</body>
</html>`;
}
