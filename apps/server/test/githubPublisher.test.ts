import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OntologyProject, Release } from '@concord/shared';
import { config } from '../src/config.js';
import { closeDb, get, openDb, put, remove, transaction } from '../src/db.js';
import { readCommit, readObject, readTree, writeCommit, writeTree, type Person } from '../src/services/gitdb.js';
import { enqueueGitHubPublish, githubPublishJob, runGitHubPublish, type GitHubPublishJob } from '../src/services/githubOutbox.js';
import { publishToGitHub, PublishPaused, PublishRefused, releaseTag } from '../src/services/githubPublisher.js';
import { createUseCase, withdrawUseCase } from '../src/services/useCases.js';
import { createUser } from '../src/services/users.js';

/**
 * Publishing from the database store to GitHub (githubPublisher.ts, githubOutbox.ts). GitHub here is a stand-in: a
 * small server answering the Git Data API and GraphQL updateRefs the way GitHub does, by having git itself build
 * each object from the parts sent (so the ids it returns are git's, not the publisher's arithmetic), in a bare
 * repository. Whether real GitHub rebuilds them the same way is checked separately against a scratch repository.
 *
 * With TEST_DATABASE_URL (CI's Postgres service) the outbox runs on a real Postgres pool, so racing workers use
 * separate connections, as two function instances would.
 */

const pgUrl = process.env.TEST_DATABASE_URL;
beforeAll(async () => {
  if (pgUrl) await openDb({ kind: 'postgres', url: pgUrl, max: 4 });
});
afterAll(async () => {
  if (pgUrl) await closeDb();
});

const ZERO = '0000000000000000000000000000000000000000';

/**
 * `beforeRefUpdate` runs as an updateRefs call arrives (someone else pushing, say); `dropRefUpdate` makes the stand-in
 * hang up on it without answering, after applying it or not.
 */
