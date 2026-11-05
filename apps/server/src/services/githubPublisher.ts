import type { Release } from '@concord/shared';
import { hashObject, isAncestor, isoDate, readCommit, readObject, readTree, reachable, serialiseTag, type Commit, type Person, type TreeEntry } from './gitdb.js';

/**
 * Recreates an ontology's history from the database (ONTOLOGY_STORE=db) on GitHub, as `git push origin main
 * --follow-tags` does from a repository on disk, through GitHub's Git Data API: each blob, tree, commit and tag is
 * rebuilt from its parts, and every id GitHub returns must be Concord's own, or publishing stops.
 *
 * main moves with a GraphQL `updateRefs` call that names the value this run read (`beforeOid`), so a main someone
 * else moved meanwhile (a force-push back, say) refuses the update rather than being overwritten. A main found
 * behind where Concord last confirmed it (`confirmedMain`, kept by the caller) was moved back between runs, and
 * isn't moved forward again either. updateRefs only points refs at commits, so each release tag's ref is created
 * with REST after main moves, straight after its tag object (create only: an existing ref is never changed). A run
 * that stops part way keeps main and the tags it finished; the next run carries on. At the end every ref the target
 * needs is read back.
 *
 * Object uploads are idempotent (an id is its content), and so are tag objects (a release's tagger time is its
 * publication time). Every write is first granted by `spend`, against the hour it is made in; uploads leave the
 * hour's last write for moving main to what was sent. `checkpoint` runs before each write (the caller renews its
 * lease and checks publishing is still allowed there, throwing to stop). The outbox (githubOutbox.ts) owns the job;
 * this module only talks to GitHub.
 */

/** Out of writes, or GitHub's rate limit: carry on later (not before `notBefore`, if set). */
export class PublishPaused extends Error {
  constructor(
    message: string,
    public notBefore?: number,
  ) {
    super(message);
  }
}
/** Something publishing again won't fix by itself (an id that differs, a ref that moved, no permission). */
export class PublishRefused extends Error {}

export interface PublishTarget {
  repo: string;
  token: string;
  /** The commit main should end at. */
  commit: string;
  /** Where Concord last confirmed main on GitHub: main found behind it was moved back by someone. */
  confirmedMain?: string;
  /** Published releases whose commits are in the target's history: each gets an annotated tag v<version>. */
  releases: Pick<Release, 'version' | 'commit' | 'publishedAt'>[];
}

export interface PublishHooks {
  /** Grants one write, unless fewer than `keep` + 1 are left this hour (false: out of writes for now). */
  spend: (keep: number) => Promise<boolean>;
  /** Records where main was confirmed to be on GitHub, as the next run's `confirmedMain`. */
  confirm?: (main: string) => Promise<void>;
  /** Runs before every `every` writes (default every one) and before refs move; throws to stop. */
  checkpoint: () => Promise<void>;
  every?: number;
  /** GitHub's REST API root (tests point it at a stand-in); GraphQL is at <api>/graphql. */
  api?: string;
}

const ZERO = '0000000000000000000000000000000000000000';
const TREE = '40000';

type Res<T> = { status: number; body: T; headers: Headers };

