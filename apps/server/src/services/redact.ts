import type { ChangeOp } from '@concord/core/types';
import type { ChangeRequest, UseCase } from '@concord/shared';
import { get } from '../db.js';
import { getUser } from './users.js';

/**
 * Keeps use case titles and contributor names out of the ontology, which is
 * published (the public page, every download, GitHub) while use cases may be
 * private. Used wherever drafted edits come from use cases (synthesis, AI
 * revisions), and again at merge, release and startup clean-up, so nothing
 * stored before these checks existed can slip through.
 */
export interface Secrets {
  titles: RegExp[];
  people: RegExp[];
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const source = (w: string) => w.split(/\s+/).map((part) => part.replace(ESCAPE, '\\$&')).join('\\s+');
const wholeWords = (alts: string[], flags: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, flags);

/**
 * Whole-word patterns for the values, tolerant of spacing differences.
 * Case-insensitive, except one-letter values, which only match as written
 * (a use case called "X", not every "x").
 */
function patterns(values: (string | undefined)[]): RegExp[] {
  const words = [...new Set(values.map((v) => v?.normalize('NFKC').trim()).filter((v): v is string => !!v))].sort((a, b) => b.length - a.length);
  const long = words.filter((w) => [...w].length > 1).map(source);
  const short = words.filter((w) => [...w].length === 1).map(source);
  return [...(long.length ? [wholeWords(long, 'giu')] : []), ...(short.length ? [wholeWords(short, 'gu')] : [])];
}

/** Every title the use cases have had, and the names of the people who wrote them. */
export function secretsFor(useCases: UseCase[]): Secrets {
  return {
    titles: patterns(useCases.flatMap((u) => [u.sections.name, ...(u.formerTitles ?? [])])),
    people: patterns(useCases.map((u) => getUser(u.authorId)?.name)),
  };
}

/**
 * The secrets a change request must keep out of the ontology: those of the
 * use cases it was synthesised from. Other requests are members' own words.
 */
export function secretsOf(cr: Pick<ChangeRequest, 'origin'>): Secrets | undefined {
  if (cr.origin.type !== 'synthesis' || !cr.origin.useCaseIds.length) return undefined;
  return secretsFor(cr.origin.useCaseIds.map((id) => get<UseCase>('useCases', id)).filter((u): u is UseCase => !!u));
}

/** Several sets of secrets as one. */
export const allSecrets = (xs: (Secrets | undefined)[]): Secrets => ({ titles: xs.flatMap((x) => x?.titles ?? []), people: xs.flatMap((x) => x?.people ?? []) });

const test = (res: RegExp[], text: string) => res.some((re) => new RegExp(re.source, re.flags.replace('g', '')).test(text.normalize('NFKC')));

/** Text with titles replaced by "a use case" and names by "a participant". */
export function redactText(text: string, s: Secrets): string;
export function redactText(text: string | undefined, s: Secrets): string | undefined;
export function redactText(text: string | undefined, s: Secrets): string | undefined {
  if (text === undefined) return text;
  let out = text.normalize('NFKC');
  for (const re of s.titles) out = out.replace(re, 'a use case');
  for (const re of s.people) out = out.replace(re, 'a participant');
  // Only rewrite when something was found, so untouched text keeps its exact form.
  return out === text.normalize('NFKC') ? text : out;
}

/** Splits identifiers into words: SecretPilotRecord, secret_pilot-record → "Secret Pilot Record". */
const spaced = (name: string) =>
  name
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/[_\-.]+/g, ' ');

/** Would this name or label publish a title or a person, anywhere inside it? */
export function revealing(name: string | undefined, s: Secrets): boolean {
  if (!name) return false;
  return [name, spaced(name)].some((n) => test(s.people, n) || test(s.titles, n));
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
    if ([o.label, o.localName, o.newLocalName].some((n) => revealing(n as string | undefined, s))) {
      dropped.push(String(o.newLocalName ?? o.localName ?? o.label));
      continue;
    }
    const scrub = (rec: Record<string, unknown>) => {
      for (const f of TEXT_FIELDS) if (typeof rec[f] === 'string') rec[f] = redactText(rec[f] as string, s);
      for (const f of LIST_FIELDS)
        if (Array.isArray(rec[f])) rec[f] = (rec[f] as unknown[]).filter((v) => typeof v !== 'string' || (!test(s.titles, v) && !test(s.people, v)));
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
