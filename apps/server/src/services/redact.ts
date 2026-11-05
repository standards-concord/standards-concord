import type { ChangeRequest, UseCase } from '@concord/shared';
import { get, list } from '../db.js';
import { getUser } from './users.js';

/**
 * Spots use case titles and people's names in text, to highlight them for
 * the person approving what goes public (a change drafted from use cases, or
 * a version published before approvals existed). A hint, never a verdict:
 * nothing is published, held or rewritten because of what this finds, since
 * no matcher catches every way a name can be written. Nothing rewrites text
 * with it: redactText exists only so tests can check exactly what it spans.
 *
 * Secrets are matched by their words, however either side is written
 * (SecretPilot, secret_pilot-record, "Secret  Pilot record", MacDonald).
 * Titles made only of common words ("a", "use", "record", "the plan") are
 * not looked for: they'd highlight ordinary text. People's names always are,
 * but a one-letter or common-word name ("An", "Will") only as written.
 */
export interface Secret {
  /** The words, as first written. */
  words: string[];
  /** Matched only as written (or in capitals): a one-letter secret, or a name made only of ordinary words ("An", "Will"). */
  strict: boolean;
}
export interface Secrets {
  titles: Secret[];
  people: Secret[];
}

/** Words too common to identify a use case on their own. */
const COMMON = new Set(
  `a an the and or of to in on for by with from at as is are be was were this that these those it its into over under about per via not no
  use uses used using case cases record records data item items thing things type types class classes term terms value values name names
  new old plan plans project projects test tests example examples demo draft list lists set sets group groups event events time times
  info information model models system systems service services report reports user users person people place places work my our your
  one two three first second other more most all any some each`.split(/\s+/),
);

/** Ordinary words that are also names: a person called Will or May is matched only as written (Will, WILL). */
const NAME_WORDS = new Set(
  `will mark may june rose grace hope joy faith art rob pat sue jack frank guy dean lane ray max sky summer april august victor earl rich chase
  hunter cliff gene bill penny ivy holly dawn eve iris lily violet amber ruby pearl crystal destiny honor sterling an al ed bo jo di
  sam tom tim kim lee ben dan don ken ron ted val viv win drew rex king major sunny storm river brook glen heath forest`.split(/\s+/),
);
const plain = (w: string) => COMMON.has(w.toLowerCase()) || NAME_WORDS.has(w.toLowerCase());

const fold = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

interface Token {
  text: string;
  start: number;
  end: number;
  /** The run of letters and digits the token is part of (SecretPilotRecord is one run of three tokens). */
  runStart: number;
  runEnd: number;
}

const CAMEL = /(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/gu;

/** Words of a name or text with their positions, however it is written: camelCase, snake_case, kebab-case, spaces. */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const run = m[0];
    const runStart = m.index;
    const runEnd = runStart + run.length;
    const cuts = [0, ...[...run.matchAll(CAMEL)].map((c) => c.index), run.length];
    for (let i = 0; i + 1 < cuts.length; i++)
      if (cuts[i + 1] > cuts[i]) out.push({ text: run.slice(cuts[i], cuts[i + 1]), start: runStart + cuts[i], end: runStart + cuts[i + 1], runStart, runEnd });
  }
  return out;
}

/** Words of a name or text, lower case, however it is written. */
export function words(text: string): string[] {
  return tokens(text.normalize('NFKC')).map((t) => t.text.toLowerCase());
}

const oneLetter = (ws: string[]) => ws.length === 1 && [...ws[0]].length === 1;

/** A title worth keeping secret: at least one word that isn't common; a single letter only if it's a capital or digit. */
function distinctive(value: string): boolean {
  const ws = words(value);
  if (!ws.length) return false;
  if (oneLetter(ws)) return /\p{Lu}|\p{N}/u.test(value.trim());
  return ws.some((w) => !COMMON.has(w));
}