function client(repo: string, token: string, api: string) {
  const request = async <T>(method: string, url: string, body?: unknown): Promise<Res<T>> => {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'graphql-features': 'update_refs_preview',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      // No answer: whether it took effect is unknown, and every step is safe to repeat.
      throw new PublishPaused(`GitHub didn't answer (${(err as Error).message}); publishing carries on later.`);
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 429 || (res.status === 403 && (remaining === '0' || res.headers.has('retry-after')))) {
      const retry = Number(res.headers.get('retry-after'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      throw new PublishPaused(`GitHub's rate limit was reached (${res.status}); publishing carries on later.`, retry ? Date.now() + retry * 1000 : reset ? reset * 1000 : Date.now() + 60_000);
    }
    if (res.status >= 500) throw new PublishPaused(`GitHub had an error (${res.status}); publishing carries on later.`);
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  };
  return {
    rest: <T>(method: string, path: string, body?: unknown) => request<T>(method, `${api}/repos/${repo}${path}`, body),
    graphql: <T>(query: string, variables: unknown) => request<{ data?: T; errors?: { message: string }[] }>('POST', `${api}/graphql`, { query, variables }),
  };
}

const refused = (what: string, res: { status: number; body: unknown }) =>
  new PublishRefused(`GitHub refused ${what} (${res.status}${(res.body as { message?: string })?.message ? `: ${(res.body as { message: string }).message}` : ''})`);

const asGitHubPerson = (p: Person) => ({ name: p.name, email: p.email, date: isoDate(p) });

/** The tag Concord makes for a release, as bytes: the same every time, so making it again is harmless. */
export function releaseTag(r: Pick<Release, 'version' | 'commit' | 'publishedAt'>) {
  const tagger: Person = { name: 'Concord', email: 'concord@localhost', time: Math.floor(Date.parse(r.publishedAt!) / 1000), tz: '+0000' };
  const message = `Release ${r.version}\n`;
  const name = `v${r.version}`;
  return { name, tagger, message, sha: hashObject('tag', serialiseTag({ object: r.commit!, type: 'commit', tag: name, tagger, message })) };
}

/** Commits reachable from `head` and not from `have`, parents (every one, merge parents too) before children. */
async function toSend(head: string, have: string | undefined): Promise<Commit[]> {
  const skip = have ? await reachable([have]) : new Set<string>();
  const out: Commit[] = [];
  const done = new Set<string>();
  const stack: [string, boolean][] = [[head, false]];
  while (stack.length) {
    const [sha, expanded] = stack.pop()!;
    if (done.has(sha) || skip.has(sha)) continue;
    const c = await readCommit(sha);
    if (expanded) {
      done.add(sha);
      out.push(c);
      continue;
    }
    stack.push([sha, true]);
    for (const p of [...c.parents].reverse()) if (!done.has(p) && !skip.has(p)) stack.push([p, false]);
  }
  return out;
}

/** Every tree and blob id in a tree, recursively (`trees` caches trees read: they never change). */
async function objectsIn(tree: string, trees: Map<string, TreeEntry[]>, into = new Set<string>()): Promise<Set<string>> {
  if (into.has(tree)) return into;
  into.add(tree);
  if (!trees.has(tree)) trees.set(tree, await readTree(tree));
  for (const e of trees.get(tree)!) {
    if (e.mode === TREE) await objectsIn(e.sha, trees, into);
    else into.add(e.sha);
  }
  return into;
}

/**
 * Brings GitHub's main and release tags to `target`. Returns once they are there (refs checked), or throws:
 * PublishPaused to carry on later (main has moved as far as it got), PublishRefused for something publishing again
 * won't fix, or whatever `checkpoint` throws.
 */
export async function publishToGitHub(target: PublishTarget, hooks: PublishHooks): Promise<{ commits: number; tags: number }> {
  const gh = client(target.repo, target.token, (hooks.api ?? 'https://api.github.com').replace(/\/$/, ''));
  const every = hooks.every ?? 1;
  let writes = 0;
  const outOfWrites = () => {
    const nextHour = new Date();
    nextHour.setUTCMinutes(60, 0, 0);
    return new PublishPaused('used this hour’s share of GitHub writes; publishing carries on later.', nextHour.getTime());
  };
  /** Checks publishing is still allowed, then takes a write; `keep` writes of the hour are left for moving main. */
  const grant = async (keep = 0) => {
    if (writes % every === 0) await hooks.checkpoint();
    if (!(await hooks.spend(keep))) throw outOfWrites();
    writes++;
  };
  const write = async <T extends { sha?: string }>(what: string, method: string, path: string, body: unknown, expect?: string): Promise<T> => {
    // An upload leaves one write of the hour for moving main to what was sent.
    await grant(1);
    const res = await gh.rest<T>(method, path, body);
    if (res.status >= 300) throw refused(what, res);
    if (expect && res.body.sha !== expect) throw new PublishRefused(`GitHub made ${what} ${res.body.sha}, not ${expect} as Concord has it, so publishing stopped.`);
    return res.body;
  };

  // Where GitHub is now.
  const repoRes = await gh.rest<{ node_id?: string }>('GET', '');
  if (repoRes.status !== 200 || !repoRes.body.node_id) throw refused(`access to ${target.repo}`, repoRes);
  const repositoryId = repoRes.body.node_id;
  const readMain = async () => {
    const res = await gh.rest<{ object?: { sha: string } }>('GET', '/git/ref/heads/main');
    if (res.status === 409) throw new PublishRefused(`github.com/${target.repo} is empty, and GitHub can't add history to an empty repository through its API. Push the history to it once with git, then publish again.`);
    if (res.status === 404) return undefined;
    if (res.status !== 200) throw refused('reading main', res);
    return res.body.object!.sha;
  };
  const readTags = async () => {
    const res = await gh.rest<{ ref: string; object: { sha: string } }[]>('GET', '/git/matching-refs/tags/v');
    if (res.status !== 200) throw refused('listing tags', res);
    return new Map((res.body ?? []).map((r) => [r.ref, r.object.sha]));
  };
  const remote = await readMain();
  if (remote && remote !== target.commit && !((await readObject(remote))?.type === 'commit' && (await isAncestor(remote, target.commit))))
    throw new PublishRefused(`main on github.com/${target.repo} has commits Concord doesn't have (it is at ${remote}), so nothing was published.`);
  // main behind where Concord last saw it was moved back by someone: moving it forward again would undo that.
  const confirmed = target.confirmedMain;
  if (confirmed && remote !== confirmed && !(remote && (await isAncestor(confirmed, remote))))
    throw new PublishRefused(`main on github.com/${target.repo} was moved back (to ${remote ?? 'nothing'}) after Concord published ${confirmed}, so nothing was published: publishing again would undo that.`);

  /**
   * Moves main from exactly what was read to `after`, then reads it back. main anywhere but `before` or `after` was
   * moved by someone else, which stops publishing; so does GitHub refusing the update (its reason is passed on).
   * Only an update GitHub didn't answer, with main still where it was read, is tried again later.
   */
  const moveMain = async (before: string | undefined, after: string) => {
    await grant();
    let answer: Awaited<ReturnType<typeof gh.graphql>> | undefined;
    try {
      answer = await gh.graphql('mutation ($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }', {
        input: { repositoryId, refUpdates: [{ name: 'refs/heads/main', beforeOid: before ?? ZERO, afterOid: after }] },
      });
    } catch (err) {
      if (!(err instanceof PublishPaused)) throw err;
      // Unknown whether it took effect: look.
    }
    const main = await readMain();
    if (main === after) return await hooks.confirm?.(after);
    if (main !== before) throw new PublishRefused(`main on github.com/${target.repo} moved while Concord was publishing (it is at ${main ?? 'nothing'}), so publishing stopped.`);
    if (!answer) throw new PublishPaused('GitHub didn’t confirm moving main; publishing carries on later.');
    throw new PublishRefused(`GitHub refused to move main (${answer.body.errors?.map((e) => e.message).join('; ') || answer.status}), so publishing stopped.`);
  };
  /** Creates a release tag's ref, only if it doesn't exist; then it must be Concord's tag. */
  const createTag = async (t: { name: string; sha: string }) => {
    await grant();
    const ref = `refs/tags/${t.name}`;
    const res = await gh.rest<{ message?: string }>('POST', '/git/refs', { ref, sha: t.sha });
    if (res.status === 201) return;
    // Already there (an earlier try that went unanswered, or someone else's), or refused: look.
    const at = (await readTags()).get(ref);
    if (at === t.sha) return;
    if (at) throw new PublishRefused(`${t.name} on github.com/${target.repo} is another tag (${at}) than the one Concord made, so it was left as it is.`);
    throw refused(`creating ${ref}`, res);
  };

  // Commits, parents first. A commit's tree is sent where it differs from its first parent's (already on GitHub).
  const commits = await toSend(target.commit, remote);
  const line = new Set<string>();
  for (let sha: string | undefined = target.commit; sha && sha !== remote; sha = (await readCommit(sha)).parents[0]) line.add(sha);
  let lastOnLine = remote;
  const trees = new Map<string, TreeEntry[]>();
  try {
    for (const c of commits) {
      const parentTree = c.parents[0] ? (await readCommit(c.parents[0])).tree : undefined;
      const there = parentTree ? await objectsIn(parentTree, trees) : new Set<string>();
      const sendTree = async (tree: string): Promise<void> => {
        if (there.has(tree)) return;
        if (!trees.has(tree)) trees.set(tree, await readTree(tree));
        const entries = trees.get(tree)!;
        for (const e of entries) {
          if (there.has(e.sha)) continue;
          if (e.mode === TREE) await sendTree(e.sha);
          else {
            const blob = await readObject(e.sha);
            if (blob?.type !== 'blob') throw new PublishRefused(`Concord is missing blob ${e.sha}`);
            await write(`blob ${e.sha}`, 'POST', '/git/blobs', { content: blob.body.toString('base64'), encoding: 'base64' }, e.sha);
            there.add(e.sha);
          }
        }
        await write(`tree ${tree}`, 'POST', '/git/trees', { tree: entries.map((e) => ({ path: e.name, mode: e.mode === TREE ? '040000' : e.mode, type: e.mode === TREE ? 'tree' : 'blob', sha: e.sha })) }, tree);
        there.add(tree);
      };
      await sendTree(c.tree);
      await write(`commit ${c.sha}`, 'POST', '/git/commits', { message: c.message, tree: c.tree, parents: c.parents, author: asGitHubPerson(c.author), committer: asGitHubPerson(c.committer) }, c.sha);
      if (line.has(c.sha)) lastOnLine = c.sha;
    }
  } catch (err) {
    // Keep what was sent: main moves forward, along the draft's own line, to the last commit sent in full (with the
    // write uploads leave for it). Only a pause is carried on later; a conflict found while moving main stops
    // publishing instead.
    if (err instanceof PublishPaused && lastOnLine && lastOnLine !== remote) {
      try {
        await moveMain(remote, lastOnLine);
      } catch (moveErr) {
        if (!(moveErr instanceof PublishPaused)) throw moveErr;
      }
    }
    throw err;
  }
  // A tag on GitHub that names anything else is a conflict: found before main moves, nothing moves.
  const have = await readTags();
  const toTag = target.releases.filter((r) => {
    const t = releaseTag(r);
    const at = have.get(`refs/tags/${t.name}`);
    if (at && at !== t.sha) throw new PublishRefused(`${t.name} on github.com/${target.repo} is another tag (${at}) than the one Concord made, so it was left as it is.`);
    return !at;
  });
  if (remote !== target.commit) await moveMain(remote, target.commit);

  // Then each release tag, its object and its ref together, so a run that stops keeps the tags it finished.
  let made = 0;
  for (const r of toTag) {
    const t = releaseTag(r);
    await write(`tag ${t.name}`, 'POST', '/git/tags', { tag: t.name, message: t.message, object: r.commit, type: 'commit', tagger: asGitHubPerson(t.tagger) }, t.sha);
    await createTag(t);
    made++;
  }

  // Every ref the target needs, read back, moved or not.
  const main = await readMain();
  const tags = await readTags();
  const wrong = [
    ...(main === target.commit ? [] : ['refs/heads/main']),
    ...target.releases.map(releaseTag).filter((t) => tags.get(`refs/tags/${t.name}`) !== t.sha).map((t) => `refs/tags/${t.name}`),
  ];
  if (wrong.length) throw new PublishRefused(`${wrong.join(', ')} on github.com/${target.repo} moved while Concord was publishing, so publishing stopped.`);
  return { commits: commits.length, tags: made };
}