function gitHubStandIn(opts: { writesBeforeLimit?: number; beforeRefUpdate?: () => void; dropRefUpdate?: () => 'applied' | 'not applied' | undefined; onWrite?: (n: number, path: string) => Promise<void> } = {}) {
  const bare = mkdtempSync(join(tmpdir(), 'standin-'));
  execFileSync('git', ['init', '-q', '--bare', bare]);
  let writes = 0;
  let posts = 0;
  const calls: string[] = [];
  const git = (args: string[], input?: string | Buffer, env: Record<string, string> = {}) =>
    execFileSync('git', ['--git-dir', bare, ...args], { input, env: { ...process.env, ...env }, stdio: 'pipe' }).toString().trim();
  const sha = (ref: string) => {
    try {
      return git(['rev-parse', '-q', '--verify', ref]);
    } catch {
      return undefined;
    }
  };
  const personEnv = (role: 'AUTHOR' | 'COMMITTER', p: { name: string; email: string; date: string }) => ({ [`GIT_${role}_NAME`]: p.name, [`GIT_${role}_EMAIL`]: p.email, [`GIT_${role}_DATE`]: p.date });
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      if (req.method !== 'GET') await opts.onWrite?.(++posts, req.url!);
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      try {
        const body = raw ? JSON.parse(raw) : {};
        const path = req.url!.replace(/^\/repos\/[^/]+\/[^/]+/, '');
        calls.push(`${req.method} ${path}`);
        if (req.method !== 'GET' && opts.writesBeforeLimit !== undefined && writes++ >= opts.writesBeforeLimit)
          return send(403, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '60' });
        if (req.method === 'GET' && path === '') return send(200, { node_id: 'R_standin', full_name: 'example/pub' });
        if (req.method === 'GET' && path === '/git/ref/heads/main') {
          const at = sha('refs/heads/main');
          return at ? send(200, { ref: 'refs/heads/main', object: { sha: at, type: 'commit' } }) : send(404, { message: 'Not Found' });
        }
        if (req.method === 'GET' && path.startsWith('/git/matching-refs/tags/')) {
          const prefix = `refs/tags/${path.slice('/git/matching-refs/tags/'.length)}`;
          const lines = git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags/']).split('\n').filter(Boolean);
          return send(200, lines.map((l) => l.split(' ')).filter(([ref]) => ref.startsWith(prefix)).map(([ref, s]) => ({ ref, object: { sha: s } })));
        }
        if (req.method === 'POST' && path === '/git/blobs') return send(201, { sha: git(['hash-object', '-w', '--stdin'], Buffer.from(body.content, 'base64')) });
        if (req.method === 'POST' && path === '/git/trees')
          return send(201, { sha: git(['mktree'], body.tree.map((e: { mode: string; type: string; sha: string; path: string }) => `${e.mode} ${e.type} ${e.sha}\t${e.path}\n`).join('')) });
        if (req.method === 'POST' && path === '/git/commits')
          return send(201, { sha: git(['commit-tree', body.tree, ...body.parents.flatMap((p: string) => ['-p', p]), '-F', '-'], body.message, { ...personEnv('AUTHOR', body.author), ...personEnv('COMMITTER', body.committer) }) });
        if (req.method === 'POST' && path === '/git/tags') {
          // git tag makes the object and a ref; GitHub makes only the object (the ref is a separate update).
          git(['tag', '-a', body.tag, '-m', body.message, body.object], undefined, { GIT_COMMITTER_NAME: body.tagger.name, GIT_COMMITTER_EMAIL: body.tagger.email, GIT_COMMITTER_DATE: body.tagger.date });
          const made = sha(`refs/tags/${body.tag}`)!;
          git(['update-ref', '-d', `refs/tags/${body.tag}`]);
          return send(201, { sha: made });
        }
        if (req.method === 'POST' && req.url === '/graphql') {
          opts.beforeRefUpdate?.();
          const updates: { name: string; beforeOid: string; afterOid: string }[] = body.variables.input.refUpdates;
          // All or none, each from exactly the value named (git's own atomic transaction).
          const input = updates.map((u) => `update ${u.name} ${u.afterOid} ${u.beforeOid === ZERO ? '' : u.beforeOid}\n`).join('');
          const drop = opts.dropRefUpdate?.();
          if (drop === 'not applied') return req.socket.destroy();
          try {
            git(['update-ref', '--stdin'], `start\n${input}prepare\ncommit\n`);
            if (drop === 'applied') return req.socket.destroy();
          } catch (err) {
            return send(200, { data: { updateRefs: null }, errors: [{ message: `A ref moved: ${(err as Error).message.split('\n')[0]}` }] });
          }
          return send(200, { data: { updateRefs: { clientMutationId: null } } });
        }
        send(404, { message: `No stand-in for ${req.method} ${path}` });
      } catch (err) {
        send(422, { message: (err as Error).message });
      }
    });
  });
  return {
    bare,
    git,
    sha,
    calls,
    listen: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    close: () => {
      server.close();
      rmSync(bare, { recursive: true, force: true });
    },
  };
}

let n = 0;
const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const unlimited = { spend: async () => true, checkpoint: async () => undefined };

/** A history in the database: drafts, two releases, and a fork merged back in. */
async function history(start = 1_762_300_000) {
  n++;
  const project = { id: `pub-${n}-${Date.now()}`, slug: `pub-${n}-${Date.now()}`, title: 'Pub', publishedWithApproval: true, github: { repo: 'example/pub' } } as unknown as OntologyProject;
  let t = start;
  const who = (name: string, email = `${name.toLowerCase().replace(/\s/g, '.')}@example.org`): Person => ({ name, email, time: (t += 60), tz: '+0000' });
  const commit = async (parent: string | undefined, files: Record<string, string | null>, message: string, author = who('Priya Shah'), extra: string[] = []) =>
    await writeCommit({ tree: await writeTree(parent ? (await readCommit(parent)).tree : undefined, files), parents: parent ? [parent, ...extra] : [], author, committer: who('Concord', 'concord@localhost'), message });
  const root = await commit(undefined, { 'ontology.ttl': '# v0\n', 'README.md': '# Pub\n' }, 'Create Pub', who('Concord', 'concord@localhost'));
  const a = await commit(root, { 'ontology.ttl': '# v1 Café\n' }, 'Add terms');
  const r1 = await commit(a, { 'releases/1.0.0/ontology.ttl': '# v1 Café\n', 'releases/1.0.0/index.html': '<h1>1.0.0</h1>', 'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n' }, 'Release 1.0.0', who('Concord', 'steward@concord'));
  const f1 = await commit(r1, { 'ontology.ttl': '# fork\n' }, 'Fork edit', who('Tom Okafor'));
  const b = await commit(r1, { 'ontology.ttl': '# v2\n' }, 'Rename a term\n\nBecause the working group asked.');
  const merged = await commit(b, { 'ontology.ttl': '# v2 + fork\n' }, 'Sync with the fork', who('Priya Shah'), [f1]);
  const r2 = await commit(merged, { 'releases/2.0.0/ontology.ttl': '# v2 + fork\n', 'releases/1.0.0/index.html': '<h1>1.0.0 (superseded)</h1>' }, 'Release 2.0.0', who('Concord', 'steward@concord'));
  const releases = [
    { id: `${project.id}-1`, ontologyId: project.id, version: '1.0.0', status: 'published', commit: r1, publishedAt: '2026-11-01T10:00:00.000Z' },
    { id: `${project.id}-2`, ontologyId: project.id, version: '2.0.0', status: 'published', commit: r2, publishedAt: '2026-11-04T10:00:00.000Z' },
  ] as unknown as Release[];
  return { project, releases, root, r1, r2, firstLine: [r2, merged, b, r1, a, root] };
}

