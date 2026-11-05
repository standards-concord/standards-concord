/**
 * What happens on screen in the features video (features.md): one change followed from a
 * term's page through review, a git commit, a release tag and the public page, then
 * checking data against the standard's SHACL shapes.
 *
 * Like scenes.ts, every action drives the real app being recorded. The terminal here is
 * not an agent session: every command shown is really run, read-only, against the
 * recorded hub's own git repository (or its public address), and its real output printed.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sleep } from './lib/director.ts';
import { apiJson, ringAround, show, type Ctx } from './scenes.ts';

type Action = (ctx: Ctx, ...args: string[]) => Promise<void>;

const VOL = 'https://w3id.org/odi/volunteering#';
/** The term whose definition the editor clarifies, and the new wording. */
const TERM = { localName: 'Skill', label: 'skill', definition: 'A learned capability, such as first aid or bookkeeping, that a person can apply to a task, for example a volunteer in their role.', why: 'Say how skills apply to volunteering.' };
/** What the terminal is, said on screen (the scripted-agent caption doesn't apply here). */
const REAL_TERMINAL = 'Real commands, run as shown on the recorded hub’s own git repository';
const REAL_CURL = 'Real request, run as shown, to the hub this video was recorded on (it serves the same paths as the live hub)';
/** Data about one food bank shift, with one mistake: the minimum age is written as text. */
const SAMPLE = `@prefix vol: <https://w3id.org/odi/volunteering#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <https://example.org/data/> .

ex:foodbank a vol:VolunteerInvolvingOrganisation ;
  rdfs:label "Northvale Food Bank" ;
  vol:offersOpportunity ex:saturday-shift .

ex:saturday-shift a vol:VolunteeringOpportunity ;
  vol:title "Saturday food bank shift" ;
  vol:offeredBy ex:foodbank ;
  vol:hasRole ex:shelf-stacker ;
  vol:minimumAge "sixteen" .

ex:shelf-stacker a vol:Role ;
  rdfs:label "Shelf stacker" .
`;

const o = (c: Ctx, p = '') => `${c.hub}/o/${c.ontology.id}${p}`;

/** What the story has made so far, so later scenes can point at it. */
const story: { crId?: string; crNumber?: number; release?: string; sha?: string } = {};

/** Signs the browser in as one of the demo personas (a simulated working-group member). */
async function signInAs(c: Ctx, name: string) {
  const personas = ((await apiJson(c, '/api/personas')) ?? []) as { id: string; name: string }[];
  const p = personas.find((x) => x.name === name || x.name.startsWith(`${name} `));
  if (!p) return c.d.warn(`No demo persona called ${name}`);
  await c.d.page.context().clearCookies({ name: 'concord_session' });
  const r = await c.api.post(`${c.hub}/api/auth/demo`, { data: { userId: p.id } });
  if (!r.ok()) c.d.warn(`Signing in as ${name}: HTTP ${r.status()}`);
}

/** The recorded hub's git repository for this ontology, or a warning if it isn't on this machine. */
function repo(c: Ctx) {
  if (c.dataDir) return path.join(c.dataDir, 'ontologies', c.ontology.slug);
  c.d.warn('The git scenes need a hub this recorder started (its repositories are on this machine)');
  return undefined;
}

/** Runs a shell command line exactly as written (read-only commands only) and returns its output. */
function run(c: Ctx, cmd: string, cwd: string): string | undefined {
  try {
    // Not a terminal, so git uses no pager and no colour; NO_PROXY keeps curl on the local hub.
    return execFileSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' } }).trimEnd();
  } catch (e) {
    c.d.warn(`${cmd} failed: ${(e as Error).message.split('\n')[0]}`);
    return undefined;
  }
}

/**
 * Types a command into the terminal, runs exactly that command and prints all of its output.
 * Long output is cut with `| head` in the command itself, so what's shown is what ran.
 */
async function shell(c: Ctx, cmd: string, cwd: string | undefined, cwdLabel: string) {
  if (!cwd) return undefined;
  await c.term.shell(cmd, { cwdLabel });
  const out = run(c, cmd, cwd);
  if (out !== undefined) await c.term.print(out);
  return out;
}
const inRepo = (c: Ctx, cmd: string) => shell(c, cmd, repo(c), `~/concord/${c.ontology.slug}`);
/** Every format a release writes (releases.ts), each under releases/<version>/. */
const RELEASE_FILES = ['ontology.ttl', 'ontology.jsonld', 'ontology.owl', 'ontology.nt', 'ontology.omn', 'ontology.linkml.yaml', 'ontology.shacl.ttl', 'ontology.shaclc', 'ontology.js', 'ontology.ts', 'index.html'];

