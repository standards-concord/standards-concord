import { createHash } from 'node:crypto';
import { get, HttpError, insertOnce, list, put, remove, transaction } from '../db.js';

/**
 * Git's object model, kept in the database instead of a repository on disk (Vercel has no disk and no git).
 *
 * Objects are serialised exactly as git serialises them and stored under their real SHA-1, so a commit made here
 * has the same id it would have in git, every id Concord already shows stays valid, and the same history can be
 * recreated byte for byte on GitHub. Objects never change and are never collected; refs are rows, and moving one
 * is a compare-and-swap in the caller's transaction.
 */

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';
type StoredObject = { id: string; type: ObjectType; data: string /* base64 */ };
type StoredRef = { id: string; repo: string; name: string; sha: string };

export interface Person {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  time: number;
  /** As git writes it, e.g. +0000. */
  tz: string;
}

export interface Commit {
  sha: string;
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

const FILE_MODE = '100644';
const TREE_MODE = '40000';

const header = (type: ObjectType, body: Buffer) => Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);

/** An object's git id. */
export function hashObject(type: ObjectType, body: Buffer | string): string {
  return createHash('sha1').update(header(type, Buffer.isBuffer(body) ? body : Buffer.from(body))).digest('hex');
}

/** Stores an object (once) and returns its id. */
export async function writeObject(type: ObjectType, body: Buffer | string): Promise<string> {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const sha = hashObject(type, buf);
  await insertOnce<StoredObject>('gitObjects', { id: sha, type, data: buf.toString('base64') });
  return sha;
}

export async function readObject(sha: string): Promise<{ type: ObjectType; body: Buffer } | undefined> {
  const o = await get<StoredObject>('gitObjects', sha);
  return o && { type: o.type, body: Buffer.from(o.data, 'base64') };
}

async function mustRead(sha: string, type: ObjectType): Promise<Buffer> {
  const o = await readObject(sha);
  if (!o || o.type !== type) throw new HttpError(404, `No ${type} ${sha}`);
  return o.body;
}

// --- trees -------------------------------------------------------------------------------------------------------

/** git orders tree entries by name, comparing a subtree's name as if it ended in "/". */
const sortKey = (e: TreeEntry) => (e.mode === TREE_MODE ? `${e.name}/` : e.name);
const byGitOrder = (a: TreeEntry, b: TreeEntry) => Buffer.compare(Buffer.from(sortKey(a)), Buffer.from(sortKey(b)));

export function serialiseTree(entries: TreeEntry[]): Buffer {
  return Buffer.concat(
    [...entries].sort(byGitOrder).map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')])),
  );
}

