import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as oauth from 'oauth4webapi';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { get, HttpError, openDb, put } from '../src/db.js';
import { keepOwnPodLogin, loadOwnPodLogin } from '../src/services/ownPods.js';
import { solid } from '../src/services/solid.js';
import { inPods, podOf, type SolidLogin } from '../src/solidOidc.js';

/**
 * Step 5e: people who sign in with Solid keep their private data in their own pod, written as them, with Concord's
 * folder there made private first; a write their pod refuses (or a sign-in that has ended) is an error they see,
 * never a copy quietly kept in the database (Jesse's decision of 4 November). Before this, every account's private
 * data went to a pod on the VM's own Solid server, and on Vercel (which has none) to the database, Solid accounts too.
 *
 * The pod is a scripted WAC server on 127.0.0.1, marked trusted for the test (so plain http and a loopback address
 * are allowed for it). It doesn't check DPoP proofs: the sign-in itself is tested in solidOidcFlow.test.ts.
 */

interface Doc {
  body: Buffer;
  type: string;
  etag: string;
}
let server: http.Server;
let base: string;
let docs = new Map<string, Doc>();
let log: string[] = [];
let refuse: ((method: string, path: string) => number | undefined) | undefined;
let acp = false;
let tag = 0;

beforeAll(async () => {
  await openDb();
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = new URL(req.url!, base).pathname;
      const method = req.method!;
      log.push(`${method} ${path}`);
      const status = refuse?.(method, path);
      if (status) return res.writeHead(status).end();
      const aclLink = acp ? `<${base}${path}.acr>; rel="acl", <http://www.w3.org/ns/solid/acp#AccessControlResource>; rel="type"` : `<${base}${path}.acl>; rel="acl"`;
      const have = docs.get(path);
      if (method === 'GET' || method === 'HEAD') {
        if (!have) return res.writeHead(404, { link: aclLink }).end();
        res.writeHead(200, { 'content-type': have.type, etag: have.etag, link: aclLink });
        return res.end(method === 'GET' ? have.body : undefined);
      }
      if (method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && have) return res.writeHead(412).end();
        if (req.headers['if-match'] && req.headers['if-match'] !== have?.etag) return res.writeHead(412).end();
        // Like a real pod, the folders on the way are made too.
        for (let up = path.replace(/[^/]+\/?$/, ''); up.length > 1 && !docs.has(up); up = up.replace(/[^/]+\/$/, '')) docs.set(up, { body: Buffer.alloc(0), type: 'text/turtle', etag: `"e${++tag}"` });
        docs.set(path, { body: Buffer.concat(chunks), type: String(req.headers['content-type'] ?? 'application/octet-stream'), etag: `"e${++tag}"` });
        return res.writeHead(have ? 205 : 201).end();
      }
      res.writeHead(405).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.solidOidc.trustedIssuers.push(base);
});
afterAll(async () => {
  config.solidOidc.trustedIssuers.splice(config.solidOidc.trustedIssuers.indexOf(base), 1);
  await new Promise((r) => server.close(r));
});

const saved = { ownPods: config.solidOwnPods, store: config.privateStore };
beforeEach(() => {
  process.env.CONCORD_ENCRYPTION_KEY = '05'.repeat(32);
  config.solidOwnPods = true;
  (config as { privateStore: string }).privateStore = 'db';
  docs = new Map();
  log = [];
  refuse = undefined;
  acp = false;
});
afterEach(() => {
  delete process.env.CONCORD_ENCRYPTION_KEY;
  config.solidOwnPods = saved.ownPods;
  (config as { privateStore: string }).privateStore = saved.store;
});

