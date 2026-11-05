/**
 * What happens on screen in the feature clips (clips.md): one short clip per feature,
 * each recorded as its own file. Every clip opens with c-card, which signs in as Priya
 * Shah (the demo's steward and owner), shows the clip's title and opens its page, so a
 * clip never depends on where the one before it ended.
 *
 * Like scenes.ts, every action drives the real app being recorded, and checks what its
 * paragraph claims.
 */
import { sleep } from './lib/director.ts';
import { SAMPLE, signInAs } from './features.ts';
import { apiJson, ringAround, type Ctx } from './scenes.ts';

type Action = (ctx: Ctx, ...args: string[]) => Promise<void>;

const o = (c: Ctx, p = '') => `${c.hub}/o/${c.ontology.id}${p}`;

/** The first answer in the interview: short enough to read in full as the use case's name. */
const ANSWER = 'We run a food bank and want our Saturday shifts listed on volunteering sites.';
/** Said on screen while the interview runs: recordings use Concord's offline stand-in for the AI model. */
const SCRIPTED_INTERVIEWER = 'In this recording the interviewer is Concord’s offline stand-in for the AI model, so its questions are scripted';

interface ChangeRequest {
  id: string;
  number: number;
  status: string;
  classification?: { level?: string };
  votes?: { userId: string; choice: string; stale?: boolean }[];
}

/** The demo's breaking change, "Allow only one location per session". */
async function majorChange(c: Ctx): Promise<ChangeRequest | undefined> {
  const list = (await apiJson(c, `/api/ontologies/${c.ontology.id}/change-requests`)) as ChangeRequest[] | { items: ChangeRequest[] } | undefined;
  const all = Array.isArray(list) ? list : (list?.items ?? []);
  const cr = all.find((x) => x.classification?.level === 'major' && /^(review|voting)$/.test(x.status));
  if (!cr) c.d.warn('The demo has no breaking change in review');
  return cr;
}

const currentVotes = async (c: Ctx, id: string) => (((await apiJson(c, `/api/change-requests/${id}`)) as ChangeRequest | undefined)?.votes ?? []).filter((v) => !v.stale);

let vote: { id: string; url: string; count?: number } | undefined;