describe('GitHub publisher', () => {
  it('recreates the history with identical ids, tags each release, and moves main and the tags together', async () => {
    const { r1, r2, releases } = await history();
    const gh = gitHubStandIn();
    const api = await gh.listen();
    try {
      expect(await publishToGitHub({ repo: 'example/pub', token: 'not-a-real-token', commit: r2, releases }, { ...unlimited, api })).toEqual({ commits: 7, tags: 2 });
      expect(gh.sha('refs/heads/main')).toBe(r2);
      gh.git(['fsck', '--strict', '--no-dangling']);
      expect(gh.sha('refs/tags/v1.0.0^{commit}')).toBe(r1);
      expect(gh.sha('refs/tags/v2.0.0')).toBe(releaseTag(releases[1]).sha);
      // One ref update for main and both tags.
      expect(gh.calls.filter((c) => c === 'POST /graphql')).toHaveLength(1);
      // Again: nothing to send.
      gh.calls.length = 0;
      expect(await publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, { ...unlimited, api })).toEqual({ commits: 0, tags: 0 });
      expect(gh.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
    } finally {
      gh.close();
    }
  });

  it('stops part way when it runs out of writes, keeps what it sent, and carries on next time', async () => {
    const { r2, releases, firstLine } = await history();
    const gh = gitHubStandIn();
    const api = await gh.listen();
    let budget = 12;
    const hooks = { ...unlimited, api, spend: async () => budget-- > 0 };
    try {
      await expect(publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, hooks)).rejects.toBeInstanceOf(PublishPaused);
      const partial = gh.sha('refs/heads/main');
      // main moved forward to a commit on the draft's own line, but not to the end, and no tag yet.
      expect(firstLine).toContain(partial);
      expect(partial).not.toBe(r2);
      expect(gh.sha('refs/tags/v2.0.0')).toBeUndefined();
      for (let i = 0; i < 10 && gh.sha('refs/tags/v2.0.0') === undefined; i++) {
        budget = 12;
        await publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, hooks).catch((err) => {
          if (!(err instanceof PublishPaused)) throw err;
        });
      }
      expect(gh.sha('refs/heads/main')).toBe(r2);
      expect(gh.sha('refs/tags/v2.0.0')).toBe(releaseTag(releases[1]).sha);
      gh.git(['fsck', '--strict']);
    } finally {
      gh.close();
    }
  });

  it('pauses, with a time to try again, when GitHub says its rate limit is reached', async () => {
    const { r2, releases } = await history();
    const gh = gitHubStandIn({ writesBeforeLimit: 3 });
    const api = await gh.listen();
    try {
      const err = await publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, { ...unlimited, api }).catch((e) => e);
      expect(err).toBeInstanceOf(PublishPaused);
      expect((err as PublishPaused).notBefore).toBeGreaterThan(Date.now() + 30_000);
    } finally {
      gh.close();
    }
  });

  it('refuses to publish over a main on GitHub that has commits Concord doesn’t', async () => {
    const { r2, releases } = await history();
    const gh = gitHubStandIn();
    const env = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 's@example.org', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 's@example.org' };
    const foreign = gh.git(['commit-tree', gh.git(['mktree'], ''), '-m', 'Made on GitHub'], undefined, env);
    gh.git(['update-ref', 'refs/heads/main', foreign]);
    const api = await gh.listen();
    try {
      await expect(publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, { ...unlimited, api })).rejects.toThrow(/has commits Concord doesn.t have/);
      expect(gh.sha('refs/heads/main')).toBe(foreign);
    } finally {
      gh.close();
    }
  });

  it('never puts back history someone removed while it was publishing: main moves only from what it read', async () => {
    // r1 design review: GitHub's force:false only checks for a fast-forward, so a force-push back to an ancestor
    // could be undone. The ref update names the value it read.
    const { r1, r2, releases } = await history();
    const gh = gitHubStandIn();
    const api = await gh.listen();
    try {
      await publishToGitHub({ repo: 'example/pub', token: 't', commit: r1, releases: releases.slice(0, 1) }, { ...unlimited, api });
      const removed = (await readCommit(r1)).parents[0];
      // Someone force-pushes main back while the next publish is uploading.
      let pushed = false;
      const racing = gitHubStandIn({
        beforeRefUpdate: () => {
          if (!pushed) {
            pushed = true;
            racing.git(['update-ref', 'refs/heads/main', removed]);
          }
        },
      });
      racing.git(['fetch', '-q', gh.bare, '+refs/*:refs/*']);
      const api2 = await racing.listen();
      try {
        await expect(publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, { ...unlimited, api: api2 })).rejects.toBeInstanceOf(PublishRefused);
        expect(racing.sha('refs/heads/main')).toBe(removed);
        expect(racing.sha('refs/tags/v2.0.0')).toBeUndefined();
      } finally {
        racing.close();
      }
    } finally {
      gh.close();
    }
  });

  it('leaves alone a tag on GitHub that isn’t the one Concord made', async () => {
    const { r1, r2, releases } = await history();
    const gh = gitHubStandIn();
    const api = await gh.listen();
    try {
      await publishToGitHub({ repo: 'example/pub', token: 't', commit: r1, releases: [] }, { ...unlimited, api });
      gh.git(['tag', 'v1.0.0', r1]); // a lightweight tag someone made
      await expect(publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, { ...unlimited, api })).rejects.toThrow(/v1\.0\.0 .* another tag/);
      expect(gh.sha('refs/heads/main')).toBe(r1);
    } finally {
      gh.close();
    }
  });
});

