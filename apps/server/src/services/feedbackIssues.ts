import { createHash } from 'node:crypto';
import type { FeedbackSubmission } from '@concord/shared';
import { config } from '../config.js';
import { get, list, put } from '../db.js';
import { FEEDBACK_QUESTIONS } from './feedback.js';

/**
 * Tester feedback becomes a GitHub issue, so it can be triaged and acted on
 * where the code lives. Issues are anonymised: no name, email, account, WebID
 * or chat transcript, and contact details are scrubbed from free text, because
 * the repository may be public.
 *
 * Enabled by FEEDBACK_GITHUB_TOKEN (a fine-grained token with Issues: read and
 * write on FEEDBACK_GITHUB_REPO). Without it nothing leaves the server.
 */

export const FEEDBACK_LABELS = ['feedback', 'needs-triage'];
export const marker = (id: string) => `<!-- concord-feedback: ${id} -->`;

type Issue = NonNullable<FeedbackSubmission['githubIssue']>;
interface Kv<T> {
  id: string;
  value: T;
}

const MAX_ATTEMPTS = 8;
const TITLE_MAX = 100;

export const issuesEnabled = () => !!config.feedbackIssues.token && /^[\w.-]+\/[\w.-]+$/.test(config.feedbackIssues.repo);

/* ------------------------------ anonymising ----------------------------- */

const ownHosts = () =>
  new Set(
    [config.publicUrl, config.webUrl]
      .map((u) => {
        try {
          return new URL(u).host;
        } catch {
          return '';
        }
      })
      .filter(Boolean),
  );

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove contact details and the submitter's own name from free text. Links to
 * pages of this app are kept (they help triage) unless they point at a person
 * (a WebID or pod); every other link is removed.
 */
export function redact(text: string, names: string[] = []): string {
  const hosts = ownHosts();
  let t = text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email removed]')
    .replace(/\bhttps?:\/\/[^\s<>()"'`]+/gi, (url) => {
      try {
        const u = new URL(url.replace(/[.,;:!?]+$/, ''));
        const personal = /webid|\/pods?\/|\/profile\/|#me\b|\/u\//i.test(u.pathname + u.hash) || /^pods?\./i.test(u.hostname);
        if (hosts.has(u.host) && !personal) return url;
      } catch {
        /* not a URL after all */
      }
      return '[link removed]';
    })
    // Phone numbers: 9+ digits, allowing spaces, dots, dashes and brackets, with an optional +.
    .replace(/(?<![\w/.])\+?\d[\d\s().-]{7,}\d(?![\w/])/g, (m) => (m.replace(/\D/g, '').length >= 9 ? '[phone removed]' : m))
    .replace(/@[A-Za-z0-9-]{2,39}\b/g, '[handle removed]');
  const parts = [...new Set(names.flatMap((n) => [n.trim(), ...n.trim().split(/\s+/)]).filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length);
  for (const n of parts) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'giu'), '[name removed]');
  return t;
}

const asText = (v: FeedbackSubmission['answers'][string] | undefined) => (v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v)).trim();
const meaningful = (v: string) => v !== '' && v !== '(skipped)';

/** Names to scrub: the submitter's own, as they typed it or from their account. */
const namesOf = (sub: FeedbackSubmission) => {
  const names = [sub.name ?? ''];
  if (sub.userId) names.push(get<{ name?: string }>('users', sub.userId)?.name ?? '');
  if (sub.email) names.push(sub.email.split('@')[0].replace(/[._-]+/g, ' '));
  return names.filter(Boolean);
};

/** The first thing the tester said was missing or wrong, as the issue's title. */
export function issueTitle(sub: FeedbackSubmission, names = namesOf(sub)): string {
  for (const k of ['missing', 'general', 'comments', 'new:other', 'gov_other', 'valuable']) {
    const v = asText(sub.answers[k]);
    if (!meaningful(v)) continue;
    const line = redact(v, names).split(/\n/)[0].replace(/\s+/g, ' ').trim();
    if (!line) continue;
    return `Feedback: ${line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line}`;
  }
  return `Feedback from a tester (${sub.pathway === 'general' ? 'open conversation' : 'questionnaire'})`;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/** The issue body: a marker for de-duplication, then the answers, anonymised. */
export function issueBody(sub: FeedbackSubmission, names = namesOf(sub)): string {
  const byId = new Map(FEEDBACK_QUESTIONS.map((q) => [q.id, q]));
  const rows: [string, string][] = [
    ['Pathway', sub.pathway === 'general' ? 'Open conversation' : sub.pathway === 'structured' ? 'Questionnaire' : String(sub.pathway)],
    ['Tester role', sub.role ? redact(String(sub.role), names) : 'not given'],
    ['Voice input', sub.usedVoice ? 'yes' : 'no'],
  ];
  const extra = sub as FeedbackSubmission & { appVersion?: string };
  if (extra.appVersion) rows.push(['App version', redact(String(extra.appVersion), names)]);
  rows.push(['Submitted', sub.createdAt.slice(0, 10)]);

  const sections = new Map<string, string[]>();
  const add = (section: string, line: string) => sections.set(section, [...(sections.get(section) ?? []), line]);
  for (const [id, value] of Object.entries(sub.answers)) {
    const text = asText(value);
    if (!meaningful(text)) continue;
    const q = byId.get(id);
    const answer = redact(text, names);
    const label = q?.text ?? (id === 'general' ? 'What they said' : id.replace(/^new:/, 'About a recent change: '));
    const section = q?.section ?? (id === 'general' ? 'In their own words' : 'Other');
    add(section, answer.includes('\n') ? `**${label}**\n\n${answer.split('\n').map((l) => `> ${l}`).join('\n')}` : `**${label}**  \n${answer}`);
  }
  if (sub.themes?.length) add('Themes', sub.themes.map((t) => `- ${redact(t, names)}`).join('\n'));

  return [
    marker(sub.id),
    '_Tester feedback from Concord, filed automatically. It is anonymised: the tester’s name, email, account and chat transcript are left out, and contact details are removed from what they wrote._',
    '',
    '| | |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`),
    '',
    ...[...sections.entries()].flatMap(([s, lines]) => [`### ${s}`, '', lines.join('\n\n'), '']),
  ].join('\n');
}

/** Two submissions with the same answers are the same feedback (a double click or resubmission). */
export function dedupeKey(sub: FeedbackSubmission): string {
  const norm = Object.entries(sub.answers)
    .map(([k, v]) => [k, asText(v).toLowerCase().replace(/\s+/g, ' ')] as const)
    .filter(([, v]) => meaningful(v))
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify([sub.pathway, norm])).digest('hex').slice(0, 32);
}