export const clipActions: Record<string, Action> = {
  /** The clip's title over a blank screen, then its page (one of the ontology's tabs) underneath. */
  async 'c-card'(c, tab = '') {
    await c.d.label('');
    await signInAs(c, 'Priya Shah');
    await c.d.chapter({ eyebrow: 'Concord · Feature clip', title: c.scene?.title ?? 'Concord', sub: c.ontology.title }, 1700);
    await sleep(500);
    const url = tab === 'vote' ? vote?.url : o(c, tab ? `/${tab}` : '');
    if (!url) return c.d.warn('Nothing to open for this clip');
    await c.d.goto(url, { keepCard: true });
  },

  /* ---------------------------- validate ---------------------------- */
  async 'c-upload'(c) {
    const chooser = c.d.page.waitForEvent('filechooser', { timeout: 10_000 });
    if (!(await c.d.click(c.d.page.getByRole('button', { name: 'Upload a file' }), 'Upload a file', { settle: false }))) return;
    await (await chooser).setFiles({ name: 'northvale-shifts.ttl', mimeType: 'text/turtle', buffer: Buffer.from(SAMPLE) });
    await c.d.claimVisible(c.d.page.getByTestId('validate-editor').getByText('Saturday food bank shift'), 'the uploaded file is in the editor');
    await sleep(500);
    // The newest published release, not the working draft.
    const version = c.d.page.getByLabel('Version to validate against');
    const latest = await version.locator('option', { hasText: '(latest release)' }).first().getAttribute('value').catch(() => null);
    if (!latest) return c.d.warn('No published release to validate against');
    await c.d.pointAt(version, 'the version picker');
    await version.selectOption(latest);
    await c.d.highlight(version, 'the release picked');
  },
  async 'c-validate'(c) {
    await c.d.clearHighlight();
    if (!(await c.d.click(c.d.page.getByRole('button', { name: 'Validate', exact: true }), 'Validate'))) return;
    const verdict = c.d.page.getByTestId('validation-verdict');
    await c.d.claimVisible(verdict.getByText('1 violation'), 'the report finds the one problem');
    await c.d.claimVisible(c.d.page.getByTestId('validation-subtitle').getByText(/checked against v\d+\.\d+\.\d+$/), 'the data was checked against a release');
    const row = c.d.page.getByTestId('validation-results').getByRole('listitem').filter({ hasText: 'vol:minimumAge' }).last();
    await c.d.claimVisible(row, 'the problem is the minimum age');
    c.d.claim(/integer/i.test((await row.textContent().catch(() => '')) ?? ''), 'the report says the minimum age should be a number');
    await c.d.highlight(c.d.page.getByTestId('validation-results').getByRole('listitem').first(), 'the problem, under the record it is about');
  },
  async 'c-report-downloads'(c) {
    const turtle = c.d.page.getByRole('button', { name: 'SHACL report (Turtle)' });
    await c.d.pointAt(c.d.page.getByRole('button', { name: 'JSON', exact: true }), 'the JSON download');
    await sleep(700);
    await c.d.highlight(turtle, 'the SHACL report download');
  },
  async 'c-validate-api'(c) {
    await c.d.clearHighlight();
    if (!(await c.d.click(c.d.page.getByRole('button', { name: /Validate from your own code/ }), 'Validate from your own code'))) return;
    const example = c.d.page.getByTestId('validate-api-example').first();
    await c.d.claimVisible(example.getByText(/curl -X POST/), 'the example is a POST');
    await c.d.highlight(example, 'the curl example');
  },

  /* ---------------------------- interview ---------------------------- */
  async 'c-start-interview'(c) {
    if (!(await c.d.click(c.d.page.getByRole('button', { name: 'Describe a use case' }), 'Describe a use case'))) return;
    await c.d.page.waitForURL(/\/interview\//, { timeout: 15_000 }).catch(() => c.d.warn('The interview did not open'));
    await c.d.settle();
    await c.d.label(SCRIPTED_INTERVIEWER);
    await c.d.highlight(c.d.page.getByRole('log').or(c.d.page.getByText(/^Hi! I'm helping gather requirements/)).first(), 'the first question');
    await sleep(1200);
    await c.d.pointAt(c.d.page.getByRole('button', { name: 'Start voice input' }), 'the mic');
  },
  async 'c-answer'(c) {
    await c.d.clearHighlight();
    const box = c.d.page.getByPlaceholder(/Type your answer/);
    if (!(await c.d.type(box, ANSWER, 'the answer box', 30))) return;
    await c.d.page.keyboard.press('Enter');
    await c.d.claimVisible(c.d.page.getByText(/^Got it\./), 'the interviewer asks the next question', 20_000);
    // Back to the top first, so the layout switch isn't under the sticky header.
    await c.d.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await sleep(600);
    if (!(await c.d.click(c.d.page.getByRole('button', { name: 'Side by side' }), 'Side by side', { settle: false }))) return;
    const doc = c.d.page.getByRole('region', { name: 'Use case document' }).or(c.d.page.locator('section[aria-label="Use case document"]')).first();
    await c.d.claimVisible(doc.getByText(ANSWER).first(), 'the use case fills in from the answer');
    await c.d.claimVisible(doc.getByText(/^Not covered yet:/).first(), 'the document shows what is still to cover');
    await c.d.highlight(doc, 'the use case document');
  },
  async 'c-interview-privacy'(c) {
    const note = c.d.page.getByText(/This transcript is saved privately/);
    await c.d.claimVisible(note, 'the page says the transcript is private');
    c.d.claim(/stays private to you unless you choose to share it/.test((await note.textContent()) ?? ''), 'the use case stays private until shared');
    await c.d.highlight(note, 'the privacy note');
  },

  /* ----------------------------- meeting ----------------------------- */
  async 'c-add-meeting'(c) {
    if (!(await c.d.click(c.d.page.getByRole('button', { name: 'Add meeting' }), 'Add meeting', { settle: false }))) return;
    const upload = c.d.page.getByText('Upload a transcript', { exact: true });
    await c.d.claimVisible(upload, 'transcripts can be uploaded');
    await c.d.claimVisible(c.d.page.getByText(/^Invite the .*bot$/), 'a bot can be invited to the call');
    await ringAround(c, /^Invite the .*bot$/);
  },
  async 'c-open-meeting'(c) {
    await c.d.clearHighlight();
    await c.d.page.keyboard.press('Escape');
    await c.d.clearHighlight();
    const row = c.d.page.getByRole('main').getByRole('link').filter({ hasText: /Analysed/ }).first();
    if (!(await c.d.click(row, 'an analysed meeting'))) return;
    const produced = c.d.page.getByRole('list', { name: 'What the call produced' });
    for (const k of ['use cases', 'terms', 'competency questions', 'open questions']) await c.d.claimVisible(produced.getByText(k, { exact: true }), `the call produced ${k}`);
    await c.d.claimVisible(c.d.page.getByRole('heading', { name: 'Decisions' }), 'the call recorded decisions');
    await c.d.highlight(c.d.page.getByText('Decisions', { exact: true }).locator('xpath=ancestor::*[.//ul][1]').or(produced).first(), 'what the call produced');
  },
  async 'c-meeting-transcript'(c) {
    await c.d.clearHighlight();
    if (!(await c.d.click(c.d.page.getByRole('radio', { name: /^Transcript/ }), 'Transcript', { settle: false }))) return;
    // Lines that fed a use case carry its reference (WG-1).
    const line = c.d.page.getByRole('main').locator('li, div').filter({ has: c.d.page.getByRole('link', { name: /^WG-\d+$/ }) }).last();
    await c.d.claimVisible(line, 'transcript lines link to the use case they fed');
    await c.d.highlight(c.d.page.getByRole('link', { name: /^WG-\d+$/ }).first().locator('xpath=..'), 'a line that fed the use case');
  },

  /* ------------------------------ agents ----------------------------- */
  async 'c-agent-details'(c) {
    const details = c.d.page.getByText('Details and AI analysis').first();
    if (!(await c.d.click(details, 'Details and AI analysis', { settle: false }))) return;
    await c.d.claimVisible(c.d.page.getByText('Claude Code', { exact: false }).first(), 'the report came from Claude Code');
    await c.d.claimVisible(c.d.page.getByText(/FREQ=WEEKLY/).first(), 'the report is about weekly shifts');
    const covered = c.d.page.getByText(/^Possibly covered by existing terms/);
    await c.d.claimVisible(covered, 'triage suggests existing terms');
    await ringAround(c, /^Possibly covered by existing terms/);
  },
  async 'c-connect-agent'(c) {
    await c.d.clearHighlight();
    if (!(await c.d.click(c.d.page.getByRole('link', { name: 'Connect an agent' }).or(c.d.page.getByRole('button', { name: 'Connect an agent' })).first(), 'Connect an agent'))) return;
    const main = c.d.page.getByRole('main');
    await c.d.claimVisible(main.getByText(/Claude Code/).first(), 'the page covers Claude Code');
    await c.d.claimVisible(main.getByText(/\bMCP\b/).first(), 'the page covers MCP agents');
  },

  /* ------------------------------- vote ------------------------------ */
  async 'c-end-review'(c) {
    const cr = await majorChange(c);
    if (!cr) return;
    vote = { id: cr.id, url: o(c, `/changes/${cr.id}`) };
    // Move the simulated clock past the comment period, a day at a time, until the vote opens.
    let status = cr.status;
    for (let i = 0; i < 20 && status !== 'voting'; i++) {
      const r = await c.api.post(`${c.hub}/api/simulation/clock`, { data: { advanceDays: 1 } });
      if (!r.ok()) return c.d.warn(`Moving the clock: HTTP ${r.status()}`);
      status = ((await apiJson(c, `/api/change-requests/${cr.id}`)) as ChangeRequest | undefined)?.status ?? status;
    }
    c.d.claim(status === 'voting', 'the breaking change goes to a vote');
  },
  async 'c-vote-rules'(c) {
    await c.d.claimVisible(c.d.page.getByText(/^Quorum: .*50% needed/), 'the vote needs half the voters');
    await c.d.claimVisible(c.d.page.getByText(/^Threshold: 67% of yes\/no votes must be yes/), 'the vote needs two thirds yes');
    await ringAround(c, /^Still needed$/);
  },
  async 'c-vote-yes'(c) {
    await c.d.clearHighlight();
    if (!vote) return;
    // The simulated members vote first, out of shot; Priya's vote then refreshes the panel with every vote.
    const before = (await currentVotes(c, vote.id)).length;
    const r = await c.api.post(`${c.hub}/api/simulation/step`, { data: { ontologyId: c.ontology.id } });
    if (!r.ok()) return c.d.warn(`Simulating the others: HTTP ${r.status()}`);
    const others = (await currentVotes(c, vote.id)).length;
    c.d.claim(others > before, 'the simulated members vote');
    if (!(await c.d.click(c.d.page.getByRole('button', { name: 'Yes', exact: true }), 'Yes'))) return;
    let all = others;
    for (let i = 0; i < 20 && all <= others; i++, await sleep(300)) all = (await currentVotes(c, vote.id)).length;
    c.d.claim(all === others + 1, 'Priya’s vote is counted');
    vote.count = all;
    await c.d.claimVisible(c.d.page.getByText(/^You voted “yes”/), 'the page shows Priya voted yes');
  },
  async 'c-tally'(c) {
    if (!vote) return;
    await c.d.claimVisible(c.d.page.getByText(new RegExp(`^Quorum: ${vote.count}/\\d+ have voted`)), 'the turnout includes every vote');
    await ringAround(c, /^Turnout and threshold$/);
  },

  /* ---------------------------- governance --------------------------- */
  async 'c-pick-template'(c) {
    await c.d.clearHighlight();
    if (!(await c.d.click(c.d.page.getByRole('button', { name: 'Edit policy' }), 'Edit policy', { settle: false }))) return;
    const lazy = c.d.page.getByText('Lazy consensus (Apache / IETF style)');
    if (!(await c.d.click(lazy, 'the lazy consensus template', { settle: false }))) return;
    await c.d.claimVisible(c.d.page.getByText('Preview of unsaved changes'), 'the summary previews the template');
    await c.d.claimVisible(c.d.page.getByText(/Silence is consent/).first(), 'lazy consensus means silence is consent');
    await sleep(300);
    await c.d.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await sleep(700);
    await ringAround(c, 'Preview of unsaved changes');
  },
  async 'c-policy-rules'(c) {
    await c.d.clearHighlight();
    if (!(await c.d.click(c.d.page.getByText('Change request rules', { exact: true }), 'Change request rules', { settle: false }))) return;
    for (const k of ['Approver roles', 'Review period', 'Vote']) await c.d.claimVisible(c.d.page.getByText(k, { exact: true }).first(), `the rules include ${k}`);
    await ringAround(c, /^Approver roles$/);
  },
  async 'c-policy-banner'(c) {
    await c.d.clearHighlight();
    await c.d.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await sleep(700);
    await c.d.highlight(c.d.page.getByText(/^Editing the policy\. Nothing changes for anyone until you save/), 'the editing banner');
  },
  async 'c-discard'(c) {
    await c.d.clearHighlight();
    if (!(await c.d.click(c.d.page.getByRole('button', { name: 'Discard' }).first(), 'Discard'))) return;
    await c.d.claimVisible(c.d.page.getByRole('button', { name: 'Edit policy' }), 'the policy is left as it was');
  },
};