describe('GitHub publisher, when refs move under it', () => {
  // r1 review of #83: each of these used to end in a retry that could undo another writer's push, or in success
  // with a ref wrong.
  const published = async (commit: string, releases: Release[]) => {
    const gh = gitHubStandIn();
    const api = await gh.listen();
    await publishToGitHub({ repo: 'example/pub', token: 't', commit, releases }, { ...unlimited, api });
    return { gh, api };
  };
  /** A stand-in holding what `from` has, with its own options. */
  const copyOf = async (from: ReturnType<typeof gitHubStandIn>, opts: Parameters<typeof gitHubStandIn>[0]) => {
    const gh = gitHubStandIn(opts);
    gh.git(['fetch', '-q', from.bare, '+refs/*:refs/*']);
    return { gh, api: await gh.listen() };
  };

  it('stops, rather than trying again, when GitHub doesn’t answer the ref update and main is somewhere unexpected', async () => {
    const { r1, r2, releases } = await history();
    const first = await published(r1, releases.slice(0, 1));
    const removed = (await readCommit(r1)).parents[0];
    let racing: ReturnType<typeof gitHubStandIn> | undefined;
    const { gh, api } = await copyOf(first.gh, { beforeRefUpdate: () => racing!.git(['update-ref', 'refs/heads/main', removed]), dropRefUpdate: () => 'not applied' });
    racing = gh;
    try {
      await expect(publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, { ...unlimited, api })).rejects.toBeInstanceOf(PublishRefused);
      expect(gh.sha('refs/heads/main')).toBe(removed);
    } finally {
      gh.close();
      first.gh.close();
    }
  });

  it('tries again later when GitHub doesn’t answer the ref update and nothing moved, and finishes when it did take effect', async () => {
    const { r1, r2, releases } = await history();
    const first = await published(r1, releases.slice(0, 1));
    const { gh, api } = await copyOf(first.gh, { dropRefUpdate: () => 'not applied' });
    const second = await copyOf(first.gh, { dropRefUpdate: () => 'applied' });
    try {
      await expect(publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, { ...unlimited, api })).rejects.toBeInstanceOf(PublishPaused);
      expect(gh.sha('refs/heads/main')).toBe(r1);
      expect(await publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, { ...unlimited, api: second.api })).toMatchObject({ tags: 1 });
      expect(second.gh.sha('refs/heads/main')).toBe(r2);
    } finally {
      gh.close();
      second.gh.close();
      first.gh.close();
    }
  });

  it('stops when someone moves main while it is saving partial progress, instead of pausing to undo them later', async () => {
    const { r1, r2, releases } = await history();
    const first = await published(r1, releases.slice(0, 1));
    const removed = (await readCommit(r1)).parents[0];
    let racing: ReturnType<typeof gitHubStandIn> | undefined;
    const { gh, api } = await copyOf(first.gh, { beforeRefUpdate: () => racing!.git(['update-ref', 'refs/heads/main', removed]) });
    racing = gh;
    let budget = 8;
    try {
      await expect(publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, { ...unlimited, api, spend: async () => budget-- > 0 })).rejects.toBeInstanceOf(PublishRefused);
      expect(gh.sha('refs/heads/main')).toBe(removed);
    } finally {
      gh.close();
      first.gh.close();
    }
  });

  it('checks every ref the target needs, not only those it moves: main moved during a tags-only update stops it', async () => {
    const { r1, r2, releases } = await history();
    const first = await published(r2, releases.slice(0, 1));
    let racing: ReturnType<typeof gitHubStandIn> | undefined;
    const { gh, api } = await copyOf(first.gh, { beforeRefUpdate: () => racing!.git(['update-ref', 'refs/heads/main', r1]) });
    racing = gh;
    try {
      await expect(publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, { ...unlimited, api })).rejects.toThrow(/refs\/heads\/main .* moved while Concord was publishing/);
    } finally {
      gh.close();
      first.gh.close();
    }
  });

  it('with nothing to send, still finds main isn’t where it should be', async () => {
    const { r2, releases } = await history();
    const { gh, api } = await published(r2, releases);
    try {
      gh.git(['update-ref', '-d', 'refs/tags/v1.0.0']);
      // A missing tag is made again; a tag moved elsewhere is a conflict.
      expect(await publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, { ...unlimited, api })).toEqual({ commits: 0, tags: 1 });
      gh.git(['update-ref', 'refs/tags/v2.0.0', releases[0].commit!]);
      await expect(publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, { ...unlimited, api })).rejects.toThrow(/v2\.0\.0 .* another tag/);
    } finally {
      gh.close();
    }
  });

  it('keeps its progress when the writes run out at the tags, so the next run only makes the tags', async () => {
    // r1 review of #83: the pause came after the commits but before main moved, so every run sent them all again.
    const { r2, releases } = await history();
    const count = gitHubStandIn();
    const countApi = await count.listen();
    await publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases: [] }, { ...unlimited, api: countApi });
    const objects = count.calls.filter((c) => /^POST \/git\/(blobs|trees|commits)$/.test(c)).length;
    count.close();
    const gh = gitHubStandIn();
    const api = await gh.listen();
    // Every object, plus the write held for the ref update: none left for a tag.
    let budget = objects + 1;
    try {
      await expect(publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, { ...unlimited, api, spend: async () => budget-- > 0 })).rejects.toBeInstanceOf(PublishPaused);
      expect(gh.sha('refs/heads/main')).toBe(r2);
      gh.calls.length = 0;
      expect(await publishToGitHub({ repo: 'example/pub', token: 't', commit: r2, releases }, { ...unlimited, api })).toEqual({ commits: 0, tags: 2 });
      expect(gh.calls.filter((c) => /^POST \/git\/(blobs|trees|commits)$/.test(c))).toEqual([]);
    } finally {
      gh.close();
    }
  });
});

