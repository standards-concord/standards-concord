/**
 * Concord's own release history: the version of the app an alpha tester is
 * using, and what changed in each release. This is about the app, not the
 * ontologies it hosts (those have their own releases).
 *
 * Versions follow semantic-release conventions: nobody picks the number. Each
 * release lists its changes with a Conventional Commits type, and the version
 * is the previous one bumped by the biggest change (breaking → major, feat →
 * minor, fix/perf → patch). `pnpm --filter @concord/server test` checks every
 * entry against that rule and tells you the number to use.
 *
 * To ship a user-facing change, add a release at the top of APP_RELEASES (one
 * per merged pull request, like semantic-release cutting a release per merge).
 * Say which tester roles it matters to and where to try it, so the walkthrough
 * can send returning testers there and the feedback chat can ask about it.
 */

/** The five roles a tester can pick in the walkthrough (see TESTER_ROLES in the web app). */
export type TesterRoleKey = 'steward' | 'contributor' | 'member' | 'odi' | 'agent';
export const TESTER_ROLE_KEYS: TesterRoleKey[] = ['steward', 'contributor', 'member', 'odi', 'agent'];

/** Conventional Commits types that cut a release. */
export type AppChangeType = 'feat' | 'fix' | 'perf' | 'breaking';

export interface AppChange {
  /** Stable id, unique across all releases (used in feedback answers, so never reuse one). */
  id: string;
  type: AppChangeType;
  /** Short, plain-English title a tester would recognise. */
  title: string;
  /** One or two sentences on what's different. */
  detail: string;
  /** Tester roles this matters most to. Empty means everyone. */
  roles: TesterRoleKey[];
  /** Where to try it. `{o}` stands for the demo ontology's path (/o/<id>). */
  to?: string;
  /** Walkthrough tasks (ids from tasksFor in the web app) this change touches. */
  tasks?: string[];
  /** A specific feedback question about this change. Features get a generic one if this is missing. */
  ask?: string;
}

export interface AppRelease {
  version: string;
  /** Release date (YYYY-MM-DD). */
  date: string;
  title: string;
  /** Pull request in standards-concord/standards-concord, if there was one. */
  pr?: number;
  changes: AppChange[];
}