export function parseTree(body: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (let i = 0; i < body.length; ) {
    const space = body.indexOf(0x20, i);
    const nul = body.indexOf(0, space);
    out.push({ mode: body.subarray(i, space).toString(), name: body.subarray(space + 1, nul).toString(), sha: body.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return out;
}

export async function readTree(sha: string): Promise<TreeEntry[]> {
  return parseTree(await mustRead(sha, 'tree'));
}

/** The empty tree's id (the same in every git repository). */
export const EMPTY_TREE = hashObject('tree', Buffer.alloc(0));

/**
 * A tree like `base` (or empty) with `files` written (path → content) or removed (null). Directories left empty are
 * dropped, as git drops them. Returns the new tree's id.
 */
export async function writeTree(base: string | undefined, files: Record<string, string | null>): Promise<string> {
  // Group the changes by their first path segment, and apply them to each level in turn.
  const here: Record<string, string | null> = {};
  const below: Record<string, Record<string, string | null>> = {};
  for (const [file, content] of Object.entries(files)) {
    const slash = file.indexOf('/');
    if (slash < 0) here[file] = content;
    else (below[file.slice(0, slash)] ??= {})[file.slice(slash + 1)] = content;
  }
  const entries = new Map<string, TreeEntry>();
  if (base && base !== EMPTY_TREE) for (const e of await readTree(base)) entries.set(e.name, e);
  for (const [name, content] of Object.entries(here)) {
    if (content === null) entries.delete(name);
    else entries.set(name, { mode: FILE_MODE, name, sha: await writeObject('blob', content) });
  }
  for (const [dir, changes] of Object.entries(below)) {
    const current = entries.get(dir);
    const sub = await writeTree(current?.mode === TREE_MODE ? current.sha : undefined, changes);
    if (sub === EMPTY_TREE) entries.delete(dir);
    else entries.set(dir, { mode: TREE_MODE, name: dir, sha: sub });
  }
  return await writeObject('tree', serialiseTree([...entries.values()]));
}

/** The entry at `path` (a/b/c) in tree `tree`, or undefined. */
export async function entryAt(tree: string, path: string): Promise<TreeEntry | undefined> {
  const parts = path.split('/').filter(Boolean);
  let entry: TreeEntry | undefined = { mode: TREE_MODE, name: '', sha: tree };
  for (const part of parts) {
    if (entry?.mode !== TREE_MODE) return undefined;
    entry = (await readTree(entry.sha)).find((e) => e.name === part);
  }
  return entry;
}

/** A file's text at `path` in commit `commit`, or undefined if there is none. */
export async function readFile(commit: string, path: string): Promise<string | undefined> {
  const e = await entryAt((await readCommit(commit)).tree, path);
  if (!e || e.mode === TREE_MODE) return undefined;
  return (await mustRead(e.sha, 'blob')).toString('utf8');
}

/** The names directly inside the directory at `path` in commit `commit` ([] if it isn't one). */
export async function listDir(commit: string, path: string): Promise<TreeEntry[]> {
  const e = await entryAt((await readCommit(commit)).tree, path);
  return e?.mode === TREE_MODE ? await readTree(e.sha) : [];
}

// --- people -----------------------------------------------------------------------------------------------------

/**
 * Characters git trims from either end of a name or email ("crud", ident.c): every byte up to and including space
 * (so tabs, CR and LF too, but not Unicode spaces such as U+00A0, whose UTF-8 bytes are all above 127), and
 * , : ; < > " \ ' (not a full stop).
 */
const CRUD_ENDS = /^[\x00-\x20,:;<>"\\']+|[\x00-\x20,:;<>"\\']+$/g;

/**
 * Someone as git records them. git trims crud from both ends of a name and an email, then drops only LF, < and >
 * from what is left (a CR inside stays), and so does GitHub when it recreates a commit. An empty name, which git
 * refuses, becomes Concord.
 */
export function ident(name: string, email: string, at = new Date()): Person {
  const clean = (s: string) => s.replace(CRUD_ENDS, '').replace(/[\n<>]/g, '');
  return { name: clean(name) || 'Concord', email: clean(email), time: Math.floor(at.getTime() / 1000), tz: '+0000' };
}

/**
 * When, as git log's %aI shows it: strict ISO 8601 in the person's own offset, always as ±hh:mm. (Newer versions
 * of git write UTC as Z; the git store normalises that to +00:00 so neither store's answers depend on git's version.)
 */
export function isoDate(p: Person): string {
  const sign = p.tz.startsWith('-') ? -1 : 1;
  const offsetMin = sign * (Number(p.tz.slice(1, 3)) * 60 + Number(p.tz.slice(3, 5)));
  const local = new Date((p.time + offsetMin * 60) * 1000).toISOString().slice(0, 19);
  return `${local}${p.tz.slice(0, 3)}:${p.tz.slice(3, 5)}`;
}

// --- commits and tags --------------------------------------------------------------------------------------------

const person = (p: Person) => `${p.name} <${p.email}> ${p.time} ${p.tz}`;
const parsePerson = (s: string): Person => {
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(s);
  if (!m) throw new Error(`Unreadable signature: ${s}`);
  return { name: m[1], email: m[2], time: Number(m[3]), tz: m[4] };
};
/** git commit-tree -m (and tag -m) end the message with one newline. */
// (As git's strbuf_complete_line: an empty message stays empty.)
const withNewline = (message: string) => (message === '' || message.endsWith('\n') ? message : `${message}\n`);

export function serialiseCommit(c: Omit<Commit, 'sha'>): string {
  return [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`), `author ${person(c.author)}`, `committer ${person(c.committer)}`, '', withNewline(c.message)].join('\n');
}

export async function writeCommit(c: Omit<Commit, 'sha'>): Promise<string> {
  return await writeObject('commit', serialiseCommit(c));
}

const commitCache = new Map<string, Commit>();

export async function readCommit(sha: string): Promise<Commit> {
  const hit = commitCache.get(sha);
  if (hit) return hit;
  const text = (await mustRead(sha, 'commit')).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = text.slice(0, split).split('\n');
  const field = (k: string) => head.filter((l) => l.startsWith(`${k} `)).map((l) => l.slice(k.length + 1));
  const c: Commit = {
    sha,
    tree: field('tree')[0],
    parents: field('parent'),
    author: parsePerson(field('author')[0]),
    committer: parsePerson(field('committer')[0]),
    message: text.slice(split + 2),
  };
  commitCache.set(sha, c);
  return c;
}

/** The first line of a commit's message (git's %s). */
export const subject = (c: Commit) => c.message.split('\n\n')[0].replace(/\n/g, ' ').trim();

export function serialiseTag(t: { object: string; type: ObjectType; tag: string; tagger: Person; message: string }): string {
  return [`object ${t.object}`, `type ${t.type}`, `tag ${t.tag}`, `tagger ${person(t.tagger)}`, '', withNewline(t.message)].join('\n');
}

export async function writeTag(t: { object: string; type?: ObjectType; tag: string; tagger: Person; message: string }): Promise<string> {
  return await writeObject('tag', serialiseTag({ ...t, type: t.type ?? 'commit' }));
}

/** The commit a tag object (or a commit id) names. */
export async function peel(sha: string): Promise<string> {
  const o = await readObject(sha);
  if (o?.type !== 'tag') return sha;
  return await peel(/^object ([0-9a-f]{40})$/m.exec(o.body.toString('utf8'))![1]);
}

// --- history -----------------------------------------------------------------------------------------------------

/** Every commit reachable from `from` (inclusive). */
export async function reachable(from: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  const todo = [...from];
  while (todo.length) {
    const sha = todo.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    todo.push(...(await readCommit(sha)).parents);
  }
  return seen;
}

/** Whether `ancestor` is `of` or one of its ancestors. */
export async function isAncestor(ancestor: string, of: string): Promise<boolean> {
  // Usually `ancestor` is a commit or two back, so walk back from `of` and stop at it, rather than read all history.
  const seen = new Set<string>();
  const todo = [of];
  while (todo.length) {
    const sha = todo.shift()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    todo.push(...(await readCommit(sha)).parents);
  }
  return false;
}

/** First-parent history from `head` (newest first), stopping before any commit reachable from `exclude`. */
export async function firstParentLog(head: string, opts: { limit?: number; exclude?: string[] } = {}): Promise<Commit[]> {
  const stop = opts.exclude?.length ? await reachable(opts.exclude) : new Set<string>();
  const out: Commit[] = [];
  for (let sha: string | undefined = head; sha && !stop.has(sha) && out.length < (opts.limit ?? Infinity); ) {
    const c = await readCommit(sha);
    out.push(c);
    sha = c.parents[0];
  }
  return out;
}

/**
 * History from `heads` as plain git log shows it: every reachable commit (not only first parents), newest commit
 * date first, without any reachable from `exclude`.
 */
export async function dateOrderLog(heads: string[], opts: { limit?: number; exclude?: string[] } = {}): Promise<Commit[]> {
  const stop = opts.exclude?.length ? await reachable(opts.exclude) : new Set<string>();
  const seen = new Set<string>();
  const queue: Commit[] = [];
  const add = async (sha: string) => {
    if (seen.has(sha) || stop.has(sha)) return;
    seen.add(sha);
    queue.push(await readCommit(sha));
  };
  for (const h of heads) await add(h);
  const out: Commit[] = [];
  while (queue.length && out.length < (opts.limit ?? Infinity)) {
    // Newest committer date first; git breaks ties by the order commits were found, as this does.
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].committer.time > queue[best].committer.time) best = i;
    const [c] = queue.splice(best, 1);
    out.push(c);
    for (const p of c.parents) await add(p);
  }
  return out;
}

/** How many commits are reachable from `to` but not from `from` (git rev-list --count from..to). */
export async function countBetween(from: string, to: string): Promise<number> {
  const behind = await reachable([from]);
  let n = 0;
  for (const sha of await reachable([to])) if (!behind.has(sha)) n++;
  return n;
}

/** A best common ancestor of `a` and `b` (git merge-base), or undefined if they share none. */
export async function mergeBase(a: string, b: string): Promise<string | undefined> {
  const ofA = await reachable([a]);
  // Breadth first from b: the first commit also reachable from a, that no other common commit descends from.
  const common: string[] = [];
  for (const sha of await reachable([b])) if (ofA.has(sha)) common.push(sha);
  if (!common.length) return undefined;
  const set = new Set(common);
  for (const c of common) {
    const others = await reachable((await readCommit(c)).parents);
    for (const o of others) set.delete(o);
  }
  return [...set][0];
}

// --- refs --------------------------------------------------------------------------------------------------------

// A space: git refs and ontology slugs never contain one (and Postgres text cannot hold a NUL).
const refId = (repo: string, name: string) => `${repo} ${name}`;

export async function getRef(repo: string, name: string): Promise<string | undefined> {
  return (await get<StoredRef>('gitRefs', refId(repo, name)))?.sha;
}

export async function listRefs(repo: string, prefix = ''): Promise<{ name: string; sha: string }[]> {
  return (await list<StoredRef>('gitRefs', repo)).filter((r) => r.name.startsWith(prefix)).map(({ name, sha }) => ({ name, sha })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Points ref `name` at `sha`, or deletes it (sha undefined). With `expect`, only if the ref still holds
 * `expect.sha` (undefined: the ref must not exist), and otherwise throws a 409 and changes nothing. Runs in the
 * caller's transaction, if any, so a ref can move together with the database state that depends on it.
 */
export async function setRef(repo: string, name: string, sha: string | undefined, expect?: { sha: string | undefined }): Promise<void> {
  await transaction(async () => {
    if (expect) {
      const current = await getRef(repo, name);
      if (current !== expect.sha) throw new HttpError(409, `${name} moved: it is ${current ?? 'unset'}, not ${expect.sha ?? 'unset'}`);
    }
    if (sha === undefined) await remove('gitRefs', refId(repo, name));
    else await put<StoredRef>('gitRefs', { id: refId(repo, name), repo, name, sha }, repo);
  });
}

/** Forgets every ref of a repository (its objects stay: they may be shared, and are harmless). */
export async function dropRepo(repo: string): Promise<void> {
  await transaction(async () => {
    for (const r of await list<StoredRef>('gitRefs', repo)) await remove('gitRefs', r.id);
  });
}