describe('GitHub publishing outbox', () => {
  const token = config.github.publishToken;
  const withToken = async <T>(fn: () => Promise<T>) => {
    (config.github as { publishToken?: string }).publishToken = 'test-token-not-real';
    try {
      return await fn();
    } finally {
      (config.github as { publishToken?: string }).publishToken = token;
    }
  };
  const setUp = async () => {
    const h = await history();
    await put('ontologies', h.project);
    for (const r of h.releases) await put('releases', r, h.project.id);
    return h;
  };

  it('records the job with the release, publishes it, and only then links the release', async () => {
    const { project, releases, r2 } = await setUp();
    const gh = gitHubStandIn();
    const api = await gh.listen();
    try {
      await transaction(async () => await enqueueGitHubPublish(project, releases[1]));
      expect(await githubPublishJob(project.id)).toMatchObject({ status: 'pending', commit: r2, repo: 'example/pub', releaseIds: [releases[1].id] });
      await withToken(() => runGitHubPublish(project.id, { api }));
      expect(gh.sha('refs/heads/main')).toBe(r2);
      expect(await githubPublishJob(project.id)).toMatchObject({ status: 'done', releaseIds: [] });
      expect((await get<Release>('releases', releases[1].id))!.githubUrl).toBe('https://github.com/example/pub/releases/tag/v2.0.0');
    } finally {
      gh.close();
    }
  });

  it('records no job when the release’s transaction rolls back', async () => {
    const { project, releases } = await setUp();
    await expect(
      transaction(async () => {
        await enqueueGitHubPublish(project, releases[1]);
        throw new Error('release refused');
      }),
    ).rejects.toThrow('release refused');
    expect(await githubPublishJob(project.id)).toBeUndefined();
  });

  it('stops uploading as soon as a version is held for approval, and cancels the job', async () => {
    // r1 design review: approval must govern every upload, not only the start.
    const { project, releases } = await setUp();
    // A hold appears once a few objects have gone.
    const gh = gitHubStandIn({
      onWrite: async (n) => {
        if (n === 3) await put('kv', { id: `public-hold:${project.id}`, ontologyId: project.id, versions: ['2.0.0'], since: new Date().toISOString() });
      },
    });
    const api = await gh.listen();
    try {
      await transaction(async () => await enqueueGitHubPublish(project, releases[1]));
      await withToken(() => runGitHubPublish(project.id, { api, every: 2 }));
      const job = (await githubPublishJob(project.id))!;
      expect(job.status).toBe('cancelled');
      expect(job.reason).toMatch(/waiting for a steward/);
      expect(gh.calls.filter((c) => c.startsWith('POST')).length).toBeLessThan(6);
      expect(gh.sha('refs/tags/v2.0.0')).toBeUndefined();
      expect((await get<Release>('releases', releases[1].id))!.githubUrl).toBeUndefined();
    } finally {
      await remove('kv', `public-hold:${project.id}`);
      gh.close();
    }
  });

  it('lets one worker at a time carry a job out', async () => {
    const { project, releases } = await setUp();
    const gh = gitHubStandIn();
    const api = await gh.listen();
    try {
      await transaction(async () => await enqueueGitHubPublish(project, releases[1]));
      await withToken(() => Promise.all([runGitHubPublish(project.id, { api }), runGitHubPublish(project.id, { api })]));
      // Each object was sent once: the second worker found the job leased (or done) and left it.
      const posts = gh.calls.filter((c) => c === 'POST /git/commits');
      expect(posts).toHaveLength(7);
      expect((await githubPublishJob(project.id))!.status).toBe('done');
    } finally {
      gh.close();
    }
  });

  it('stops publishing for good when a use case is withdrawn before its release reached GitHub', async () => {
    // r1 review of #83: a withdrawal left every check passing, so a paused or running job went on uploading.
    const { project, releases } = await setUp();
    const author = await createUser({ name: `Outbox author ${uniqueSuffix()}`, provider: 'github', subject: `outbox-${uniqueSuffix()}` });
    const useCase = await createUseCase(project, author, { source: 'form', visibility: 'public', status: 'accepted', sections: { name: 'Withdrawn later' } });
    const gh = gitHubStandIn({
      onWrite: async (n) => {
        if (n === 3) await withdrawUseCase(useCase, author);
      },
    });
    const api = await gh.listen();
    try {
      await transaction(async () => await enqueueGitHubPublish(project, releases[1]));
      await withToken(() => runGitHubPublish(project.id, { api }));
      expect(await githubPublishJob(project.id)).toMatchObject({ status: 'cancelled', reason: expect.stringMatching(/use case stopped being public/) });
      // The write on its way when the withdrawal landed is the last that went.
      expect(gh.calls.filter((c) => c.startsWith('POST'))).toHaveLength(3);
      expect(gh.sha('refs/heads/main')).toBeUndefined();
      // A newer release doesn't start it again: the history still holds what the release had.
      gh.calls.length = 0;
      await transaction(async () => await enqueueGitHubPublish(project, releases[1]));
      await withToken(() => runGitHubPublish(project.id, { api }));
      expect((await githubPublishJob(project.id))!.status).toBe('cancelled');
      expect(gh.calls).toEqual([]);
    } finally {
      gh.close();
    }
  });

  it('lets a withdrawal after everything reached GitHub block nothing', async () => {
    const { project, releases } = await setUp();
    const author = await createUser({ name: `Outbox author ${uniqueSuffix()}`, provider: 'github', subject: `outbox-${uniqueSuffix()}` });
    const useCase = await createUseCase(project, author, { source: 'form', visibility: 'public', status: 'accepted', sections: { name: 'Withdrawn after' } });
    const gh = gitHubStandIn();
    const api = await gh.listen();
    try {
      await transaction(async () => await enqueueGitHubPublish(project, releases[1]));
      await withToken(() => runGitHubPublish(project.id, { api }));
      expect((await githubPublishJob(project.id))!.status).toBe('done');
      await withdrawUseCase(useCase, author);
      expect(await get('kv', `github-publish-block:${project.id}`)).toBeUndefined();
    } finally {
      gh.close();
    }
  });

  it('gives the releases no link, and leaves the job alone, when its lease passed to another worker before it finished', async () => {
    // r1 review of #83: the links were written before the lease was checked, by a worker that might have lost it.
    const { project, releases } = await setUp();
    const gh = gitHubStandIn({
      onWrite: async (_n, path) => {
        if (path !== '/graphql') return;
        const job = (await githubPublishJob(project.id))!;
        await put('kv', { ...job, lease: { token: 'another-worker', until: Date.now() + 60_000 } }, 'github-publish');
      },
    });
    const api = await gh.listen();
    try {
      await transaction(async () => await enqueueGitHubPublish(project, releases[1]));
      await withToken(() => runGitHubPublish(project.id, { api }));
      expect(await githubPublishJob(project.id)).toMatchObject({ status: 'pending', lease: { token: 'another-worker' } });
      expect((await get<Release>('releases', releases[1].id))!.githubUrl).toBeUndefined();
    } finally {
      gh.close();
    }
  });

  it('counts each write against the hour it is made in', async () => {
    // r1 review of #83: the hour was read once per run, so a run across the hour spent the last hour's allowance.
    const { project, releases } = await setUp();
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2031-03-01T10:59:59.000Z') });
    const gh = gitHubStandIn({
      onWrite: async (n) => {
        if (n === 4) vi.setSystemTime(new Date('2031-03-01T11:00:01.000Z'));
      },
    });
    const api = await gh.listen();
    try {
      await transaction(async () => await enqueueGitHubPublish(project, releases[1]));
      await withToken(() => runGitHubPublish(project.id, { api }));
      expect((await githubPublishJob(project.id))!.status).toBe('done');
      const used = async (hour: string) => (await get<{ count: number }>('kv', `github-writes:${hour}`))?.count ?? 0;
      // The first write also took one for the ref update, which then used it.
      const posts = gh.calls.filter((c) => c.startsWith('POST')).length;
      expect(await used('2031-03-01T10')).toBe(4 + 1);
      expect(await used('2031-03-01T11')).toBe(posts - 4 - 1);
    } finally {
      vi.useRealTimers();
      gh.close();
    }
  });

  it('quarantines a job GitHub refuses, with the reason, and starts again with the next release', async () => {
    const { project, releases, r1 } = await setUp();
    const gh = gitHubStandIn();
    const env = { GIT_AUTHOR_NAME: 'S', GIT_AUTHOR_EMAIL: 's@example.org', GIT_COMMITTER_NAME: 'S', GIT_COMMITTER_EMAIL: 's@example.org' };
    gh.git(['update-ref', 'refs/heads/main', gh.git(['commit-tree', gh.git(['mktree'], ''), '-m', 'foreign'], undefined, env)]);
    const api = await gh.listen();
    try {
      await transaction(async () => await enqueueGitHubPublish(project, releases[0]));
      await withToken(() => runGitHubPublish(project.id, { api }));
      const job = (await githubPublishJob(project.id)) as GitHubPublishJob;
      expect(job).toMatchObject({ status: 'quarantined', commit: r1 });
      expect(job.reason).toMatch(/commits Concord doesn.t have/);
      expect(job.lease).toBeUndefined();
      // Running again doesn't retry it.
      gh.calls.length = 0;
      await withToken(() => runGitHubPublish(project.id, { api }));
      expect(gh.calls).toEqual([]);
      // A newer release starts it again.
      await transaction(async () => await enqueueGitHubPublish(project, releases[1]));
      expect((await githubPublishJob(project.id))!.status).toBe('pending');
    } finally {
      gh.close();
    }
  });
});