/** Newest first. */
export const APP_RELEASES: AppRelease[] = [
  {
    version: '0.18.0',
    date: '2026-11-05',
    title: 'Sign in with Solid',
    pr: 66,
    changes: [
      {
        id: 'solid-provider-picker',
        type: 'feat',
        title: 'Sign in with Solid, choosing your provider',
        detail:
          'The login page now says “Sign in with Solid”, with the Solid logo. It opens the same sign-in window as the other Solid Suite apps: pick solidcommunity.net or another provider, enter your WebID, or type your provider’s address.',
        roles: [],
        to: '/login',
        ask: 'Could you find your provider, and was it clear what to choose if you don’t have a pod yet?',
      },
    ],
  },
  {
    version: '0.17.1',
    date: '2026-11-05',
    title: 'Every app on the Connect page has its logo',
    pr: 65,
    changes: [
      {
        id: 'connect-agent-logos',
        type: 'fix',
        title: 'Every app on the Connect page shows its own logo',
        detail:
          'ChatGPT, Claude Code, Codex, Cursor and VS Code now show their real logos beside Claude’s, instead of lettered placeholders, so you can spot your app at a glance.',
        roles: ['agent'],
        to: '/connect',
      },
    ],
  },
  {
    version: '0.17.0',
    date: '2026-11-05',
    title: 'A privacy policy',
    pr: 63,
    changes: [
      {
        id: 'privacy-policy',
        type: 'feat',
        title: 'A privacy policy explains what Concord keeps about you',
        detail:
          'A new Privacy policy page, linked from the footer of every page and from the sign-in card, says what Google, GitHub and WebID sign-in share, where your contributions are kept, which services process them, and how to have your data deleted.',
        roles: [],
        to: '/privacy',
        ask: 'Does the privacy policy tell you what you’d want to know before signing in?',
      },
    ],
  },
  {
    version: '0.16.0',
    date: '2026-11-05',
    title: 'Share a public summary of your feedback',
    pr: 44,
    changes: [
      {
        id: 'feedback-public-summary',
        type: 'feat',
        title: 'Optionally post a short public summary of your feedback',
        detail:
          'When you send feedback you can tick “Also post a short public summary as a GitHub issue” and write one. Only that summary is posted, exactly as previewed, with no name or answers. You can withdraw it from the thank-you screen right after sending, or email the alpha team later.',
        roles: [],
        to: '/feedback',
        ask: 'Was it clear what would be made public, and would you tick the box?',
      },
    ],
  },
  {
    version: '0.15.0',
    date: '2026-11-05',
    title: 'Sign in with your WebID',
    pr: 46,
    changes: [
      {
        id: 'solid-signin',
        type: 'feat',
        title: 'Sign in with your own WebID (Solid)',
        detail:
          'Already have a Solid pod? Choose “Sign in with your WebID” on the login page. You sign in with your own Solid provider, and Concord checks that your WebID names that provider.',
        roles: [],
        to: '/login',
        ask: 'If you have a WebID, how easy was it to sign in with it?',
      },
      {
        id: 'feedback-readers',
        type: 'feat',
        title: 'See who can read your feedback',
        detail:
          'The feedback page says who can read what you send: the alpha team. The copy saved in your pod is shared read-only with the team’s WebID, and they read it there as that WebID.',
        roles: [],
        to: '/feedback',
        ask: 'Is it clear who can read your feedback?',
      },
    ],
  },
  {
    version: '0.14.0',
    date: '2026-11-05',
    title: 'Check data explains what’s wrong and where',
    pr: 50,
    changes: [
      {
        id: 'check-data-explained',
        type: 'feat',
        title: 'Check data explains problems and shows where they are',
        detail:
          'Problems read as plain sentences using your own prefixes, are underlined in the editor (hover to read), and clicking one jumps to it. Typos and syntax errors are underlined as you type, and Format tidies the Turtle.',
        roles: [],
        to: '{o}/query?view=check',
        ask: 'When Check data finds a problem, can you tell what’s wrong and where to fix it?',
      },
    ],
  },
  {
    version: '0.13.0',
    date: '2026-11-04',
    title: 'Returning testers see what changed',
    changes: [
      {
        id: 'tester-versions',
        type: 'feat',
        title: 'See what’s new since you last tested',
        detail:
          'The alpha pages show which version you’re testing. Sign in and Concord saves the version and your feedback to your own pod; next time it shows what changed, points your role at the new parts and asks about those rather than everything.',
        roles: [],
        ask: 'How useful is seeing what’s changed since your last visit, rather than starting over?',
      },
    ],
  },
  {
    version: '0.12.2',
    date: '2026-11-04',
    title: 'Fixes found by testing every flow',
    pr: 45,
    changes: [
      {
        id: 'a11y-names',
        type: 'fix',
        title: 'Dialogs, switches and answer boxes are properly named',
        detail:
          'Screen readers now announce each dialog by its title, and policy switches, the new-owner picker, the chat box and feedback answers have names. Chips say whether they’re on.',
        roles: [],
      },
      {
        id: 'review-comment-once',
        type: 'fix',
        title: 'A review comment shows once in the Discussion tab',
        detail: 'A review comment on a change request no longer appears twice in its discussion.',
        roles: ['steward', 'member'],
      },
    ],
  },
  {
    version: '0.12.1',
    date: '2026-11-04',
    title: 'Clearer, safer agent connections',
    pr: 34,
    changes: [
      {
        id: 'oauth-consent',
        type: 'fix',
        title: 'The connect screen says who an app is and where access goes',
        detail:
          'When an agent asks to connect, Concord says whether it can confirm who made the app (an unverified app’s name and website are only its own claims) and exactly where access will be sent, including apps on this device.',
        roles: ['agent'],
        to: '/connect',
      },
      {
        id: 'chatgpt-steps',
        type: 'fix',
        title: 'Up-to-date steps for connecting ChatGPT',
        detail: 'The ChatGPT instructions match ChatGPT’s current screens: create Concord as a plugin, install it, then pick it with @ in a chat.',
        roles: ['agent'],
        to: '/connect',
      },
    ],
  },
  {
    version: '0.12.0',
    date: '2026-11-04',
    title: 'SHACL compact syntax and classes for apps',
    pr: 18,
    changes: [
      {
        id: 'shaclc-classes',
        type: 'feat',
        title: 'Shapes in SHACL compact syntax, and generated classes',
        detail:
          'Source & export adds the SHACL shapes in compact syntax, which is much easier to read, and a JavaScript/TypeScript class for every shape so apps can work with the data as objects. Both are also served at the ontology’s URI.',
        roles: ['agent', 'contributor'],
        to: '{o}/source',
        ask: 'How useful are the compact SHACL view and the generated classes for building against the standard?',
      },
      {
        id: 'value-checks',
        type: 'fix',
        title: 'Data checks handle decimals, string types and patterns exactly',
        detail: 'Validating data now checks exact decimal bounds, string subtypes and XSD patterns, and several datatypes on one property.',
        roles: ['agent'],
      },
    ],
  },
  {
    version: '0.11.3',
    date: '2026-11-04',
    title: 'Room under the ontology header',
    pr: 41,
    changes: [
      {
        id: 'header-gap',
        type: 'fix',
        title: 'A clear gap between the ontology header and the page',
        detail: 'Each ontology page has breathing room between its header and the content below.',
        roles: [],
      },
    ],
  },
  {
    version: '0.11.2',
    date: '2026-11-04',
    title: 'Safer sign-in, and feedback for administrators only',
    pr: 40,
    changes: [
      {
        id: 'signin-hardening',
        type: 'fix',
        title: 'Signing in with Google or GitHub is safer',
        detail:
          'Each Google or GitHub identity has its own account: signing in never joins an account just because the email address matches, and a sign-in that didn’t start in your browser is refused.',
        roles: [],
      },
      {
        id: 'feedback-admins',
        type: 'fix',
        title: 'Only administrators can read testers’ feedback',
        detail:
          'Everyone’s feedback is readable only by this deployment’s administrators, signed in with Google or GitHub. Ontology roles and demo personas no longer count, and Feedback admin is gone from everyone else’s menu.',
        roles: ['odi'],
      },
    ],
  },
  {
    version: '0.11.1',
    date: '2026-11-04',
    title: 'Tidier ontology header',
    pr: 33,
    changes: [
      {
        id: 'header-alignment',
        type: 'fix',
        title: 'Header chips and the health breakdown line up',
        detail: 'The chips in each ontology’s header and the breakdown behind its health status are aligned.',
        roles: [],
      },
    ],
  },
  {
    version: '0.11.0',
    date: '2026-11-04',
    title: 'Source & export, and Query & validate',
    pr: 13,
    changes: [
      {
        id: 'source-export',
        type: 'feat',
        title: 'Pick a format from one dropdown on Source & export',
        detail: 'The Source page is now Source & export, with every format (Turtle, LinkML, JSON-LD, SHACL and the rest) in one dropdown.',
        roles: ['steward', 'contributor', 'agent', 'odi'],
        to: '{o}/source',
        tasks: ['linkml'],
        ask: 'Could you find the format you wanted on Source & export?',
      },
      {
        id: 'query-workspace',
        type: 'feat',
        title: 'Query & validate shows one workspace at a time',
        detail: 'Query & validate puts the query builder, the SPARQL editor and SHACL validation one at a time, and long results are paginated.',
        roles: ['steward', 'agent', 'contributor'],
        to: '{o}/query',
      },
      {
        id: 'query-builder-fixes',
        type: 'fix',
        title: 'Query builder fixes',
        detail: 'Number filters accept every number format, and the builder’s queries match what it shows.',
        roles: [],
      },
    ],
  },
  {
    version: '0.10.0',
    date: '2026-11-04',
    title: 'Clearer change requests and governance',
    pr: 22,
    changes: [
      {
        id: 'cr-decision',
        type: 'feat',
        title: 'Change requests lead with the decision',
        detail:
          'Each change request has Changes, Checks and Discussion views and one Decision card with the next step, what’s blocking it and what you can do. The patch, minor or major level explains itself.',
        roles: ['steward', 'member', 'odi', 'contributor'],
        to: '{o}/changes',
        tasks: ['review', 'vote'],
        ask: 'Could you tell what a change request needed next, and what you could do about it?',
      },
      {
        id: 'governance-edit',
        type: 'feat',
        title: 'Governance policies are easier to read and edit',
        detail: 'Summaries follow the rules that actually apply. Editing is a separate mode with a preview, Save and Discard, and you can compare every level side by side.',
        roles: ['steward', 'odi'],
        to: '{o}/governance',
        tasks: ['governance'],
        ask: 'Did the governance summary match how you expected decisions to be made?',
      },
      {
        id: 'interview-first',
        type: 'feat',
        title: 'Interviews put the conversation first',
        detail: 'The use case interview shows the chat with a progress strip; the document view and side-by-side are there when you want them.',
        roles: ['contributor'],
        to: '{o}/use-cases',
        tasks: ['interview'],
      },
      {
        id: 'checks-incomplete',
        type: 'fix',
        title: '“Checks incomplete” instead of “Healthy” when the reasoner didn’t run',
        detail: 'An ontology is no longer shown as healthy when a required check could not run.',
        roles: [],
      },
    ],
  },
  {
    version: '0.9.1',
    date: '2026-11-04',
    title: 'More private details behind sign-in',
    pr: 31,
    changes: [
      {
        id: 'private-reads-2',
        type: 'fix',
        title: 'Validation, the simulation and member details need sign-in',
        detail: 'Validation reports, the simulation and owner and count details are no longer readable without signing in.',
        roles: [],
      },
    ],
  },
  {
    version: '0.9.0',
    date: '2026-11-04',
    title: 'Connect ChatGPT',
    pr: 30,
    changes: [
      {
        id: 'chatgpt',
        type: 'feat',
        title: 'Connect ChatGPT as well as Claude and Codex',
        detail: 'The Connect page shows how to add Concord to ChatGPT as a custom connector, with the same OAuth sign-in.',
        roles: ['agent'],
        to: '/connect',
        tasks: ['agent'],
        ask: 'If you use ChatGPT, could you connect it to Concord?',
      },
    ],
  },
  {
    version: '0.8.1',
    date: '2026-11-04',
    title: 'Public pages: privacy and accuracy fixes',
    pr: 24,
    changes: [
      {
        id: 'public-pages-rereview',
        type: 'fix',
        title: 'Public pages keep use case drafts private',
        detail: 'Public ontology pages no longer show drafted changes that came from private use cases, and stored release pages and their dates are right.',
        roles: [],
      },
    ],
  },
  {
    version: '0.8.0',
    date: '2026-11-04',
    title: 'Agent reports get their own page',
    pr: 25,
    changes: [
      {
        id: 'agent-pages',
        type: 'feat',
        title: 'Agent reports and “Connect an agent” are separate',
        detail: 'Each ontology now has one page for the gaps agents have reported and another for connecting your own agent.',
        roles: ['agent', 'steward'],
        to: '{o}/agents',
        tasks: ['agent'],
        ask: 'Is it clear where to connect an agent and where to read what agents have reported?',
      },
      {
        id: 'private-reads',
        type: 'fix',
        title: 'Private material stays behind sign-in',
        detail: 'Use cases, meeting transcripts and other non-public material can no longer be read without signing in.',
        roles: [],
      },
    ],
  },
  {
    version: '0.7.0',
    date: '2026-11-04',
    title: 'One-click agent connections',
    pr: 6,
    changes: [
      {
        id: 'mcp-oauth',
        type: 'feat',
        title: 'Connect a coding agent in one click',
        detail: 'The MCP connector signs you in with OAuth, so there are no tokens to copy. The Connect page has install links for Claude, Claude Code and Codex.',
        roles: ['agent'],
        to: '/connect',
        tasks: ['agent'],
        ask: 'How easy was it to connect your coding agent?',
      },
    ],
  },
  {
    version: '0.6.1',
    date: '2026-11-04',
    title: 'Public pages: safety fixes',
    pr: 21,
    changes: [
      {
        id: 'public-pages-safety',
        type: 'fix',
        title: 'Public pages are safer and serve the right format',
        detail: 'Text on public pages is escaped, private material stays out, and asking for RDF gets RDF.',
        roles: [],
      },
    ],
  },
  {
    version: '0.6.0',
    date: '2026-11-04',
    title: 'A new look',
    pr: 16,
    changes: [
      {
        id: 'looks',
        type: 'feat',
        title: 'A new look, with three to choose from',
        detail: 'Concord now looks like a specification rather than a generic AI app. You can switch between the Specification, Civic grid and Workbench looks under Settings, Appearance.',
        roles: [],
        to: '/settings',
        ask: 'Which look would you want to use day to day, and why?',
      },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-11-04',
    title: 'Public ontology pages',
    pr: 14,
    changes: [
      {
        id: 'public-pages',
        type: 'feat',
        title: 'Public pages at each ontology and version IRI',
        detail: 'Every ontology and released version has a public page at its IRI that anyone can read without signing in. Tools that ask for Turtle or JSON-LD get that instead.',
        roles: ['steward', 'odi', 'member', 'agent'],
        to: '{o}/releases',
        tasks: ['merge'],
        ask: 'Would the public page work as the place you point people to for a released standard?',
      },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-11-04',
    title: 'Simpler navigation',
    pr: 10,
    changes: [
      {
        id: 'ia-sections',
        type: 'feat',
        title: 'Simpler navigation inside each ontology',
        detail: 'Ontology pages are grouped into a few sections that follow the lifecycle, and each page starts with a summary before the detail.',
        roles: [],
        to: '{o}',
        ask: 'How easy is it to find your way around an ontology now?',
      },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-11-04',
    title: 'A principled FAIR score',
    pr: 12,
    changes: [
      {
        id: 'fair-score',
        type: 'feat',
        title: 'FAIR score with a breakdown by principle',
        detail: 'The FAIR score is now worked out per principle (Findable, Accessible, Interoperable, Reusable), and shows what to fix to raise it.',
        roles: ['steward', 'odi', 'member'],
        to: '{o}',
        tasks: ['review'],
        ask: 'Does the FAIR breakdown tell you what to fix?',
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-11-04',
    title: 'Highlighting and a query builder',
    pr: 8,
    changes: [
      {
        id: 'syntax-highlighting',
        type: 'feat',
        title: 'Syntax highlighting in every format',
        detail: 'Turtle, JSON-LD, RDF/XML, LinkML, YAML-LD, SHACL and the other views are now highlighted.',
        roles: ['steward', 'contributor', 'agent', 'odi'],
        to: '{o}/source',
        tasks: ['linkml'],
      },
      {
        id: 'query-builder',
        type: 'feat',
        title: 'SPARQL highlighting and a visual query builder',
        detail: 'The Query page highlights SPARQL and can build a query for you from the classes and properties you pick.',
        roles: ['steward', 'agent', 'contributor'],
        to: '{o}/query',
        ask: 'Could you get the answer you wanted out of the Query page?',
      },
      {
        id: 'query-wasm',
        type: 'fix',
        title: 'The Query page loads again',
        detail: 'Fixed the WebAssembly error that stopped queries running in the browser.',
        roles: [],
        to: '{o}/query',
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10-14',
    title: 'First prototype',
    pr: 1,
    changes: [
      {
        id: 'prototype',
        type: 'feat',
        title: 'The first Concord prototype',
        detail:
          'Use case interviews by chat or voice, meeting transcripts, change requests classified as patch, minor or major, governance policies, releases, coding agents over MCP, and this guided walkthrough.',
        roles: [],
        to: '/alpha',
      },
    ],
  },
];

/** The version of the app this code is. */
export const APP_VERSION = APP_RELEASES[0].version;

/* ------------------------------------------------------------------ semver */

export function parseVersion(v: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Negative if a < b, 0 if equal, positive if a > b. Unparseable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [-1, -1, -1];
  const pb = parseVersion(b) ?? [-1, -1, -1];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export type BumpLevel = 'major' | 'minor' | 'patch';

/** The bump semantic-release would make for these changes. */
export function bumpFor(changes: Pick<AppChange, 'type'>[]): BumpLevel {
  if (changes.some((c) => c.type === 'breaking')) return 'major';
  if (changes.some((c) => c.type === 'feat')) return 'minor';
  return 'patch';
}

export function bumpVersion(v: string, level: BumpLevel): string {
  const [ma, mi, pa] = parseVersion(v) ?? [0, 0, 0];
  if (level === 'major') return `${ma + 1}.0.0`;
  if (level === 'minor') return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
}

/* ----------------------------------------------------------------- queries */

export const findRelease = (version: string) => APP_RELEASES.find((r) => compareVersions(r.version, version) === 0 && parseVersion(version));

/** Releases after `since` up to and including `upTo` (default: this version), newest first. */
export function releasesSince(since: string, upTo: string = APP_VERSION): AppRelease[] {
  if (!parseVersion(since)) return [];
  return APP_RELEASES.filter((r) => compareVersions(r.version, since) > 0 && compareVersions(r.version, upTo) <= 0);
}

export interface ChangeWithRelease extends AppChange {
  version: string;
  date: string;
}

export function changesSince(since: string, upTo: string = APP_VERSION): ChangeWithRelease[] {
  return releasesSince(since, upTo).flatMap((r) => r.changes.map((c) => ({ ...c, version: r.version, date: r.date })));
}

/** Does this change matter to someone testing as this role? Changes with no roles matter to everyone. */
export const changeIsFor = (c: Pick<AppChange, 'roles'>, role?: TesterRoleKey) => !c.roles.length || !role || c.roles.includes(role);

/** Changes a tester in this role should look at first: features before fixes, and within each, their role's, then everyone's, then other roles'. */
export function changesFor(changes: ChangeWithRelease[], role?: TesterRoleKey): ChangeWithRelease[] {
  const rank = (c: ChangeWithRelease) => (c.type === 'fix' ? 10 : 0) + (role && c.roles.includes(role) ? 0 : !c.roles.length ? 1 : 2);
  return changes
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);
}

/* -------------------------------------------------------- tester records */

/** One version a tester has used, as saved in their pod (concord/alpha/testing.jsonld). */
export interface TestedVersion {
  version: string;
  /** Git commit of the web build, when known. */
  commit?: string;
  firstAt: string;
  lastAt: string;
  /** Feedback submitted while on this version. */
  feedbackIds: string[];
  /** Tester roles tried on this version. */
  roles?: TesterRoleKey[];
}

export interface AlphaTesterInfo {
  id: string;
  name: string;
  avatarUrl?: string;
  /** Signed in with Google or GitHub, so they can come back from any browser. */
  lasting: boolean;
  providers: string[];
  podUrl?: string;
}

export interface AlphaMe {
  /** The tester's own account (not the persona they are playing). Undefined when nobody is signed in. */
  tester?: AlphaTesterInfo;
  versions: TestedVersion[];
  /** Where the record lives: their Solid pod, or this server's private store when no Solid server is configured. */
  storedIn?: 'solid' | 'local';
  recordUrl?: string;
  /** The copy in their pod is behind (the pod couldn't be written to); it catches up on a later visit. The history here is complete. */
  podBehind?: boolean;
}

/** The newest version a tester used before `current`, if any. */
export function lastTestedBefore(versions: Pick<TestedVersion, 'version'>[], current: string = APP_VERSION): string | undefined {
  return versions
    .map((v) => v.version)
    .filter((v) => parseVersion(v) && compareVersions(v, current) < 0)
    .sort(compareVersions)
    .at(-1);
}
