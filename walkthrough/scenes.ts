/**
 * What happens on screen. Each action is named in narration.md as [do: name args].
 *
 * Actions drive the real app: hub pages are the live Concord being recorded, the
 * terminal's MCP tool results come from real calls to it, and the sample app's code is
 * really edited and reloaded. Only the Claude Code chrome and its words are scripted,
 * so every recording says the same thing in the same order.
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { request, type APIRequestContext } from '@playwright/test';
import { sleep, type Director } from './lib/director.ts';
import type { McpClient } from './lib/mcp.ts';
import { fill } from './lib/servers.ts';
import { countChanges, lineDiff, type Terminal } from './lib/terminal.ts';

export interface Ctx {
  d: Director;
  term: Terminal;
  mcp: McpClient;
  api: APIRequestContext;
  /** The hub as the browser reaches it (local while recording). */
  hub: string;
  /** The hub as shown in code and the terminal, e.g. https://standards-concord.vercel.app */
  shownHub: string;
  ontology: { id: string; slug: string; title: string };
  features: Set<string>;
  app: {
    url: string;
    dir: string;
    sampleDir: string;
    /** The JS classes module the app imports, as shown in its code. */
    classes: string;
  };
  /** Rewrites local URLs in text to the hub URL shown on screen. */
  shown: (text: string) => string;
  /** Things the video must say on screen about how it was made. */
  notices: { classesStandIn: boolean; publishing?: boolean };
  state: {
    token?: string;
    fork?: { id?: string; slug?: string; iri?: string; appUrl?: string; js?: string };
    changeRequest?: { id: string; url?: string; number?: number };
    releaseJs?: string;
  };
}

type Action = (ctx: Ctx, ...args: string[]) => Promise<void>;

const FORK_NAME = 'activity-tracking';
const PROMPT = 'Volunteers want to log the hours they give. Add a "Log hours" button to each opportunity, and show the total hours per opportunity. Use the Concord volunteering standard for the data.';
const VA = 'vol:VolunteeringActivity';
const FORK_TERM_LIST = [
  { action: 'add', kind: 'class', localName: 'VolunteeringActivity', label: 'volunteering activity', definition: 'A period of time that a volunteer actually gave to a volunteering opportunity.' },
  { action: 'add', kind: 'datatypeProperty', localName: 'hoursVolunteered', label: 'hours volunteered', definition: 'The number of hours a volunteer gave in a volunteering activity.', domain: [VA], range: ['xsd:decimal'], characteristics: ['functional'] },
  { action: 'add', kind: 'objectProperty', localName: 'activityBy', label: 'activity by', definition: 'Relates a volunteering activity to the volunteer who gave the time.', domain: [VA], range: ['vol:Volunteer'], characteristics: ['functional'] },
  { action: 'add', kind: 'objectProperty', localName: 'activityFor', label: 'activity for', definition: 'Relates a volunteering activity to the volunteering opportunity the time was given to.', domain: [VA], range: ['vol:VolunteeringOpportunity'], characteristics: ['functional'] },
  { action: 'add', kind: 'datatypeProperty', localName: 'activityDate', label: 'activity date', definition: 'The day on which the time in a volunteering activity was given.', domain: [VA], range: ['xsd:date'], characteristics: ['functional'] },
];
const FORK_TERMS =
  'Add a class VolunteeringActivity, defined as "a period of time that a volunteer actually gave to a volunteering opportunity", with: datatype property hoursVolunteered (xsd:decimal, functional) for the number of hours given; object property activityBy (range Volunteer, functional) for the volunteer who gave the time; object property activityFor (range VolunteeringOpportunity, functional) for the opportunity the time was given to; datatype property activityDate (xsd:date, functional) for the day the time was given.';

const FORMAT_TABS: Record<string, RegExp> = { turtle: /^Turtle$/, linkml: /^LinkML$/, shacl: /^SHACL( shapes)?$/, shaclc: /SHACLC|compact/i, typescript: /^Classes$/, jsonld: /^JSON-LD$/, manchester: /^Manchester$/ };

const CHAPTERS: Record<string, { eyebrow: string; title: string; sub?: string; at: (c: Ctx) => string }> = {
  developer: { eyebrow: 'Part two', title: 'Building with the standard', sub: 'A coding agent, a missing concept, and a fork so nobody is blocked.', at: (c) => c.app.url },
};

const o = (c: Ctx, p = '') => `${c.hub}/o/${c.ontology.id}${p}`;

/** What each format view must contain for the narration about it to be true. */
const FORMAT_MARKERS: Record<string, RegExp> = { turtle: /@prefix|owl:Class/, linkml: /classes:/, shacl: /sh:NodeShape/, shaclc: /\bshape\s+\S+\s*->/, typescript: /\bclass\s+\w+/ };

async function apiJson(c: Ctx, p: string): Promise<any> {
  const res = await c.api.get(`${c.hub}${p}`);
  if (!res.ok()) {
    c.d.warn(`GET ${p}: HTTP ${res.status()}`);
    return undefined;
  }
  return res.json();
}