/**
 * Against real GitHub, run by hand: GITHUB_PUBLISH_VERIFY_REPO names a scratch repository (owner/name) that this
 * overwrites, and GITHUB_PUBLISH_VERIFY_TOKEN a token that can write to it. The test resets main to a fresh root
 * commit with git (GitHub's API can't start an empty repository) and deletes its v1.0.0 and v2.0.0 tags, then
 * publishes the rest through the API, clones the repository and checks every id.
 */
const verifyRepo = process.env.GITHUB_PUBLISH_VERIFY_REPO;
const verifyToken = process.env.GITHUB_PUBLISH_VERIFY_TOKEN;
describe.runIf(!!verifyRepo && !!verifyToken)('GitHub publisher, against GitHub itself', () => {
  it('recreates the history on GitHub with identical ids and tags', { timeout: 300_000 }, async () => {
    const { root, r1, r2, releases } = await history(Math.floor(Date.now() / 1000));
    const dir = mkdtempSync(join(tmpdir(), 'verify-'));
    const git = (args: string[], input?: string | Buffer) => execFileSync('git', args, { cwd: dir, input, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).toString().trim();
    // The token goes in a header for this process only, never into a URL or the repository's config.
    const auth = ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${verifyToken}`).toString('base64')}`];
    const url = `https://github.com/${verifyRepo}.git`;
    git(['init', '-q', '--bare', '.']);
    const copy = async (sha: string): Promise<void> => {
      const o = (await readObject(sha))!;
      expect(git(['hash-object', '-t', o.type, '-w', '--stdin'], o.body)).toBe(sha);
      if (o.type === 'commit') await copy((await readCommit(sha)).tree);
      if (o.type === 'tree') for (const e of await readTree(sha)) await copy(e.sha);
    };
    await copy(root);
    git([...auth, 'push', '-q', '--force', url, `${root}:refs/heads/main`]);
    // Tags from an earlier run (deleting one that isn't there fails, which is fine).
    for (const tag of ['v1.0.0', 'v2.0.0']) spawnSync('git', [...auth, 'push', '-q', url, `:refs/tags/${tag}`], { cwd: dir, stdio: 'ignore' });
    try {
      expect(await publishToGitHub({ repo: verifyRepo!, token: verifyToken!, commit: r2, releases }, unlimited)).toEqual({ commits: 6, tags: 2 });
      const clone = mkdtempSync(join(tmpdir(), 'verify-clone-'));
      execFileSync('git', [...auth, 'clone', '-q', '--mirror', url, clone]);
      const at = (ref: string) => execFileSync('git', ['--git-dir', clone, 'rev-parse', ref]).toString().trim();
      expect(at('refs/heads/main')).toBe(r2);
      expect(at('refs/tags/v1.0.0^{commit}')).toBe(r1);
      expect(at('refs/tags/v1.0.0')).toBe(releaseTag(releases[0]).sha);
      expect(at('refs/tags/v2.0.0')).toBe(releaseTag(releases[1]).sha);
      execFileSync('git', ['--git-dir', clone, 'fsck', '--strict']);
      rmSync(clone, { recursive: true, force: true });
      // Again: nothing to send.
      expect(await publishToGitHub({ repo: verifyRepo!, token: verifyToken!, commit: r2, releases }, unlimited)).toEqual({ commits: 0, tags: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