let n = 0;
async function account(provider: 'solid' | 'github' = 'solid') {
  const id = `own-pod-${Date.now()}-${++n}`;
  const webId = `${base}/${id}/profile/card#me`;
  await put('users', { id, name: 'Pod owner', webId, providers: [{ provider, subject: webId }], createdAt: new Date().toISOString() });
  return { id, webId, pod: `${base}/${id}/` };
}
async function login(webId: string, over: Partial<SolidLogin> = {}): Promise<SolidLogin> {
  return { webId, as: { issuer: base, token_endpoint: `${base}/token` }, client: { client_id: 'concord' }, keys: await oauth.generateKeyPair('ES256', { extractable: true }), accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000, ...over };
}
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof HttpError ? `${e.status} ${e.message}` : `error ${(e as Error).message}`;
  }
};

describe('a Solid account’s private data in its own pod', () => {
  it('goes to Concord’s folder in their pod, made private to them before anything is written there', async () => {
    const a = await account();
    expect(await keepOwnPodLogin(a.id, await login(a.webId), a.pod)).toBe('kept');
    const r = await solid.write(a.id, 'use-cases/u1.ttl', '<#x> a <#Y> .');
    expect(r).toEqual({ kind: 'solid', url: `${a.pod}concord/use-cases/u1.ttl` });
    const folder = `/${a.id}/concord/`;
    expect(docs.get(`${folder}use-cases/u1.ttl`)?.body.toString()).toBe('<#x> a <#Y> .');
    // The folder's own access control: the owner only, nothing inherited from the pod (which may be public).
    const acl = docs.get(`${folder}.acl`)!.body.toString();
    expect(acl).toContain(a.webId);
    expect(acl).not.toMatch(/foaf\/0\.1\/Agent|AuthenticatedAgent|agentClass|origin/);
    const puts = log.filter((l) => l.startsWith('PUT'));
    expect(puts.indexOf(`PUT ${folder}.acl`)).toBeLessThan(puts.indexOf(`PUT ${folder}use-cases/u1.ttl`));
    expect(await get('privateFiles', `${a.id}/use-cases/u1.ttl`)).toBeUndefined();
    // Once private, later writes don't touch the access control again.
    log = [];
    await solid.write(a.id, 'use-cases/u2.ttl', 'two');
    expect(log.some((l) => l.includes('.acl'))).toBe(false);
  });

  it('leaves access control the owner already set on the folder as it is', async () => {
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    docs.set(`/${a.id}/concord/`, { body: Buffer.alloc(0), type: 'text/turtle', etag: '"f"' });
    docs.set(`/${a.id}/concord/.acl`, { body: Buffer.from('# theirs'), type: 'text/turtle', etag: '"a"' });
    await solid.write(a.id, 'interviews/i.ttl', 'x');
    expect(docs.get(`/${a.id}/concord/.acl`)?.body.toString()).toBe('# theirs');
  });

  it('reports a write their pod refuses, and keeps nothing here instead', async () => {
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    refuse = (method, path) => (method === 'PUT' && path.endsWith('.ttl') ? 403 : undefined);
    expect(await status(solid.write(a.id, 'use-cases/u.ttl', 'x'))).toMatch(/^502 Couldn’t save to your pod: .*403/);
    expect(await status(solid.writeExisting(a.id, 'alpha/testing.jsonld', '{}', 'application/ld+json', { ifNoneMatch: '*' }))).toBe('ok');
    refuse = () => 503;
    expect(await status(solid.writeExisting(a.id, 'alpha/testing.jsonld', '{}', 'application/ld+json', { ifNoneMatch: '*' }))).toMatch(/^502 Couldn’t save to your pod/);
    expect(await get('privateFiles', `${a.id}/use-cases/u.ttl`)).toBeUndefined();
  });

  it('refuses a pod that uses ACP, with nothing written', async () => {
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    acp = true;
    expect(await status(solid.write(a.id, 'use-cases/u.ttl', 'x'))).toMatch(/ACP/);
    expect([...docs.keys()].filter((k) => k.endsWith('.ttl'))).toEqual([]);
  });

  it('asks them to sign in again when Concord has no login for their pod, or it has ended', async () => {
    const a = await account();
    expect(await status(solid.write(a.id, 'use-cases/u.ttl', 'x'))).toMatch(/^409 .*sign in with Solid again/i);
    // A login that expired and can't be refreshed.
    await keepOwnPodLogin(a.id, await login(a.webId, { expiresAt: Date.now() - 1000, refreshToken: undefined }), a.pod);
    expect(await status(solid.write(a.id, 'use-cases/u.ttl', 'x'))).toMatch(/^409 Your Solid sign-in has ended/);
    // A profile naming no pod: nothing is kept, and the write says what to fix.
    expect(await keepOwnPodLogin(a.id, await login(a.webId), undefined)).toBe('no-pod');
    expect(await status(solid.write(a.id, 'use-cases/u.ttl', 'x'))).toMatch(/pim:storage/);
    expect(log.filter((l) => l.startsWith('PUT'))).toEqual([]);
    expect(await get('privateFiles', `${a.id}/use-cases/u.ttl`)).toBeUndefined();
  });

  it('needs CONCORD_ENCRYPTION_KEY to keep the login, and says so', async () => {
    const a = await account();
    delete process.env.CONCORD_ENCRYPTION_KEY;
    expect(await keepOwnPodLogin(a.id, await login(a.webId), a.pod)).toBe('no-key');
    expect(await status(solid.write(a.id, 'use-cases/u.ttl', 'x'))).toMatch(/^409 .*CONCORD_ENCRYPTION_KEY/);
  });

  it('keeps the login sealed, and refreshes it under the account’s own id', async () => {
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId, { refreshToken: 'rt-secret' }), a.pod);
    expect(JSON.stringify(await get('kv', `solid-user:${a.id}`))).not.toContain('rt-secret');
    expect(await loadOwnPodLogin(`user:${a.id}`)).toMatchObject({ refreshToken: 'rt-secret', sharedId: `user:${a.id}` });
  });

  it('shares the feedback folder in their own pod with the administrators', async () => {
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    await solid.writeExisting(a.id, 'feedback/f1.json', '{}', 'application/json');
    expect(await solid.shareRead(a.id, 'feedback/', ['https://admin.example/profile#me'])).toBe('shared');
    expect(docs.get(`/${a.id}/concord/feedback/.acl`)?.body.toString()).toContain('https://admin.example/profile#me');
    expect((await solid.pods()).find((p) => p.userId === a.id)).toEqual({ userId: a.id, podUrl: a.pod, webId: a.webId });
  });

  it('leaves Google and GitHub accounts in this server’s private store', async () => {
    const g = await account('github');
    expect(await solid.write(g.id, 'use-cases/u.ttl', 'x')).toMatchObject({ kind: 'local' });
    expect(await get('privateFiles', `${g.id}/use-cases/u.ttl`)).toBeDefined();
    expect(log).toEqual([]);
  });
});

describe('requests as someone, in their own pod', () => {
  it('go only inside that pod', () => {
    const check = inPods(['https://pod.example/alice/']);
    expect(check('https://pod.example/alice/concord/x.ttl').href).toBe('https://pod.example/alice/concord/x.ttl');
    for (const bad of ['https://pod.example/bob/x', 'https://pod.example/alice', 'https://pod.example/alice/../bob/x', 'https://pod.example/alice/%2e%2e/bob/x', 'https://evil.example/alice/x', 'https://u:p@pod.example/alice/x'])
      expect(() => check(bad)).toThrow(/Not in this person’s pod/);
  });

  it('use the pod the profile names: the one the WebID is in, never one Concord can’t use', () => {
    const webId = 'https://alice.pod.example/profile/card#me';
    expect(podOf({ webId, issuers: [], storages: ['https://other.example/a/', 'https://alice.pod.example/'] })).toBe('https://alice.pod.example/');
    expect(podOf({ webId, issuers: [], storages: ['ftp://x.example/', 'http://plain.example/', 'https://no-slash.example/a', 'https://ok.example/p/'] })).toBe('https://ok.example/p/');
    expect(podOf({ webId, issuers: [], storages: [] })).toBeUndefined();
  });
});