/** Checks the format view shows what the narration says it does. */
async function claimFormat(c: Ctx, format: string) {
  const marker = FORMAT_MARKERS[format];
  if (!marker) return;
  const ok = await c.d.page
    .waitForFunction((src) => new RegExp(src[0], src[1]).test(document.querySelector('main')?.textContent ?? ''), [marker.source, marker.flags], { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  c.d.claim(ok, `the ${format} view shows ${format} (${marker})`);
}

/** The app is showing opportunities, and the hours feature where the story says it should. */
async function claimAppWorks(c: Ctx, withHours: boolean) {
  await c.d.claimVisible(c.d.page.locator('.card'), 'the sample app lists opportunities');
  if (withHours) await c.d.claimVisible(c.d.page.locator('.pill.hours'), 'the sample app shows hours given');
}

const STAND_IN = 'Preview: this hub doesn’t serve generated classes yet, so a stand-in module with the same shape is used';

/** Opens the sample app, labelling it if it runs on stand-in classes. */
async function gotoApp(c: Ctx, opts: { keepCard?: boolean } = {}) {
  await c.d.goto(c.app.url, opts);
  if (c.notices.classesStandIn) await c.d.label(STAND_IN);
}

/** Shows a URL, or if we're already there (e.g. under a chapter card), reveals it. */
async function show(c: Ctx, url: string) {
  if (c.d.page.url() === url) await c.d.page.evaluate(() => (window as any).__wt?.hideChapter()).catch(() => {});
  else await c.d.goto(url);
  await c.d.clearHighlight();
}

/** On a change request: the level badge opens the classification reasons; validation is in the Checks view. */
async function showClassificationAndChecks(c: Ctx) {
  if (await c.d.click(c.d.page.getByRole('button', { name: /^Level: / }), 'the level badge')) {
    await ringAround(c, /Rule-based semantic versioning classification/);
    await sleep(3000);
    await c.d.page.keyboard.press('Escape');
    await c.d.clearHighlight();
  }
  await c.d.click(c.d.page.getByRole('tab', { name: /Checks/ }), 'the Checks tab');
  await ringAround(c, /^Validation$/);
}

/** Rings the card or section that contains some text. */
async function ringAround(c: Ctx, text: string | RegExp, tag?: string) {
  const el = await c.d.find(c.d.page.getByText(text), `text ${text}`);
  if (!el) return;
  const box = await el.evaluate((node) => {
    let n: HTMLElement | null = node as HTMLElement;
    while (n && n.parentElement) {
      const r = n.getBoundingClientRect();
      if (r.height >= 110 && r.width >= 280) break;
      n = n.parentElement;
    }
    n?.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    const r = (n ?? (node as HTMLElement)).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, innerHeight - r.y - 24) };
  });
  await c.d.page.evaluate(([b, t]) => (window as any).__wt?.highlight(b, t), [box, tag] as const);
}

function summariseTerms(json: any): string {
  if (!Array.isArray(json) || !json.length) return 'No matching terms';
  return json
    .slice(0, 6)
    .map((t: any) => `${t.id ?? t.iri}  ${t.kind ? `(${t.kind}) ` : ''}${t.label ?? ''}`.trim())
    .join('\n');
}

function compactJson(json: any, keys: string[]): string {
  if (!json || typeof json !== 'object') return String(json ?? '');
  return keys
    .filter((k) => json[k] !== undefined && json[k] !== null)
    .map((k) => `${k}: ${typeof json[k] === 'object' ? JSON.stringify(json[k]) : json[k]}`)
    .join('\n');
}

async function mcpCall(c: Ctx, tool: string, args: Record<string, unknown>, argsShown: string) {
  await c.term.tool(`concord - ${tool} (MCP)`, argsShown);
  await c.term.think(900, 'Running');
  const r = await c.mcp.call(tool, args);
  if (r.isError) c.d.warn(`MCP ${tool} returned an error: ${r.text.slice(0, 200)}`);
  return r;
}

async function editApp(c: Ctx, next: string, summary?: string) {
  const file = path.join(c.app.dir, 'app.js');
  const before = await readFile(file, 'utf8');
  const rows = lineDiff(before, next);
  await c.term.diff('app.js', summary ?? countChanges(rows), rows.map((r) => ({ ...r, s: c.shown(r.s) })));
  await writeFile(file, next);
}

function forkJsUrl(c: Ctx) {
  const f = c.state.fork;
  if (f?.js) return f.js;
  const iri = f?.iri ?? `${c.shownHub}/def/${c.ontology.slug}/forks/${f?.slug ?? FORK_NAME}`;
  return `${c.shown(iri).replace(/\.(ttl|jsonld|rdf)$/, '')}.js`;
}

