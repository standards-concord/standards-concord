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
 * Two kinds of check:
 *   - free text: whole-word matches are replaced with "a use case" or "a
 *     participant", never inside a replacement already made, so running it
 *     again changes nothing;
 *   - names (labels, alternative labels, local names, edit lists): split into
 *     words however they're written (SecretPilotRecord, secret_pilot-record,
 *     "Secret  Pilot record"), and caught if a title's or name's words appear
 *     in order.
 * Titles made only of common words ("a", "use", "record", "the plan") are
 * not treated as secret: they reveal nothing and would mangle ordinary text.
 */
export interface Secrets {
  /** Each secret as its words, lower case. */
  titles: string[][];
  people: string[][];
}

const PLACEHOLDERS = ['a use case', 'a participant'];

/** Words too common to identify a use case on their own. */
const COMMON = new Set(
  `a an the and or of to in on for by with from at as is are be was were this that these those it its into over under about per via not no
  use uses used using case cases record records data item items thing things type types class classes term terms value values name names
  new old plan plans project projects test tests example examples demo draft list lists set sets group groups event events time times
  info information model models system systems service services report reports user users person people place places work my our your
  one two three first second other more most all any some each`.split(/\s+/),
);

/** Words of a name or text, however it is written: camelCase, snake_case, kebab-case, spaces. */
export function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** A title worth keeping secret: at least one word that isn't common; a single letter only if it's a capital or digit. */
function distinctive(value: string): boolean {
  const ws = words(value);
  if (!ws.length) return false;
  if (ws.length === 1 && [...ws[0]].length === 1) return /\p{Lu}|\p{N}/u.test(value.trim());
  return ws.some((w) => !COMMON.has(w));
}

function secretWords(values: (string | undefined)[]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const v of values) {
    if (!v || !distinctive(v)) continue;
    const ws = words(v);
    const key = ws.join(' ');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(ws);
    }
  }
  return out.sort((a, b) => b.join(' ').length - a.join(' ').length);
}

/** Every title the use cases have had, and the names of the people who wrote them. */
export function secretsFor(useCases: UseCase[], extra: { titles?: string[]; people?: string[] } = {}): Secrets {
  return {
    titles: secretWords([...useCases.flatMap((u) => [u.sections.name, ...(u.formerTitles ?? [])]), ...(extra.titles ?? [])]),
    people: secretWords([...useCases.map((u) => getUser(u.authorId)?.name), ...(extra.people ?? [])]),
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

const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const KEEP = PLACEHOLDERS.map((p) => p.split(' ').join('\\s+'));

/** Text with titles replaced by "a use case" and names by "a participant". Running it again changes nothing. */
export function redactText(text: string, s: Secrets): string;
export function redactText(text: string | undefined, s: Secrets): string | undefined;
export function redactText(text: string | undefined, s: Secrets): string | undefined {
  if (text === undefined || (!s.titles.length && !s.people.length)) return text;
  const normalized = text.normalize('NFKC');
  const kinds: [string[][], string][] = [
    [s.titles, 'a use case'],
    [s.people, 'a participant'],
  ];
  let out = normalized;
  for (const [secrets, replacement] of kinds) {
    for (const ws of secrets) {
      // A one-letter secret ("X") only as written; anything else regardless of case.
      const oneLetter = ws.length === 1 && [...ws[0]].length === 1;
      const body = oneLetter ? ws[0].toUpperCase().replace(ESCAPE, '\\$&') : ws.map((w) => w.replace(ESCAPE, '\\$&')).join('[^\\p{L}\\p{N}]+');
      // Placeholders are matched first and kept, so a replacement is never rewritten.
      const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:(${KEEP.join('|')})|${body})(?![\\p{L}\\p{N}])`, oneLetter ? 'gu' : 'giu');
      out = out.replace(re, (m: string, kept: string | undefined) => (kept ? m : replacement));
    }
  }
  return out === normalized ? text : out;
}

const contains = (hay: string[], needle: string[]) => {
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((w, j) => hay[i + j] === w)) return true;
  return false;
};

/** Would this name, label or line publish a title or a person, anywhere inside it? */
export function revealing(name: string | undefined, s: Secrets): boolean {
  if (!name) return false;
  const ws = words(name);
  return [...s.titles, ...s.people].some((secret) =>
    secret.length === 1 && [...secret[0]].length === 1
      ? // A one-letter title counts only as its own capitalised word.
        name.normalize('NFKC').split(/[^\p{L}\p{N}]+/u).includes(secret[0].toUpperCase())
      : contains(ws, secret),
  );
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
  return lines.map((l) => redactText(l, s)).filter((l) => !revealing(l, s));
}

/** Release notes, safe to publish. */
export function publishableNotes(notes: string, s: Secrets): string {
  if (!s.titles.length && !s.people.length) return notes;
  const out = publishableLines(notes.split('\n'), s).join('\n');
  return out === notes ? notes : out;
}
