import { escapeHtml as esc } from './markdown.js';

/** The public report form, shared by the report page and the dialog on the specification page. */

export const REPORT_LIMITS = { title: 120, minDescription: 10, description: 4000, links: 3 };

export interface FormState {
  title?: string;
  description?: string;
  error?: string;
}

/** Where a member goes to report: sign in, then Browse opens the report dialog on this term. */
export const memberReportUrl = (base: string, slug: string, iri: string) =>
  `${base}/login?next=${encodeURIComponent(`/o/${encodeURIComponent(slug)}/browse?term=${encodeURIComponent(iri)}&report=1`)}`;

/**
 * The two ways to report, shared by the report page and the dialog on the
 * specification page (which fetches a fresh token when it opens).
 */
export function reportChoices(o: { action: string; iri: string; version: string; memberUrl: string; token?: string; state?: FormState; id?: (name: string) => string }) {
  const s = o.state ?? {};
  const id = o.id ?? ((n: string) => n);
  return `<div class="report-choices">
  <section class="choice" aria-labelledby="${id('report-member-h')}">
    <h3 id="${id('report-member-h')}">As a member</h3>
    <p>Sign in to report under your name, follow the discussion and take part in the decision. You come back to this term with the report form open.</p>
    <a class="btn btn-primary" data-member-report href="${esc(o.memberUrl)}">Sign in and report</a>
  </section>
  <section class="choice" aria-labelledby="${id('report-public-h')}">
    <h3 id="${id('report-public-h')}">As a member of the public</h3>
    <p>No account needed. The working group sees your report; it isn’t published, and you won’t get a reply.</p>
    <form class="report-form" method="post" action="${esc(o.action)}">
      ${s.error ? `<p class="notice warn" role="alert">${esc(s.error)}</p>` : '<p class="notice warn" role="alert" hidden></p>'}
      <input type="hidden" name="term" value="${esc(o.iri)}">
      <input type="hidden" name="version" value="${esc(o.version)}">
      <input type="hidden" name="token" value="${esc(o.token ?? '')}">
      <div class="hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>
      <label class="field"><span>Short title <span class="muted">(optional)</span></span><input name="title" maxlength="${REPORT_LIMITS.title}" value="${esc(s.title ?? '')}" placeholder="e.g. The definition is circular"></label>
      <label class="field"><span>What’s the problem?</span><textarea name="description" rows="5" required minlength="${REPORT_LIMITS.minDescription}" maxlength="${REPORT_LIMITS.description}" placeholder="What did you expect, and what did you find? An example helps.">${esc(s.description ?? '')}</textarea></label>
      <p class="small muted">Please don’t include personal information.</p>
      <button class="btn btn-primary" type="submit">Send report</button>
    </form>
  </section>
</div>`;
}