export const actions: Record<string, Action> = {
  /* ------------------------------- hub ------------------------------- */
  async 'title-card'(c) {
    // The card stays up across the navigation, then open-hub fades it to reveal the hub.
    await c.d.chapter({ eyebrow: 'prototype', title: 'Concord', sub: 'Designing data standards together, in the open.' }, 0);
    await sleep(900);
    await c.d.goto(`${c.hub}/`, { keepCard: true });
  },
  async 'open-hub'(c) {
    await show(c, `${c.hub}/`);
  },
  async 'point-hub-card'(c) {
    const card = c.d.page.getByRole('link', { name: new RegExp(c.ontology.title, 'i') });
    await c.d.pointAt(card, 'the volunteering card on the hub');
    await c.d.highlight(card, 'the volunteering card');
  },
  async 'open-overview'(c) {
    await c.d.clearHighlight();
    const card = c.d.page.getByRole('link', { name: new RegExp(c.ontology.title, 'i') });
    if (!(await c.d.click(card, 'the volunteering card'))) await c.d.goto(o(c));
  },
  async 'highlight-health'(c) {
    // "Strict OWL, and a reasoner keeps them logically consistent."
    const v = await apiJson(c, `/api/ontologies/${c.ontology.id}/validation`);
    c.d.claim(v?.reasoner?.consistent === true, 'the reasoner reports the working draft consistent');
    c.d.claim(v && !(v.lint ?? []).some((i: any) => i.severity === 'error'), 'strict lint has no errors');
    await ringAround(c, 'Health of the working draft');
  },
  async 'highlight-members'(c) {
    await ringAround(c, /^Members/);
  },
  async 'clear-highlight'(c) {
    await c.d.clearHighlight();
  },
  async 'open-browse'(c) {
    await c.d.goto(o(c, '/browse'));
    await sleep(600);
    await c.d.click(c.d.page.getByText(/^volunteering opportunity$/i), 'the VolunteeringOpportunity class');
  },
  async 'open-formats'(c, format = 'turtle') {
    await c.d.goto(o(c, `/source?format=${format}`));
    await claimFormat(c, format);
    await sleep(800);
    await c.d.scroll(320, 1600);
  },
  async 'show-format'(c, format) {
    const name = FORMAT_TABS[format] ?? new RegExp(format, 'i');
    await c.d.scroll(-2000, 400);
    // Formats are a labelled dropdown: point at it, then pick the format.
    const select = c.d.page.getByLabel('Format', { exact: true });
    const labels = (await select.locator('option').allTextContents().catch(() => [] as string[])).map((t) => t.trim());
    const label = labels.find((t) => name.test(t));
    if (!label) c.d.warn(`Could not find the ${format} format`);
    else if (await c.d.pointAt(select, 'the Format dropdown')) {
      await select.selectOption({ label });
      await c.d.settle();
    }
    await claimFormat(c, format);
    await sleep(700);
    await c.d.scroll(260, 1400);
  },
  async 'open-query'(c) {
    await c.d.goto(o(c, '/query'));
  },
  async 'ask-query'(c) {
    // Describe the query in the chat: the first suggestion lists the main records.
    const chip = c.d.page.getByTestId('query-suggestions').getByRole('button');
    if (!(await c.d.click(chip, 'a suggested question', { settle: false }))) return;
    // The assistant's query runs only when the person presses Run, after reading it.
    const prompt = c.d.page.getByTestId('query-run-prompt');
    await prompt.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => c.d.warn('The query assistant wrote no query'));
    await sleep(600);
    await c.d.highlight(c.d.page.getByTestId('sparql-editor'), 'the SPARQL it wrote');
    await sleep(900);
    await c.d.clearHighlight();
    if (!(await c.d.click(prompt.getByRole('button', { name: 'Run this query' }), 'Run this query', { settle: false }))) return;
    await c.d.claimVisible(c.d.page.locator('[data-testid="query-results"] tbody tr'), 'the query returns rows', 20_000);
    await sleep(600);
    await c.d.scroll(380, 1500);
  },
  async 'open-use-cases'(c) {
    await c.d.goto(o(c, '/use-cases'));
    const first = c.d.page.getByRole('main').getByRole('link').filter({ hasText: /\w{6,}/ });
    await c.d.pointAt(first, 'a use case');
  },
  async 'open-meetings'(c) {
    await c.d.goto(o(c, '/meetings'));
  },
  async 'open-changes'(c) {
    await c.d.goto(o(c, '/changes'));
  },
  async 'open-first-change'(c) {
    const link = c.d.page.getByRole('main').locator(`a[href*="/changes/"]`);
    if (!(await c.d.click(link, 'the first change request'))) return;
    await sleep(500);
    await showClassificationAndChecks(c);
  },
  async 'highlight-governance-card'(c) {
    await ringAround(c, /^Decision$/);
  },
  async 'open-governance'(c) {
    await c.d.goto(o(c, '/governance'));
    await sleep(600);
    await ringAround(c, /Policy template/);
  },
  async 'open-releases'(c) {
    await c.d.goto(o(c, '/releases'));
    await c.d.claimVisible(c.d.page.getByRole('main').getByText(/\b\d+\.\d+\.\d+\b/), 'a release with a semantic version');
  },
  async chapter(c, name) {
    const ch = CHAPTERS[name];
    if (!ch) return c.d.warn(`No chapter "${name}"`);
    await c.d.chapter({ eyebrow: ch.eyebrow, title: ch.title, sub: ch.sub }, 0);
    await sleep(900);
    if (ch.at(c) === c.app.url) await gotoApp(c, { keepCard: true });
    else await c.d.goto(ch.at(c), { keepCard: true });
  },

  /* ------------------------------- app ------------------------------- */
  async 'open-app'(c) {
    if (c.d.page.url() === c.app.url) await show(c, c.app.url);
    else await gotoApp(c);
    await sleep(500);
    await c.d.pointAt(c.d.page.locator('.card').first(), 'an opportunity card');
  },
  async 'show-app-code'(c) {
    await c.term.open();
    await c.term.title('helping-hands — zsh');
    await c.term.shell('head -n 13 app.js');
    const src = await readFile(path.join(c.app.dir, 'app.js'), 'utf8');
    await c.term.print(c.shown(src.split('\n').slice(0, 13).join('\n')));
  },

  /* ---------------------------- Claude Code ---------------------------- */
  async 'install-mcp'(c) {
    await c.term.open();
    const oauth = c.features.has('connectPage');
    const cmd = `claude mcp add --transport http concord ${c.shownHub}/mcp${oauth ? '' : ' --header "Authorization: Bearer cnc_••••••••"'}`;
    await c.term.shell(cmd, { cps: 28 });
    await c.mcp.connect();
    await c.term.print(`Added HTTP MCP server concord with URL: ${c.shownHub}/mcp to local config`);
    await sleep(400);
    await c.term.shell('claude mcp list');
    await c.term.print(`Checking MCP server health…\n\nconcord: ${c.shownHub}/mcp (HTTP) - ✓ Connected`);
  },
  async 'open-connect-page'(c) {
    await c.d.goto(`${c.hub}/connect`);
  },
  async 'start-claude'(c) {
    await c.term.open();
    await c.term.shell('claude');
    await c.term.blank();
    await c.term.startAgent({ cwdPath: '~/code/helping-hands' });
  },
  async 'ask-feature'(c) {
    await c.term.open();
    await c.term.ask(PROMPT, { cps: 45 });
  },
  async 'claude-searches'(c) {
    await c.term.think(1200);
    await c.term.say("I'll check what the volunteering standard already has for recording hours.");
    const r = await mcpCall(c, 'search_terms', { ontology: c.ontology.slug, query: 'hours' }, `ontology: "${c.ontology.slug}", query: "hours"`);
    await c.term.result(c.shown(summariseTerms(r.json) || r.text));
    const hit = Array.isArray(r.json) ? r.json[0] : undefined;
    c.d.claim(/hoursPerWeek/i.test(JSON.stringify(r.json ?? r.text)), 'the search finds hours per week');
    const term = hit?.id ?? 'vol:hoursPerWeek';
    const g = await mcpCall(c, 'get_term', { ontology: c.ontology.slug, term }, `ontology: "${c.ontology.slug}", term: "${term}"`);
    await c.term.result(c.shown(compactJson(g.json, ['label', 'definition', 'domain', 'range']) || g.text), { max: 6 });
  },
  async 'claude-explains-gap'(c) {
    await c.term.say(
      'hoursPerWeek describes the time a role expects (a TimeCommitment), not time a volunteer actually gave. The standard has no concept for logged hours yet, so I need a new class for it.',
    );
  },
  async 'claude-creates-fork'(c) {
    await c.term.say("Rather than block on the working group, I'll create a development fork of the standard and add the term there.");
    const r = await mcpCall(c, 'create_fork', { ontology: c.ontology.slug, name: FORK_NAME, purpose: 'Log the hours volunteers give in Helping Hands' }, `ontology: "${c.ontology.slug}", name: "${FORK_NAME}"`);
    const j = r.json ?? {};
    c.d.claim(j.fork || j.id, 'create_fork made a fork');
    c.state.fork = { id: j.id, slug: (j.fork as string | undefined)?.split('/')[1] ?? j.slug ?? FORK_NAME, iri: j.iri, appUrl: j.appUrl, js: j.importUrls?.js ?? j.importUrls?.javascript };
    await c.term.result(c.shown(compactJson(j, ['fork', 'version', 'iri', 'appUrl']) || r.text), { max: 6 });
  },
  async 'claude-edits-fork'(c) {
    const fork = c.state.fork?.id ?? `${c.ontology.slug}/${FORK_NAME}`;
    const names = FORK_TERM_LIST.map((t) => t.localName).join(', ');
    const r = await mcpCall(c, 'edit_fork', { fork, terms: FORK_TERM_LIST, message: 'Add VolunteeringActivity for logging volunteer hours' }, `fork: "${c.ontology.slug}/${c.state.fork?.slug ?? FORK_NAME}", terms: [${names}]`);
    const j = r.json ?? {};
    const added = Array.isArray(j.added) ? j.added.map((t: any) => `+ ${t.term ?? t.iri}  (${t.kind ?? t.change ?? ''})`).join('\n') : '';
    c.d.claim(Array.isArray(j.added) && j.added.length, 'edit_fork added the new terms');
    // Only an explicit pass counts: a missing or partial validation result is not a pass.
    const passed = j.validation?.passed === true && j.validation?.consistent !== false;
    c.d.claim(passed, `the fork validates after the edit (got ${JSON.stringify(j.validation ?? null)})`);
    const valid = j.validation ? `\nValidation: ${passed ? 'passed' : 'failed'}${j.validation.consistent === false ? ' (inconsistent)' : ''}` : '';
    await c.term.result(c.shown((added ? added + valid : '') || r.text), { max: 8 });
  },
  async 'open-fork-page'(c) {
    const url = c.state.fork?.appUrl ? c.state.fork.appUrl.replace(c.shownHub, c.hub) : o(c, `/forks/${c.state.fork?.slug ?? FORK_NAME}`);
    await c.d.goto(url.startsWith('http') ? url : `${c.hub}${url}`);
    await c.d.claimVisible(c.d.page.getByRole('main').getByText(/VolunteeringActivity|volunteering activity/i), 'the fork page lists the new class');
  },
  async 'claude-proposes-fork'(c) {
    await c.term.open();
    const fork = c.state.fork?.id ?? `${c.ontology.slug}/${FORK_NAME}`;
    const r = await mcpCall(c, 'propose_fork', { fork, title: 'Record the hours volunteers give', description: 'Helping Hands needs to record time volunteers actually gave, per opportunity, to show impact. hoursPerWeek on TimeCommitment is expected time, not given time.' }, `fork: "${c.state.fork?.slug ?? FORK_NAME}"`);
    const cr = r.json?.changeRequest ?? r.json ?? {};
    if (cr.id) c.state.changeRequest = { id: cr.id, url: cr.url, number: cr.number };
    c.d.claim(cr.id, 'propose_fork opened a change request');
    await c.term.result(c.shown(compactJson(cr, ['number', 'title', 'status', 'level', 'validationPassed', 'url']) || r.text), { max: 6 });
  },
  async 'claude-proposes-change'(c) {
    const r = await mcpCall(
      c,
      'propose_change',
      { ontology: c.ontology.slug, title: 'Record the hours volunteers give', description: `${FORK_TERMS}\n\nContext: Helping Hands needs to record time volunteers actually gave, per opportunity. hoursPerWeek on TimeCommitment is expected time, not given time.` },
      `ontology: "${c.ontology.slug}", title: "Record the hours volunteers give"`,
    );
    const j = r.json ?? {};
    if (j.id) c.state.changeRequest = { id: j.id, url: j.url, number: j.number };
    c.d.claim(j.id, 'propose_change opened a change request');
    await c.term.result(c.shown(compactJson(j, ['number', 'title', 'status', 'level', 'url']) || r.text), { max: 6 });
  },
  async 'show-fork-module'(c) {
    const url = forkJsUrl(c);
    await c.d.goto(url, { settle: false });
    await sleep(500);
    c.d.claim(/class VolunteeringActivity\b/.test((await c.d.page.textContent('body').catch(() => '')) ?? ''), 'the fork module has a VolunteeringActivity class');
    await c.d.page.evaluate(() => (window as any).find?.('class VolunteeringActivity')).catch(() => {});
  },
  async 'claude-switches-import'(c) {
    await c.term.open();
    const url = forkJsUrl(c);
    await c.term.say(`I'll point the app's import at the fork, which serves the same generated classes plus VolunteeringActivity.`);
    const file = path.join(c.app.dir, 'app.js');
    const before = await readFile(file, 'utf8');
    c.app.classes = url;
    await editApp(c, before.replace(/from "[^"]+\/def\/[^"]+\.js";/, `from "${url}";`));
  },
  async 'claude-writes-feature'(c) {
    await c.term.say('Now the feature: total hours per opportunity, a running total for the signed-in volunteer, and a "Log hours" form that records a VolunteeringActivity.');
    const next = fill(await readFile(path.join(c.app.sampleDir, 'feature/app.js'), 'utf8'), { CLASSES: c.app.classes, HUB: c.shownHub });
    await editApp(c, next);
    await copyFile(path.join(c.app.sampleDir, 'feature/data/activities.ttl'), path.join(c.app.dir, 'data/activities.ttl'));
    await c.term.html('<span class="bold">Write</span><span class="dim">(data/activities.ttl)</span>', 'bullet tool');
    await c.term.result('Wrote 11 lines to data/activities.ttl');
    await c.term.say('Done. Each opportunity shows the hours given, and volunteers can log time with "Log hours". Reload the app to try it.');
  },
  async 'open-app-feature'(c) {
    await gotoApp(c);
    await claimAppWorks(c, true);
    await c.d.claimVisible(c.d.page.locator('#impact'), 'a running total at the top');
    await sleep(400);
    await c.d.highlight(c.d.page.locator('.pill.hours'), 'hours given');
    await sleep(2200);
    await c.d.highlight(c.d.page.locator('#impact'), 'your impact');
  },
  async 'log-hours'(c) {
    await c.d.clearHighlight();
    const card = c.d.page.locator('.card').filter({ hasText: /Food bank/i });
    await c.d.click(card.getByRole('button', { name: 'Log hours' }), 'the Log hours button', { settle: false });
    await sleep(300);
    await c.d.type(card.getByRole('spinbutton', { name: 'Hours' }), '2', 'the hours field', 6);
    await sleep(300);
    // "The totals update straight away": both the opportunity's total and mine.
    const num = async (l: import('@playwright/test').Locator) => Number(((await l.first().textContent({ timeout: 500 }).catch(() => '')) ?? '').match(/(\d+(?:\.\d+)?)/)?.[1] ?? 0);
    const mine = () => num(c.d.page.locator('#impact'));
    // The list re-renders on save, so find the card again each time.
    const given = () => num(c.d.page.locator('.card').filter({ hasText: /Food bank/i }).locator('.pill.hours'));
    const before = { mine: await mine(), given: await given() };
    await c.d.click(card.getByRole('button', { name: 'Save' }), 'the Save button', { settle: false });
    let after = before;
    for (let i = 0; i < 20 && (after.mine === before.mine || after.given === before.given); i++) {
      await sleep(100);
      after = { mine: await mine(), given: await given() };
    }
    c.d.claim(after.mine === before.mine + 2, `my running total goes up by 2 hours (${before.mine} → ${after.mine})`);
    c.d.claim(after.given === before.given + 2, `the food bank's hours given go up by 2 (${before.given} → ${after.given})`);
    await sleep(500);
    await c.d.highlight(c.d.page.locator('#impact'), 'updated');
  },

  /* --------------------------- governance ---------------------------- */
  async 'open-proposed-change'(c) {
    const cr = c.state.changeRequest;
    if (!cr) {
      c.d.warn('No change request was proposed earlier in the recording');
      await c.d.goto(o(c, '/changes'));
      return;
    }
    // "Classified as a minor change, because it only adds terms, and the validation has passed."
    const detail = await apiJson(c, `/api/change-requests/${cr.id}`);
    c.d.claim(detail?.classification?.level === 'minor', `the change is classified minor (got ${detail?.classification?.level})`);
    c.d.claim(detail?.validation?.passed === true, 'validation passed on the proposed change');
    await c.d.goto(o(c, `/changes/${cr.id}`));
    await sleep(500);
    await showClassificationAndChecks(c);
  },
  async 'open-app-checks'(c) {
    await c.d.goto(o(c, '/apps'));
    // Other people's apps: the demo seeds one whose owner runs it on autopilot.
    await c.d.highlight(c.d.page.getByText('Autopilot on', { exact: true }), 'an app on autopilot', 'autopilot on');
    await sleep(2500);
    await c.d.clearHighlight();
    // Connect Helping Hands and switch autopilot on.
    await c.d.type(c.d.page.getByRole('textbox', { name: /App name/i }), 'Helping Hands', 'the App name field');
    await c.d.click(c.d.page.getByRole('button', { name: /^Connect app$/i }), 'the Connect app button');
    await sleep(600);
    await c.d.click(c.d.page.getByRole('switch', { name: /Autopilot/i }), 'the autopilot switch');
  },
  async 'post-app-check'(c) {
    const cr = c.state.changeRequest;
    if (!cr) return c.d.warn('The autopilot scene needs the change request proposed earlier');
    // Another app owner (a reviewer persona, not the change's author) connects an app with
    // autopilot on, and their CI reports a pass against the proposed change, as the
    // actions/app-check GitHub Action would.
    const api = await request.newContext();
    try {
      const personas = (await (await api.get(`${c.hub}/api/personas`)).json()) as { id: string; name: string; roles: string[] }[];
      const reviewer = personas.find((p) => p.roles.includes('reviewer') && !p.roles.includes('steward')) ?? personas[0];
      await api.post(`${c.hub}/api/auth/demo`, { data: { userId: reviewer.id } });
      const app = await api.post(`${c.hub}/api/ontologies/${c.ontology.id}/apps`, { data: { name: 'Volunteer rota planner', autopilot: { enabled: true } } });
      if (!app.ok()) return c.d.warn(`Connecting an app failed: ${app.status()}`);
      const token = ((await app.json()) as { token: string }).token;
      const headers = { authorization: `Bearer ${token}` };
      const pending = (await (await api.get(`${c.hub}/api/app-checks/pending`, { headers })).json()) as { baseline?: { revision: string }; targets?: { changeRequestId: string; revision: string }[] };
      if (pending.baseline) await api.post(`${c.hub}/api/app-checks`, { headers, data: { target: 'baseline', revision: pending.baseline.revision, outcome: 'passed' } });
      const target = pending.targets?.find((t) => t.changeRequestId === cr.id);
      if (!target) return c.d.warn('The proposed change is not listed for app checks');
      const res = await api.post(`${c.hub}/api/app-checks`, { headers, data: { target: cr.id, revision: target.revision, outcome: 'passed', runUrl: 'https://github.com/example/rota-planner/actions/runs/1' } });
      const body = await res.text();
      if (!res.ok()) c.d.warn(`POST /api/app-checks: ${res.status()} ${body.slice(0, 200)}`);
      else if (!/"action":"(approved|voted)/.test(body)) c.d.warn(`Autopilot did not act: ${JSON.stringify(JSON.parse(body).autopilot)}`);
    } finally {
      await api.dispose();
    }
    // App checks are in the change request's Checks view; the autopilot vote is in Discussion.
    await c.d.goto(o(c, `/changes/${cr.id}?view=checks`));
    await c.d.label('Simulated CI: a passing test run was reported to Concord for this demo');
    await ringAround(c, /^App checks$/);
    await sleep(3000);
    await c.d.click(c.d.page.getByRole('tab', { name: /Discussion/ }), 'the Discussion tab');
    await c.d.highlight(c.d.page.getByText('Autopilot', { exact: true }), 'the Autopilot badge', 'autopilot voted yes');
  },
  async 'land-upstream'(c) {
    const cr = c.state.changeRequest;
    if (!cr) return c.d.warn('No change request to land');
    const published = async () => ((await apiJson(c, `/api/ontologies/${c.ontology.id}/releases`)) ?? []).filter((r: any) => r.status === 'published').length;
    const before = await published();
    await landChange(c, cr.id);
    const after = await published();
    c.d.claim(after > before, 'a new release was published');
    await c.d.goto(o(c, '/releases'));
  },
  async 'new-session-check'(c) {
    await c.term.open();
    await c.term.blank();
    await c.term.shell('claude');
    await c.term.blank();
    await c.term.startAgent({ cwdPath: '~/code/helping-hands' });
    await c.term.think(800);
    const r = await mcpCall(c, 'check_forks', {}, '');
    const j = r.json;
    const forks = (Array.isArray(j) ? j : [j]).filter(Boolean);
    const mine = forks.find((f: any) => String(f.fork ?? '').endsWith(`/${c.state.fork?.slug ?? FORK_NAME}`)) ?? forks[0];
    if (!mine || !/switch-to-(release|draft)/.test(mine.outcome ?? '')) c.d.warn(`check_forks did not suggest switching back (outcome: ${mine?.outcome})`);
    const to = (mine?.replace ?? []).map((x: any) => x.to as string).find((u: string) => u && !/\.(ttl|jsonld|rdf|owl|nt)$/.test(u));
    if (to) c.state.releaseJs = to.endsWith('.js') ? to : `${to}.js`;
    const lines = [mine?.message, ...(mine?.replace ?? []).slice(0, 2).map((x: any) => `replace ${x.from}\n   with ${x.to}`)].filter(Boolean).join('\n');
    await c.term.result(c.shown(lines || r.text), { max: 8 });
    await c.term.say(`Good news: VolunteeringActivity is now in the released volunteering standard. Your app can move off the fork. Want me to switch the import back?`);
    await c.term.ask('Yes please', { cps: 20 });
  },
  async 'claude-migrates'(c) {
    const target = c.shown(c.state.releaseJs ?? `${c.shownHub}/def/${c.ontology.slug}.js`);
    const file = path.join(c.app.dir, 'app.js');
    const before = await readFile(file, 'utf8');
    c.app.classes = target;
    await editApp(c, before.replace(/from "[^"]+\/def\/[^"]+\.js";/, `from "${target}";`));
    await c.term.say('Switched to the released standard. The fork is no longer needed.');
    await sleep(1200);
    await gotoApp(c);
    // "The app works exactly as before."
    await claimAppWorks(c, true);
  },
  async 'outro-card'(c) {
    await c.d.chapter({ eyebrow: 'Concord', title: 'Thanks for watching', sub: `Try it: ${startHere(c)}` }, 0);
  },

  /* ------------------------ alpha testers (feedback.md) ------------------------ */
  async 'title-card-feedback'(c) {
    await c.d.chapter({ eyebrow: 'Concord · Alpha testing', title: 'How to take part', sub: 'Try Concord in a role, then tell us what you think.' }, 0);
    await sleep(900);
    await c.d.goto(`${c.hub}/welcome`, { keepCard: true });
  },
  async 'open-welcome'(c) {
    await show(c, `${c.hub}/welcome`);
    await c.d.claimVisible(c.d.page.getByRole('heading', { level: 1, name: 'Help us test Concord' }), 'the welcome page is showing');
  },
  async 'point-welcome-aims'(c) {
    const aims = c.d.page.locator('section[aria-labelledby="what-title"]');
    await glideTo(c, aims);
    await c.d.highlight(aims, 'what Concord is for');
    await sleep(1800);
    await c.d.clearHighlight();
    // "…a short tour of the whole platform"
    const tour = c.d.page.locator('#tour-title');
    await glideTo(c, tour);
    await c.d.claim((await c.d.page.locator('[data-testid="tour-video"]').count()) > 0 || !argvPublishing(c), 'the tour video is embedded on the welcome page');
    await c.d.highlight(c.d.page.locator('article', { has: tour }), 'the tour video');
  },
  async 'point-how-it-works'(c) {
    await c.d.clearHighlight();
    const steps = c.d.page.locator('section[aria-labelledby="how-title"]');
    await glideTo(c, steps);
    await c.d.claim((await steps.locator('li').count()) === 4, 'the welcome page lists four steps');
    await c.d.highlight(steps.locator('ol'), 'the four steps');
  },
  async 'point-start-walkthrough'(c) {
    await c.d.clearHighlight();
    const start = c.d.page.getByRole('link', { name: 'Start the guided walkthrough' }).last();
    await glideTo(c, start);
    await c.d.pointAt(start, 'the Start the guided walkthrough button');
    await c.d.highlight(start, 'the start button');
  },
  async 'alpha-open'(c) {
    await c.d.clearHighlight();
    await c.d.click(c.d.page.getByRole('link', { name: 'Start the guided walkthrough' }).last(), 'the Start the guided walkthrough button');
    await c.d.claimVisible(c.d.page.getByRole('heading', { name: 'Guided walkthrough' }), 'the guided walkthrough opens');
    await sleep(1200);
    await c.d.click(c.d.page.getByRole('button', { name: /Let’s start/ }), 'the Let’s start button');
    await c.d.claimVisible(c.d.page.getByRole('heading', { name: /Pick your role/ }), 'the walkthrough moves on to picking a role');
  },
  async 'alpha-expand-role'(c) {
    const roles = c.d.page.getByRole('region');
    await c.d.highlight(c.d.page.getByRole('region', { name: 'Ontology steward' }).locator('..'), 'the roles');
    await sleep(2600);
    await c.d.clearHighlight();
    const member = c.d.page.getByRole('region', { name: 'Voting member' });
    await c.d.click(member.getByRole('button').first(), 'the Voting member role');
    c.d.claim((await roles.count()) >= 4, 'several roles are offered');
    await c.d.claimVisible(member.getByRole('button').nth(1), 'the voting member role lists people to play');
  },
  async 'alpha-pick-person'(c) {
    const person = c.d.page.getByRole('region', { name: 'Voting member' }).getByRole('button').nth(1);
    await c.d.highlight(person, 'a person to play');
    await sleep(2200);
    await c.d.clearHighlight();
    await c.d.click(person, 'a voting member to play');
    await c.d.claimVisible(c.d.page.getByRole('heading', { name: /Explore the demo/ }), 'picking a person moves on to the tasks');
  },
  async 'alpha-show-tasks'(c) {
    await c.d.highlight(c.d.page.getByRole('group', { name: 'Suggested next task' }), 'the suggested task');
  },
  // Timed to "Press Go" and "tick each task off" in feedback.md.
  async 'alpha-point-go'(c) {
    const next = c.d.page.getByRole('group', { name: 'Suggested next task' });
    await c.d.pointAt(next.getByRole('link', { name: 'Go' }), 'the Go button');
  },
  async 'alpha-tick-task'(c) {
    const next = c.d.page.getByRole('group', { name: 'Suggested next task' });
    await c.d.click(next.getByRole('button', { name: /I’ve done this/ }), 'I’ve done this');
    await c.d.claimVisible(c.d.page.getByText(/^1 of \d+ done$/), 'the task is ticked off');
    await c.d.clearHighlight();
  },
  async 'alpha-keep-open'(c) {
    await c.d.click(c.d.page.getByRole('button', { name: 'Keep the guide open while I explore' }), 'Keep the guide open while I explore');
    const dock = c.d.page.locator('aside', { hasText: 'Alpha walkthrough' });
    await c.d.claimVisible(dock, 'the guide stays open on the ontology page');
    await sleep(800);
    await c.d.highlight(dock, 'the guide');
  },
  async 'alpha-simulate'(c) {
    await c.d.clearHighlight();
    const dock = c.d.page.locator('aside', { hasText: 'Alpha walkthrough' });
    await c.d.click(dock.getByRole('button', { name: 'Next: simulate the others' }), 'Next: simulate the others');
    const stepped = c.d.page.waitForResponse((r) => /\/simulation\/step/.test(r.url()) && r.request().method() === 'POST', { timeout: 20_000 }).catch(() => undefined);
    await c.d.click(dock.getByRole('button', { name: 'Simulate the others' }), 'Simulate the others');
    const res = await stepped;
    const body = res?.ok() ? await res.json().catch(() => undefined) : undefined;
    // "…the other participants comment, review and vote."
    c.d.claim(Array.isArray(body?.events) && body.events.length > 0, 'simulating the others makes them act');
    await sleep(1200);
  },
  async 'alpha-fast-forward'(c) {
    const dock = c.d.page.locator('aside', { hasText: 'Alpha walkthrough' });
    const time = dock.getByText(/^Simulated time:/);
    const before = await time.textContent().catch(() => '');
    await c.d.click(dock.getByRole('button', { name: '+7 days' }), 'the +7 days button');
    const moved = await c.d.page
      .waitForFunction(([b]) => [...document.querySelectorAll('aside p')].some((p) => p.textContent?.startsWith('Simulated time:') && p.textContent !== b), [before], { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    c.d.claim(moved, 'the simulated clock moves forward');
    await c.d.highlight(time, 'the simulated time');
  },
  async 'open-feedback'(c) {
    await c.d.clearHighlight();
    const dock = c.d.page.locator('aside', { hasText: 'Alpha walkthrough' });
    await c.d.click(dock.getByRole('button', { name: /I’m ready to give feedback/ }), 'I’m ready to give feedback');
    await c.d.click(dock.getByRole('link', { name: 'Give feedback' }), 'the Give feedback button in the guide');
    await c.d.claimVisible(c.d.page.getByRole('heading', { name: 'Tell us what you think' }), 'the feedback page opens');
  },
  async 'highlight-guided'(c) {
    await c.d.highlight(c.d.page.getByRole('button', { name: /Guided feedback/ }), 'Guided feedback');
  },
  async 'start-general'(c) {
    await c.d.highlight(c.d.page.getByRole('button', { name: /Just tell us something/ }), 'Just tell us something');
    await sleep(1400);
    await c.d.clearHighlight();
    await c.d.click(c.d.page.getByRole('button', { name: /Just tell us something/ }), 'Just tell us something');
    await c.d.claimVisible(c.d.page.getByPlaceholder('Type or tap the mic and talk…'), 'the feedback chat opens');
  },
  async 'type-feedback'(c) {
    const box = c.d.page.getByPlaceholder('Type or tap the mic and talk…');
    await c.d.type(box, 'I liked seeing the votes close on their own. It took me a while to find where to report a problem with a term.', 'the feedback box', 22);
    const replied = c.d.page.waitForResponse((r) => r.url().endsWith('/api/feedback/chat') && r.request().method() === 'POST', { timeout: 30_000 }).catch(() => undefined);
    await box.press('Enter');
    const res = await replied;
    const body = res?.ok() ? await res.json().catch(() => undefined) : undefined;
    c.d.claim(typeof body?.reply === 'string' && body.reply.length > 0, 'the assistant replies to the feedback');
    await c.d.settle();
  },
  async 'submit-feedback'(c) {
    await c.d.click(c.d.page.getByRole('button', { name: /Submit what I’ve said so far|Submit feedback/ }).last(), 'the submit button');
    await c.d.claimVisible(c.d.page.getByRole('heading', { name: 'Thank you!' }), 'the feedback is submitted');
  },
  async 'highlight-header-feedback'(c) {
    await c.d.click(c.d.page.getByRole('link', { name: 'Back to the hub' }), 'Back to the hub');
    const header = c.d.page.locator('header a[href="/feedback"]');
    await c.d.claimVisible(header, 'Give feedback is in the header');
    await c.d.pointAt(header, 'the Give feedback button in the header');
    await c.d.highlight(header, 'Give feedback', 'On every page');
  },
  async 'outro-card-feedback'(c) {
    await c.d.clearHighlight();
    await c.d.chapter({ eyebrow: 'Concord · Alpha testing', title: 'Thank you', sub: `Start here: ${startHere(c)}` }, 0);
  },
};

/** The landing page to send people to, as shown on screen. */
const startHere = (c: Ctx) => `${c.shownHub.replace(/^https?:\/\//, '').replace(/\/$/, '')}/welcome`;

/** Whether this is a release recording, where the tour must already be on the welcome page. */
const argvPublishing = (c: Ctx) => c.notices.publishing === true;

/** Scrolls smoothly until the target is in the middle of the screen. */
async function glideTo(c: Ctx, target: import('@playwright/test').Locator) {
  const l = await c.d.find(target, 'a section of the page');
  if (!l) return;
  const dy = await l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top + Math.min(r.height, innerHeight * 0.7) / 2 - innerHeight / 2;
  });
  if (Math.abs(dy) > 8) await c.d.scroll(dy, Math.min(1600, 500 + Math.abs(dy)));
  await sleep(250);
}

