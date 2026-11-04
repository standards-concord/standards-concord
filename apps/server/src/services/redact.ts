import type { ChangeOp } from '@concord/core/types';
import type { ChangeRequest, UseCase } from '@concord/shared';
import { get, list } from '../db.js';
import { getUser } from './users.js';

/**
 * Keeps use case titles and contributor names out of the ontology, which is
 * published (the public page, every download, GitHub) while use cases may be
 * private. Used wherever drafted edits come from use cases (synthesis, AI
 * revisions), and again at merge, release and startup clean-up, so nothing
 * stored before these checks existed can slip through.
 *
 * Secrets are matched by their words, however either side is written
 * (SecretPilot, secret_pilot-record, "Secret  Pilot record", MacDonald), and
 * wherever they appear: in free text the whole word or identifier holding one
 * is replaced with "a use case" or "a participant" (never inside a
 * replacement already made, so running it again changes nothing); names
 * (labels, alternative labels, local names, edit lists) holding one are left
 * out. Titles made only of common words ("a", "use", "record", "the plan")
 * are not treated as secret: they reveal nothing and would mangle ordinary
 * text. People's names always are, but a one-letter or common-word name
 * ("An", "Will") only as written.
 */
export interface Secret {
  /** The words, as first written. */
  words: string[];
  /** Matched only as written: a one-letter secret, or a name made only of common words ("An", "Will"). */
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
    const strict = oneLetter(ws) || ws.every((w) => COMMON.has(w.toLowerCase()));
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

/** Several sets of secrets as one. */
export const allSecrets = (xs: (Secrets | undefined)[]): Secrets => ({ titles: xs.flatMap((x) => x?.titles ?? []), people: xs.flatMap((x) => x?.people ?? []) });

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
  const kinds: [Secret[], string][] = [
    [s.titles, 'a use case'],
    [s.people, 'a participant'],
  ];
  for (const [secrets, replacement] of kinds)
    for (const secret of secrets) {
      // Word boundaries inside a secret don't matter (MacDonald, Macdonald, Mac Donald); its ends do.
      const key = secret.strict ? secret.words.join('') : secret.words.join('').toLowerCase();
      for (let i = 0; i < toks.length; i++) {
        let acc = '';
        for (let j = i; j < toks.length && !kept.has(j); j++) {
          acc += secret.strict ? toks[j].text : toks[j].text.toLowerCase();
          if (acc === key) {
            found.push({ from: toks[i].runStart, to: toks[j].runEnd, replacement, partial: toks[i].runStart !== toks[i].start || toks[j].runEnd !== toks[j].end });
            break;
          }
          if (!key.startsWith(acc)) break;
        }
      }
    }
  // Longest first, then leftmost; overlapping matches are one.
  found.sort((a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from);
  const chosen: Match[] = [];
  for (const m of found) if (!chosen.some((c) => m.from < c.to && c.from < m.to)) chosen.push(m);
  return chosen.sort((a, b) => a.from - b.from);
}

/** Text with titles replaced by "a use case" and names by "a participant". Running it again changes nothing. */
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
  if (!name || (!s.titles.length && !s.people.length)) return false;
  return matches(name.normalize('NFKC'), s).length > 0;
}

const TEXT_FIELDS = ['definition', 'comment', 'editorialNote', 'reason', 'title', 'description'] as const;
const LIST_FIELDS = ['altLabels', 'examples'] as const;

/**
 * Redacts drafted edits: free text is rewritten, alternative labels and
 * examples that name a use case or a person are dropped, and a new term whose
 * label or local name would do so is left out altogether (listed in `dropped`
 * so the change request can say why).
 */
export function redactOps(ops: ChangeOp[], s: Secrets): { ops: ChangeOp[]; dropped: string[] } {
  const dropped: string[] = [];
  const out: ChangeOp[] = [];
  for (const op of ops) {
    const o = structuredClone(op) as Record<string, unknown>;
    // Only names this edit would publish: removing, renaming or deprecating an existing term stays possible.
    if ([o.label, o.localName, o.newLocalName].some((n) => typeof n === 'string' && revealing(n, s))) {
      dropped.push(String(o.newLocalName ?? o.localName ?? o.label));
      continue;
    }
    const scrub = (rec: Record<string, unknown>) => {
      for (const f of TEXT_FIELDS) if (typeof rec[f] === 'string') rec[f] = redactText(rec[f] as string, s);
      // Alternative labels are names, checked however they're written; examples may hold either.
      for (const f of LIST_FIELDS) if (Array.isArray(rec[f])) rec[f] = (rec[f] as unknown[]).filter((v) => typeof v !== 'string' || !revealing(v, s));
      if (Array.isArray(rec.source)) rec.source = (rec.source as unknown[]).filter((v) => typeof v !== 'string' || !/^use cases?:/i.test(v));
      else if (typeof rec.source === 'string' && /^use cases?:/i.test(rec.source)) delete rec.source;
      if (typeof rec.label === 'string' && revealing(rec.label, s)) delete rec.label;
    };
    scrub(o);
    if (o.set && typeof o.set === 'object') scrub(o.set as Record<string, unknown>);
    out.push(o as unknown as ChangeOp);
  }
  return { ops: out, dropped };
}

/** Lines of an edit list (KGCL) or notes, safe to publish: redacted, and any line still naming a secret (in an identifier, say) left out. */
export function publishableLines(lines: string[], s: Secrets): string[] {
  if (!s.titles.length && !s.people.length) return lines;
  return lines
    .filter((l) => !matches(l.normalize('NFKC'), s).some((m) => m.partial))
    .map((l) => redactText(l, s))
    .filter((l) => !revealing(l, s));
}

/** Release notes, safe to publish. */
export function publishableNotes(notes: string, s: Secrets): string {
  if (!s.titles.length && !s.people.length) return notes;
  const out = publishableLines(notes.split('\n'), s).join('\n');
  return out === notes ? notes : out;
}