async function openTerminal(c: Ctx, disclosure: string) {
  await c.term.open(disclosure);
  // Real output is shown as it is: no rewriting the recorded hub's address to the live one (record.ts presentation()).
  await c.d.page.evaluate(() => ((window as any).__wtRealOutput = true));
  // A fresh session: this video has no agent, and each terminal shot starts clean.
  await c.term.clear();
  await c.term.title(`${c.ontology.slug} — zsh`);
}

const cr = async (c: Ctx) => (story.crId ? ((await apiJson(c, `/api/change-requests/${story.crId}`)) as { status: string; number: number; classification?: { level?: string }; validation?: { passed?: boolean; competencyQuestions?: { satisfied: boolean }[] } } | undefined) : undefined);

async function waitForStatus(c: Ctx, want: RegExp, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    const s = (await cr(c))?.status;
    if (s && want.test(s)) return s;
  }
  return (await cr(c))?.status;
}

export const featureActions: Record<string, Action> = {
  /* ----------------------------- opening ----------------------------- */
  async 'f-title-card'(c) {
    await signInAs(c, 'Priya Shah');
    await c.d.chapter({ eyebrow: 'Concord · A closer look', title: 'One change, start to finish', sub: 'Checks, review, git history, releases, and checking your data.' }, 0);
    await sleep(900);
    await c.d.goto(o(c), { keepCard: true });
  },
  async 'f-open-overview'(c) {
    await show(c, o(c));
    await sleep(400);
  },

  /* ------------------------------ health ------------------------------ */
  async 'f-open-health'(c) {
    const v = await apiJson(c, `/api/ontologies/${c.ontology.id}/validation`);
    c.d.claim(v?.reasoner?.consistent === true, 'the reasoner reports the working draft consistent');
    await c.d.highlight(c.d.page.getByRole('group', { name: 'Health summary' }), 'the health summary');
  },
  async 'f-recheck-browser'(c) {
    await c.d.clearHighlight();
    const btn = c.d.page.getByRole('button', { name: 'Check again in this browser' });
    if (!(await c.d.click(btn, 'Check again in this browser', { settle: false }))) return;
    await c.d.claimVisible(c.d.page.getByText('consistent, all classes satisfiable'), 'the in-browser reasoner finds every class satisfiable', 30_000);
    await c.d.claimVisible(c.d.page.getByText('Same result as the server.'), 'the in-browser result agrees with the server');
  },
  async 'f-show-fair'(c) {
    await c.d.highlight(c.d.page.getByRole('button', { name: /^FAIR checks/ }), 'the FAIR checks');
  },

  /* ------------------------------ browse ------------------------------ */
  async 'f-open-diagram'(c) {
    await c.d.clearHighlight();
    await c.d.goto(o(c, '/browse'));
    await c.d.click(c.d.page.getByRole('radio', { name: /Diagram/ }), 'the Diagram view');
    await sleep(800);
    if (await c.d.claimVisible(c.d.page.getByRole('main').locator('svg').first(), 'the class diagram is drawn')) await c.d.scroll(280, 1400);
  },
  async 'f-open-term'(c) {
    await signInAs(c, 'Tom Okafor');
    await c.d.goto(o(c, `/browse?term=${encodeURIComponent(VOL + TERM.localName)}`));
    await sleep(400);
    await c.d.claimVisible(c.d.page.getByRole('main').getByText(/that a person can apply to a task/), 'the term page shows the current definition');
    await ringAround(c, /that a person can apply to a task/);
  },
  async 'f-edit-term'(c) {
    await c.d.clearHighlight();
    await c.d.click(c.d.page.getByRole('button', { name: 'Edit', exact: true }), 'the Edit button');
  },
  async 'f-type-definition'(c) {
    const form = c.d.page.getByRole('form', { name: /^Edit / });
    await c.d.type(form.getByLabel('Definition'), TERM.definition, 'the Definition field', 55);
  },
  async 'f-confirm-meaning'(c) {
    const form = c.d.page.getByRole('form', { name: /^Edit / });
    const yes = form.getByRole('radio', { name: /Yes, it is clearer wording/ });
    if (await c.d.click(yes, 'the "same meaning" answer', { settle: false })) await yes.check().catch(() => {});
    await c.d.type(form.getByLabel('Why this change? (optional)'), TERM.why, 'the Why this change field', 26);
  },
  async 'f-propose'(c) {
    const form = c.d.page.getByRole('form', { name: /^Edit / });
    if (!(await c.d.click(form.getByRole('button', { name: 'Propose change' }), 'Propose change'))) return;
    const notice = c.d.page.getByRole('status').filter({ hasText: 'Proposed as' });
    if (!(await c.d.claimVisible(notice, 'the edit became a change request', 15_000))) return;
    const href = await notice.getByRole('link', { name: /change request #/ }).getAttribute('href');
    story.crId = href?.split('/changes/')[1];
    story.crNumber = (await cr(c))?.number;
    await c.d.highlight(notice, 'the Proposed notice');
  },

  /* ------------------------------ review ------------------------------ */
  async 'f-open-change'(c) {
    await c.d.clearHighlight();
    if (!story.crId) return c.d.warn('No change request was proposed');
    await c.d.goto(o(c, `/changes/${story.crId}`));
    const level = (await cr(c))?.classification?.level;
    c.d.claim(level === 'patch', `the edit is classified as a patch (got ${level})`);
    await c.d.highlight(c.d.page.getByRole('button', { name: /^Level: / }), 'the level badge');
  },
  async 'f-show-triples'(c) {
    await c.d.clearHighlight();
    if (await c.d.click(c.d.page.getByRole('button', { name: 'Triples' }), 'the Triples view')) {
      await sleep(300);
      await c.d.claimVisible(c.d.page.getByRole('tabpanel').getByText(/for example a volunteer in their role/).first(), 'the triples show the new definition');
      await c.d.scroll(260, 1000);
    }
  },
  async 'f-show-checks'(c) {
    await c.d.scroll(-2000, 500);
    await c.d.click(c.d.page.getByRole('tab', { name: /Checks/ }), 'the Checks tab');
    const v = (await cr(c))?.validation;
    c.d.claim(v?.passed === true, 'lint and the reasoner pass with the change applied');
    // The overall verdict leaves competency questions out, so check them too.
    c.d.claim(v && (v.competencyQuestions ?? []).length > 0 && v.competencyQuestions!.every((q) => q.satisfied), 'every competency question is answered with the change applied');
    await ringAround(c, /^Validation$/);
  },
  async 'f-show-decision'(c) {
    await c.d.clearHighlight();
    await ringAround(c, /^Decision$/);
  },
  async 'f-approve'(c) {
    await c.d.clearHighlight();
    await signInAs(c, 'Priya Shah');
    await c.d.goto(o(c, `/changes/${story.crId}`));
    const btn = c.d.page.getByRole('group', { name: 'Your actions' }).getByRole('button', { name: 'Approve' });
    if (!(await c.d.click(btn, 'Approve'))) return;
    await sleep(600);
    await ringAround(c, /^Decision$/);
  },
  async 'f-day-passes'(c) {
    await c.d.clearHighlight();
    // The review period is a day: move the hub's simulated clock on, as the alpha's "Simulate" does.
    const r = await c.api.post(`${c.hub}/api/simulation/clock`, { data: { advanceDays: 1 } });
    if (!r.ok()) c.d.warn(`Moving the clock on: HTTP ${r.status()}`);
    const s = await waitForStatus(c, /merged|released/);
    c.d.claim(s === 'merged', `the change merged on its own after the review period (status ${s})`);
    await c.d.goto(o(c, `/changes/${story.crId}`));
    await c.d.highlight(c.d.page.getByRole('button', { name: /^Status: / }), 'the status badge');
  },

  /* -------------------------------- git -------------------------------- */
  async 'f-git-log'(c) {
    await c.d.clearHighlight();
    await openTerminal(c, REAL_TERMINAL);
    const out = await inRepo(c, 'git log --oneline --decorate --graph --all | head -n 14');
    c.d.claim(out && story.crNumber && new RegExp(`#${story.crNumber} Edit the definition of .skill.`).test(out), 'the merged change is a commit named after its change request');
    c.d.claim(out && /tag: v\d+\.\d+\.\d+/.test(out), 'releases are tags');
    // Found off camera, so the next shot can type its id.
    const dir = repo(c);
    if (dir && story.crNumber) story.sha = run(c, `git log -1 --format=%h --grep='^#${Number(story.crNumber)} ' main`, dir);
  },
  async 'f-git-show'(c) {
    if (!story.sha) return c.d.warn('No commit for the change request');
    if (!/^[0-9a-f]{4,40}$/.test(story.sha)) return c.d.warn(`Unexpected commit id ${story.sha}`);
    const out = await inRepo(c, `git show ${story.sha} | head -n 24`);
    c.d.claim(out && /^\+.*for example a volunteer in their role/m.test(out) && /^-.*that a person can apply to a task\."/m.test(out), 'the commit is a Turtle diff of the new definition');
  },
  async 'f-git-forks'(c) {
    const out = await inRepo(c, 'git branch --list');
    c.d.claim(out && /forks\//.test(out), 'forks are branches');
  },

  /* ------------------------------ release ------------------------------ */
  async 'f-open-releases'(c) {
    await c.d.goto(o(c, '/releases'));
    if (!(await c.d.click(c.d.page.getByRole('button', { name: 'Draft release' }).first(), 'Draft release'))) return;
    const dlg = c.d.page.getByRole('dialog', { name: 'Draft a release' });
    const draft = dlg.getByRole('button', { name: /^(Draft|Update) v\d+\.\d+\.\d+$/ });
    const btn = await c.d.find(draft, 'the Draft button in the dialog');
    if (!btn) return;
    story.release = (await btn.innerText()).replace(/^(Draft|Update) v/, '').trim();
    c.d.claim(/^\d+\.\d+\.\d+$/.test(story.release) && story.release.split('.')[2] !== '0', `the release is a patch version (${story.release})`);
    await c.d.highlight(dlg, 'the Draft a release dialog');
    await sleep(1800);
    await c.d.clearHighlight();
    await c.d.click(btn, 'the Draft button');
  },
  async 'f-publish'(c) {
    if (!story.release) return c.d.warn('No release was drafted');
    const pub = c.d.page.getByRole('button', { name: `Publish v${story.release}` });
    if (!(await c.d.click(pub, `Publish v${story.release}`, { settle: false }))) return;
    await c.d.claimVisible(c.d.page.getByText('Published', { exact: true }), 'the release is published', 30_000);
    await c.d.settle();
  },
  async 'f-git-tag'(c) {
    if (!story.release) return c.d.warn('No release was published');
    await openTerminal(c, REAL_TERMINAL);
    if (!/^\d+\.\d+\.\d+$/.test(story.release)) return c.d.warn(`Unexpected release version ${story.release}`);
    const log = await inRepo(c, 'git log --oneline --decorate -n 4');
    c.d.claim(log?.includes(`tag: v${story.release}`), `the release is tagged v${story.release}`);
    const files = await inRepo(c, `git ls-tree --name-only v${story.release} releases/${story.release}/`);
    const missing = RELEASE_FILES.filter((f) => !files?.split('\n').includes(`releases/${story.release}/${f}`));
    c.d.claim(files && !missing.length, `every format is in the release's folder (missing: ${missing.join(', ') || 'none'})`);
  },

  /* ---------------------------- public page ---------------------------- */
  async 'f-open-public'(c) {
    await c.d.goto(`${c.hub}/def/${c.ontology.slug}`);
    if (story.release) await c.d.claimVisible(c.d.page.getByText(`Version ${story.release}`).first(), `the public page shows version ${story.release}`);
    await ringAround(c, /^Download$/);
  },
  async 'f-curl'(c) {
    await c.d.clearHighlight();
    await openTerminal(c, REAL_CURL);
    const url = `${c.hub}/def/${c.ontology.slug}`;
    if (!/^https?:\/\/[\w.:-]+\/def\/[\w-]+$/.test(url)) return c.d.warn(`Unexpected address ${url}`);
    const type = await shell(c, `curl -sS -o /dev/null -w '%{http_code} %{content_type}\\n' -H "Accept: text/turtle" ${url}`, process.cwd(), '~');
    c.d.claim(type && /^200 text\/turtle/.test(type), 'the address answers with Turtle when asked for it');
    const out = await shell(c, `curl -sS -H "Accept: text/turtle" ${url} | head -n 14`, process.cwd(), '~');
    c.d.claim(out && /@prefix/.test(out), 'the body is Turtle');
    const onScreen = await c.d.page.locator('body').innerText().catch(() => '');
    c.d.claim(onScreen.includes(url), `the terminal shows the address curl really asked (${url})`);
    if (story.release) {
      const full = run(c, `curl -sS -H "Accept: text/turtle" ${url}`, process.cwd());
      c.d.claim(full?.includes(`/${story.release}>`), `the Turtle is version ${story.release}`);
    }
  },

  /* ----------------------------- check data ----------------------------- */
  async 'f-open-check'(c) {
    await c.d.goto(o(c, '/query?view=check'));
    await c.d.page.getByTestId('sparq-ready').waitFor({ state: 'visible', timeout: 30_000 }).catch(() => c.d.warn('The in-browser engine never became ready'));
    await ringAround(c, 'Check your data');
  },
  async 'f-paste-data'(c) {
    await c.d.clearHighlight();
    const editor = c.d.page.getByTestId('data-editor');
    if (!(await c.d.click(editor, 'the data editor', { settle: false }))) return;
    await c.d.page.keyboard.press('ControlOrMeta+a');
    await c.d.page.keyboard.insertText(SAMPLE);
    await sleep(400);
  },
  async 'f-check'(c) {
    await c.d.clearHighlight();
    if (!(await c.d.click(c.d.page.getByRole('button', { name: 'Check', exact: true }), 'Check'))) return;
    const list = c.d.page.getByRole('list', { name: /Problems found/ });
    await c.d.claimVisible(list.getByRole('button', { name: /"sixteen" is of type xsd:string but must be of type xsd:nonNegativeInteger/ }), 'the problem reads as a sentence');
    await c.d.highlight(list, 'the problems found');
  },
  async 'f-hover'(c) {
    await c.d.clearHighlight();
    const squiggle = c.d.page.getByTestId('data-editor').locator('.cm-lintRange-error', { hasText: '"sixteen"' });
    if (!(await c.d.pointAt(squiggle, 'the underlined value'))) return;
    await c.d.claimVisible(c.d.page.locator('.cm-tooltip-lint'), 'hovering shows the problem');
  },
  async 'f-jump'(c) {
    const problem = c.d.page.getByRole('list', { name: /Problems found/ }).getByRole('button', { name: /"sixteen"/ });
    if (!(await c.d.click(problem, 'the problem in the list', { settle: false }))) return;
    const sel = await c.d.page.evaluate(() => document.getSelection()?.toString() ?? '');
    c.d.claim(sel === '"sixteen"', `clicking the problem selects the value (selected ${JSON.stringify(sel)})`);
    await c.d.claimVisible(problem.getByText('Write it as'), 'the report says how to write the value');
  },
  async 'f-fix'(c) {
    // The value is selected: typing replaces it, the way the report suggests.
    await sleep(300);
    await c.d.page.keyboard.insertText('"16"^^xsd:nonNegativeInteger');
    await sleep(600);
    const again = c.d.page.getByTestId('report-stale').getByRole('button', { name: 'Check again' });
    const btn = (await again.isVisible().catch(() => false)) ? again : c.d.page.getByRole('button', { name: 'Check', exact: true });
    if (!(await c.d.click(btn, 'Check again', { settle: false }))) return;
    const ok = c.d.page.getByTestId('shacl-report').getByText('Conforms', { exact: true });
    if (await c.d.claimVisible(ok, 'the fixed data conforms', 20_000)) await c.d.highlight(ok, 'Conforms');
  },
  async 'f-open-validate'(c) {
    await c.d.clearHighlight();
    await c.d.goto(o(c, '/validate'));
    await sleep(500);
    await c.d.scroll(500, 1600);
  },

  /* ------------------------------ closing ------------------------------ */
  async 'f-outro-card'(c) {
    await c.d.clearHighlight();
    const site = c.shownHub.replace(/^https?:\/\//, '').replace(/\/$/, '');
    await c.d.chapter({ eyebrow: 'Concord', title: 'Thanks for watching', sub: `Try it: ${site}/welcome` }, 0);
  },
};