/* ------------------------------ GitHub ---------------------------------- */

const safeError = (msg: string) => (config.feedbackIssues.token ? msg.split(config.feedbackIssues.token).join('***') : msg);

async function createIssue(title: string, body: string): Promise<Issue> {
  const { apiUrl, repo, token } = config.feedbackIssues;
  const res = await fetch(`${apiUrl}/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'concord-feedback',
    },
    body: JSON.stringify({ title, body, labels: FEEDBACK_LABELS }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`.trim());
  const j = (await res.json()) as { number: number; html_url: string };
  return { number: j.number, url: j.html_url };
}

/* ------------------------------ filing ---------------------------------- */

const inflight = new Map<string, Promise<Issue | undefined>>();
let windowStart = 0;
let filedInWindow = 0;

/** At most this many issues an hour, so a flood of submissions can't flood the repo. The rest wait. */
function underHourlyCap() {
  const now = Date.now();
  if (now - windowStart > 60 * 60_000) {
    windowStart = now;
    filedInWindow = 0;
  }
  return filedInWindow < config.feedbackIssues.perHour;
}

/**
 * Feedback stored before issues were switched on isn't filed unless
 * FEEDBACK_ISSUES_BACKFILL is set: testers gave it without being told it
 * would become an issue.
 */
function preexisting(): Set<string> {
  let rec = get<Kv<string[]>>('kv', 'feedback-issues:preexisting');
  if (!rec) {
    rec = { id: 'feedback-issues:preexisting', value: config.feedbackIssues.backfill ? [] : list<FeedbackSubmission>('feedback').filter((s) => !s.githubIssue).map((s) => s.id) };
    put('kv', rec);
  }
  return new Set(rec.value);
}

const attemptsKey = (id: string) => `feedback-issues:attempts:${id}`;

/** File one submission as an issue (or link it to the issue for identical feedback). Never throws. */
export function fileFeedbackIssue(sub: FeedbackSubmission): Promise<Issue | undefined> {
  if (!issuesEnabled() || sub.githubIssue) return Promise.resolve(sub.githubIssue);
  const running = inflight.get(sub.id);
  if (running) return running;
  const p = (async () => {
    try {
      if (!Object.values(sub.answers).some((v) => meaningful(asText(v)))) return undefined;
      const key = dedupeKey(sub);
      const dup = get<Kv<Issue>>('kv', `feedback-issues:key:${key}`);
      let issue = dup?.value;
      if (!issue) {
        const attempts = get<Kv<number>>('kv', attemptsKey(sub.id))?.value ?? 0;
        if (attempts >= MAX_ATTEMPTS || !underHourlyCap()) return undefined;
        put('kv', { id: attemptsKey(sub.id), value: attempts + 1 });
        filedInWindow++;
        issue = await createIssue(issueTitle(sub), issueBody(sub));
        put('kv', { id: `feedback-issues:key:${key}`, value: issue });
      }
      // Re-read: the submission may have changed while GitHub answered.
      const latest = get<FeedbackSubmission>('feedback', sub.id) ?? sub;
      put('feedback', { ...latest, githubIssue: issue });
      return issue;
    } catch (err) {
      console.warn(`[feedback] could not open a GitHub issue for ${sub.id}: ${safeError((err as Error).message)}`);
      return undefined;
    } finally {
      inflight.delete(sub.id);
    }
  })();
  inflight.set(sub.id, p);
  return p;
}

/** Wait briefly for the issue so the tester can be told; filing carries on in the background if GitHub is slow. */
export async function fileWithin(sub: FeedbackSubmission, ms = 4000): Promise<Issue | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([fileFeedbackIssue(sub), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Retry anything not yet filed (GitHub down, hourly cap reached). Run on a timer. */
export async function fileOutstandingFeedback(): Promise<number> {
  if (!issuesEnabled()) return 0;
  const skip = preexisting();
  let filed = 0;
  for (const sub of list<FeedbackSubmission>('feedback')) {
    if (sub.githubIssue || skip.has(sub.id)) continue;
    if (await fileFeedbackIssue(sub)) filed++;
  }
  return filed;
}

/**
 * Record which feedback was already stored when issues were switched on. Call
 * it at start-up and before storing a submission, so a new one is never
 * mistaken for old.
 */
export function markSwitchOn() {
  if (issuesEnabled()) preexisting();
}

/** Test hook. */
export function resetFeedbackIssueState() {
  inflight.clear();
  windowStart = 0;
  filedInWindow = 0;
}