/**
 * Takes a change request through review, merge and release using the demo personas, so
 * the "back to the main standard" scene has a real release to migrate to.
 */
async function landChange(c: Ctx, crId: string) {
  // A separate cookie jar, so acting as the personas doesn't sign the browser out.
  const api = await request.newContext();
  const as = async (userId: string) => api.post(`${c.hub}/api/auth/demo`, { data: { userId } });
  const personas = ((await (await api.get(`${c.hub}/api/personas`)).json()) as { id: string; roles: string[] }[]) ?? [];
  const cr = async () => (await (await api.get(`${c.hub}/api/change-requests/${crId}`)).json()) as any;
  for (let round = 0; round < 6; round++) {
    const s = (await cr()).status as string;
    if (['merged', 'released', 'accepted'].includes(s)) break;
    for (const p of personas) {
      await as(p.id);
      await api.post(`${c.hub}/api/change-requests/${crId}/reviews`, { data: { decision: 'approve' } }).catch(() => {});
      await api.post(`${c.hub}/api/change-requests/${crId}/votes`, { data: { choice: 'yes' } }).catch(() => {});
    }
    await api.post(`${c.hub}/api/simulation/clock`, { data: { advanceDays: 8 } }).catch(() => {});
    const steward = personas.find((p) => p.roles.includes('steward')) ?? personas[0];
    if (steward) await as(steward.id);
    await api.post(`${c.hub}/api/change-requests/${crId}/merge`).catch(() => {});
  }
  const status = (await cr()).status;
  if (!['merged', 'released', 'accepted'].includes(status)) c.d.warn(`Change request ended as "${status}", not merged`);
  // Draft and publish a release.
  const steward = personas.find((p) => p.roles.includes('steward')) ?? personas[0];
  if (steward) await as(steward.id);
  const draft = await api.post(`${c.hub}/api/ontologies/${c.ontology.id}/releases`, { data: { notes: 'Adds VolunteeringActivity for logging volunteer hours.' } });
  if (draft.ok()) {
    const rel = (await draft.json()) as { id: string };
    for (let round = 0; round < 4; round++) {
      for (const p of personas) {
        await as(p.id);
        await api.post(`${c.hub}/api/releases/${rel.id}/votes`, { data: { choice: 'yes' } }).catch(() => {});
      }
      await api.post(`${c.hub}/api/simulation/clock`, { data: { advanceDays: 8 } }).catch(() => {});
      if (steward) await as(steward.id);
      const pub = await api.post(`${c.hub}/api/releases/${rel.id}/publish`);
      if (pub.ok()) break;
    }
  } else c.d.warn(`Drafting a release failed: ${draft.status()} ${(await draft.text()).slice(0, 200)}`);
  await api.dispose();
}