function toSecrets(values: (string | undefined)[], keep: (v: string) => boolean): Secret[] {
  const seen = new Set<string>();
  const out: Secret[] = [];
  for (const v of values) {
    if (!v || !keep(v)) continue;
    const ws = tokens(v.normalize('NFKC')).map((t) => t.text);
    if (!ws.length) continue;
    const strict = oneLetter(ws) || ws.every(plain);
    const key = `${strict}:${strict ? ws.join(' ') : ws.join(' ').toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ words: ws, strict });
    }
  }
  return out;
}

/**
 * Every title the use cases have had, and the names of the people who wrote
 * them. Titles made only of common words are left out (they reveal nothing);
 * names never are, however ordinary: they're matched as written instead.
 */
export function secretsFor(useCases: UseCase[], extra: { titles?: string[]; people?: string[] } = {}): Secrets {
  return {
    titles: toSecrets([...useCases.flatMap((u) => [u.sections.name, ...(u.formerTitles ?? [])]), ...(extra.titles ?? [])], distinctive),
    people: toSecrets([...useCases.map((u) => getUser(u.authorId)?.name), ...(extra.people ?? [])], () => true),
  };
}

/**
 * The secrets a change request must keep out of the ontology: those of the
 * use cases it was synthesised from (or, when an older request didn't record
 * them, every use case in its ontology). Other requests are members' own words.
 */
export function secretsOf(cr: Pick<ChangeRequest, 'origin' | 'ontologyId'>): Secrets | undefined {
  if (cr.origin.type !== 'synthesis') return undefined;
  const ucs = cr.origin.useCaseIds.length
    ? cr.origin.useCaseIds.map((id) => get<UseCase>('useCases', id)).filter((u): u is UseCase => !!u)
    : list<UseCase>('useCases', cr.ontologyId);
  return secretsFor(ucs);
}

const PLACEHOLDERS = [
  ['a', 'use', 'case'],
  ['a', 'participant'],
];

interface Match {
  from: number;
  to: number;
  replacement: string;
  /** Part of a longer identifier (SecretPilotRecord): replacing it would leave a name that means nothing. */
  partial: boolean;
}

/**
 * Where secrets appear in a text: runs of words spelling a secret (any case,
 * any separators, inside identifiers too; strict secrets only as written),
 * widened to the whole identifier they sit in. Never inside a
 * placeholder an earlier redaction left.
 */
function matches(text: string, s: Secrets): Match[] {
  const toks = tokens(text);
  const kept = new Set<number>();
  for (const ph of PLACEHOLDERS)
    for (let i = 0; i + ph.length <= toks.length; i++) if (ph.every((w, j) => toks[i + j].text.toLowerCase() === w)) ph.forEach((_, j) => kept.add(i + j));
  const found: Match[] = [];
  // Runs of letters and digits, with the tokens in each.
  const runs: { text: string; tokens: number[] }[] = [];
  toks.forEach((t, i) => {
    const last = runs[runs.length - 1];
    if (last && toks[last.tokens[0]].runStart === t.runStart) last.tokens.push(i);
    else runs.push({ text: text.slice(t.runStart, t.runEnd), tokens: [i] });
  });
  const push = (i: number, j: number, replacement: string) =>
    found.push({ from: toks[i].runStart, to: toks[j].runEnd, replacement, partial: toks[i].runStart !== toks[i].start || toks[j].runEnd !== toks[j].end });
  const kinds: [Secret[], string][] = [
    [s.titles, 'a use case'],
    [s.people, 'a participant'],
  ];
  for (const [secrets, replacement] of kinds)
    for (const secret of secrets) {
      const key = fold(secret.words.join(''));
      if (!key) continue;
      const wordsLower = secret.words.map((w) => fold(w));
      const caps = secret.words.join('').toUpperCase();
      const plural = (t: string, w: string) => t === w || t === `${w}s` || t === `${w}es`;
      /** One token against one word of the secret. */
      const same = (t: Token, j: number, last: boolean) =>
        secret.strict ? t.text === secret.words[j] || t.text === secret.words[j].toUpperCase() : last ? plural(fold(t.text), wordsLower[j]) : fold(t.text) === wordsLower[j];
      // 1. Word by word, across any separators: Secret Pilot, secret_pilot-records, SECRET PILOTS, MacDonald.
      for (let i = 0; i < toks.length; i++) {
        const n = wordsLower.length;
        if (i + n > toks.length) break;
        let ok = true;
        for (let j = 0; ok && j < n; j++) ok = !kept.has(i + j) && same(toks[i + j], j, j === n - 1);
        if (ok) push(i, i + n - 1, replacement);
      }
      // 2. Inside one run of letters and digits, however its words are joined (Macdonald, SECRETPILOTSRECORD, XRECORD).
      for (const run of runs) {
        if (run.tokens.some((t) => kept.has(t))) continue;
        const text = run.text;
        const upper = /\p{L}/u.test(text) && text === text.toUpperCase();
        const lower = text === text.toLowerCase();
        let hit = false;
        if (secret.strict) hit = upper && text.length > caps.length && (text.startsWith(caps) || text.endsWith(caps));
        else if (key.length >= 5) hit = fold(text).includes(key);
        else if (upper) hit = text.length > caps.length && (text.startsWith(caps) || text.endsWith(caps));
        else if (lower && key.length >= 4) hit = text.startsWith(key) && text.length > key.length;
        else if (fold(text) === key) hit = true;
        if (hit) push(run.tokens[0], run.tokens[run.tokens.length - 1], replacement);
      }
    }
  // Longest first, then leftmost; overlapping matches are one.
  found.sort((a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from);
  const chosen: Match[] = [];
  for (const m of found) if (!chosen.some((c) => m.from < c.to && c.from < m.to)) chosen.push(m);
  return chosen.sort((a, b) => a.from - b.from);
}

/** For tests only: text with titles replaced by "a use case" and names by "a participant". Running it again changes nothing. */
export function redactText(text: string, s: Secrets): string;
export function redactText(text: string | undefined, s: Secrets): string | undefined;
export function redactText(text: string | undefined, s: Secrets): string | undefined {
  if (text === undefined || (!s.titles.length && !s.people.length)) return text;
  const normalized = text.normalize('NFKC');
  const found = matches(normalized, s);
  if (!found.length) return text;
  let out = '';
  let at = 0;
  for (const m of found) {
    out += normalized.slice(at, m.from) + m.replacement;
    at = m.to;
  }
  return out + normalized.slice(at);
}

/** Would this name, label or line publish a title or a person, anywhere inside it? */
export function revealing(name: string | undefined, s: Secrets): boolean {
  return findSecrets(name, s).length > 0;
}

/**
 * Which kinds of secret a text would publish, if any. Deliberately eager
 * (everything redaction catches, and any long title or name however its
 * words are joined or spaced): where this is used, a false alarm costs a
 * person a look, while a miss would publish something private.
 */
export function findSecrets(text: string | undefined, s: Secrets): ('use case title' | 'name')[] {
  if (!text || (!s.titles.length && !s.people.length)) return [];
  const normalized = text.normalize('NFKC');
  const found = new Set<'use case title' | 'name'>();
  for (const m of matches(normalized, s)) found.add(m.replacement === 'a use case' ? 'use case title' : 'name');
  const folded = fold(normalized.replace(/\ba use case\b|\ba participant\b/gi, ' '));
  for (const [kind, list] of [
    ['use case title', s.titles],
    ['name', s.people],
  ] as const)
    for (const secret of list) {
      const key = fold(secret.words.join(''));
      if (!secret.strict && key.length >= 5 && folded.includes(key)) found.add(kind);
    }
  return [...found];
}
