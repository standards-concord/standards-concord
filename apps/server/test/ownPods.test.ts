import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as oauth from 'oauth4webapi';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { get, HttpError, openDb, put } from '../src/db.js';
import { forgetOwnPodLogin, keepOwnPodLogin, loadOwnPodLogin, saveOwnPodLogin } from '../src/services/ownPods.js';
import { solid } from '../src/services/solid.js';
import { inPods, podOf, storageAbove, type SolidLogin } from '../src/solidOidc.js';

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
/** Answers a refresh at /token (after running, if set, `onToken`). */
let onToken: (() => Promise<void>) | undefined;
/** When set, the next PUT gets a DPoP nonce challenge (401 use_dpop_nonce), after running this. */
let nonceChallenge: (() => Promise<void>) | undefined;

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
      // A pod's root says it is one (as a Solid server does).
      const storageLink = /^\/[^/]+\/$/.test(path) && path !== '/nostorage/' ? ', <http://www.w3.org/ns/pim/space#Storage>; rel="type"' : '';
      const aclLink = (acp ? `<${base}${path}.acr>; rel="acl", <http://www.w3.org/ns/solid/acp#AccessControlResource>; rel="type"` : `<${base}${path}.acl>; rel="acl"`) + storageLink;
      const have = docs.get(path);
      if (method === 'GET' || method === 'HEAD') {
        if (!have) return res.writeHead(404, { link: aclLink }).end();
        res.writeHead(200, { 'content-type': have.type, etag: have.etag, link: aclLink });
        return res.end(method === 'GET' ? have.body : undefined);
      }
      if (method === 'POST' && path === '/token') {
        void (async () => {
          await onToken?.();
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ access_token: `at-${++tag}`, token_type: 'DPoP', expires_in: 3600, refresh_token: `rt-${tag}` }));
        })();
        return;
      }
      if (method === 'PUT' && nonceChallenge) {
        const before = nonceChallenge;
        nonceChallenge = undefined;
        void before().then(() => res.writeHead(401, { 'www-authenticate': 'DPoP error="use_dpop_nonce", error_description="Resource server requires nonce in DPoP proof"', 'dpop-nonce': 'n-1' }).end());
        return;
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
  onToken = undefined;
  nonceChallenge = undefined;
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
    expect(await keepOwnPodLogin(a.id, await login(a.webId), a.pod)).toMatchObject({ status: 'kept' });
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
    // Later writes check it again, but don't change it.
    log = [];
    await solid.write(a.id, 'use-cases/u2.ttl', 'two');
    expect(log.filter((l) => l.startsWith('PUT') && l.includes('.acl'))).toEqual([]);
    expect(log).toContain(`GET ${folder}.acl`);
  });

  const ownerOnly = (folder: string, owner: string) =>
    `@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n<#me> a acl:Authorization; acl:agent <${owner}>; acl:accessTo <${folder}>; acl:default <${folder}>; acl:mode acl:Read, acl:Write, acl:Control.\n`;
  const everyone = (folder: string, owner: string) =>
    `${ownerOnly(folder, owner)}<#all> a acl:Authorization; acl:agentClass <http://xmlns.com/foaf/0.1/Agent>; acl:accessTo <${folder}>; acl:default <${folder}>; acl:mode acl:Read.\n`;
  const aclDoc = (body: string) => ({ body: Buffer.from(body), type: 'text/turtle', etag: `"acl${++tag}"` });

  it('leaves an access control the owner already set on the folder as it is, when it is private to them', async () => {
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    const folder = `${a.pod}concord/`;
    docs.set(`/${a.id}/concord/`, { body: Buffer.alloc(0), type: 'text/turtle', etag: '"f"' });
    docs.set(`/${a.id}/concord/.acl`, aclDoc(ownerOnly(folder, a.webId)));
    expect(await status(solid.write(a.id, 'interviews/i.ttl', 'x'))).toBe('ok');
    expect(docs.get(`/${a.id}/concord/.acl`)?.body.toString()).toBe(ownerOnly(folder, a.webId));
  });

  // Review r1 of step 5e: an access control already on the folder (or one that appeared between Concord's look and
  // its write, a 412) was taken as private without reading it, so a public folder would have received private data.
  it('refuses to write into a folder whose access control lets others in, or leaves its contents to the rules above', async () => {
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    const folder = `${a.pod}concord/`;
    docs.set(`/${a.id}/concord/`, { body: Buffer.alloc(0), type: 'text/turtle', etag: '"f"' });
    for (const [acl, why] of [
      [everyone(folder, a.webId), /can be opened by others than you/],
      [`@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n<#x> acl:agent <https://someone.else/#me>; acl:accessTo <${folder}>; acl:mode acl:Read.\n${ownerOnly(folder, a.webId)}`, /can be opened by others than you/],
      [`@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n<#me> acl:agent <${a.webId}>; acl:accessTo <${folder}>; acl:mode acl:Read, acl:Write.\n`, /don’t cover what is in it/],
      ['# theirs', /don’t cover what is in it/],
    ] as const) {
      docs.set(`/${a.id}/concord/.acl`, aclDoc(acl));
      expect(await status(solid.write(a.id, 'interviews/i.ttl', 'x'))).toMatch(new RegExp(`^409 Concord didn’t save to your pod: .*${why.source}`));
      expect(await status(solid.writeExisting(a.id, 'alpha/testing.jsonld', '{}', 'application/ld+json', { ifNoneMatch: '*' }))).toMatch(/^409/);
    }
    // One made by someone else between Concord's look and its own write (Concord's gets 412) is read and checked too.
    docs.delete(`/${a.id}/concord/.acl`);
    let raced = false;
    refuse = (method, path) => {
      if (method === 'PUT' && path.endsWith('/concord/.acl') && !raced) {
        raced = true;
        docs.set(path, aclDoc(everyone(folder, a.webId)));
        return 412;
      }
      return undefined;
    };
    expect(await status(solid.write(a.id, 'interviews/i.ttl', 'x'))).toMatch(/^409 .*can be opened by others than you/);
    expect([...docs.keys()].filter((k) => k.includes('/interviews/') || k.includes('/alpha/'))).toEqual([]);
  });

  it('refuses a folder or document below it whose own access control lets others in, but allows the administrators’ read-only share', async () => {
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    await solid.write(a.id, 'interviews/first.ttl', 'x');
    const sub = `${a.pod}concord/interviews/`;
    docs.set(`/${a.id}/concord/interviews/.acl`, aclDoc(everyone(sub, a.webId)));
    expect(await status(solid.write(a.id, 'interviews/second.ttl', 'x'))).toMatch(/^409 .*interviews\/ can be opened by others than you/);
    docs.delete(`/${a.id}/concord/interviews/.acl`);
    docs.set(`/${a.id}/concord/interviews/first.ttl.acl`, aclDoc(everyone(`${sub}first.ttl`, a.webId)));
    expect(await status(solid.write(a.id, 'interviews/first.ttl', 'y'))).toMatch(/^409 .*first\.ttl can be opened by others than you/);
    expect(docs.get(`/${a.id}/concord/interviews/first.ttl`)?.body.toString()).toBe('x');
    // Concord's own share of the feedback folder (the administrators may read) is fine to write below.
    const admins = config.adminWebIds;
    (config as { adminWebIds: string[] }).adminWebIds = ['https://admin.example/profile#me'];
    try {
      await solid.writeExisting(a.id, 'feedback/f1.json', '{}', 'application/json');
      expect(await solid.shareRead(a.id, 'feedback/', config.adminWebIds)).toBe('shared');
      expect(await status(solid.writeExisting(a.id, 'feedback/f2.json', '{}', 'application/json'))).toBe('ok');
      // Review r2 of step 5e: a rule with that name was let through whoever it named, and wherever it was.
      const fb = `${a.pod}concord/feedback/`;
      const named = (agent: string, folder: string) =>
        `${ownerOnly(folder, a.webId)}<#concord-admins> a acl:Authorization; acl:agent <${agent}>; acl:accessTo <${folder}>; acl:default <${folder}>; acl:mode acl:Read.\n`;
      docs.set(`/${a.id}/concord/feedback/.acl`, aclDoc(named('https://not-an-admin.example/#me', fb)));
      expect(await status(solid.writeExisting(a.id, 'feedback/f3.json', '{}', 'application/json'))).toMatch(/^409 .*can be opened by others than you/);
      docs.set(`/${a.id}/concord/interviews/.acl`, aclDoc(named('https://admin.example/profile#me', sub)));
      expect(await status(solid.write(a.id, 'interviews/third.ttl', 'x'))).toMatch(/^409 .*interviews\/ can be opened by others than you/);
    } finally {
      (config as { adminWebIds: string[] }).adminWebIds = admins;
    }
  });

  // Review r2 of step 5e: the check stopped at the first path not there yet, but an access control can be made
  // before the document it governs, and applies as soon as the write creates it.
  it('checks the access control of a document or folder that isn’t there yet', async () => {
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    await solid.write(a.id, 'interviews/first.ttl', 'x');
    docs.set(`/${a.id}/concord/interviews/new.ttl.acl`, aclDoc(everyone(`${a.pod}concord/interviews/new.ttl`, a.webId)));
    expect(await status(solid.write(a.id, 'interviews/new.ttl', 'x'))).toMatch(/^409 .*new\.ttl can be opened by others than you/);
    expect(docs.has(`/${a.id}/concord/interviews/new.ttl`)).toBe(false);
    docs.set(`/${a.id}/concord/later/.acl`, aclDoc(everyone(`${a.pod}concord/later/`, a.webId)));
    expect(await status(solid.write(a.id, 'later/doc.ttl', 'x'))).toMatch(/^409 .*later\/ can be opened by others than you/);
    expect([...docs.keys()].some((k) => k.includes('/later/doc'))).toBe(false);
  });

  // Review r1 of step 5e: the path was put after Concord's folder as it was, so `../x` landed elsewhere in the pod
  // (still inside it, so the pod check let it through), outside the folder Concord made private.
  it('never writes or reads outside Concord’s folder, whatever the path', async () => {
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    for (const bad of ['../public.ttl', 'use-cases/../../public.ttl', '/public.ttl', 'a/./b.ttl', 'a//b.ttl', '%2e%2e/public.ttl', 'a%2fb', 'a\\b', 'x?y', 'x#y', '']) {
      expect(await status(solid.write(a.id, bad, 'x'))).toMatch(/^400 Not a path inside Concord’s folder/);
      expect(await status(solid.read(a.id, bad))).toMatch(/^400 Not a path inside Concord’s folder/);
    }
    expect(log.filter((l) => l.startsWith('PUT'))).toEqual([]);
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
    expect(await keepOwnPodLogin(a.id, await login(a.webId), undefined)).toEqual({ status: 'no-pod' });
    expect(await status(solid.write(a.id, 'use-cases/u.ttl', 'x'))).toMatch(/pim:storage/);
    expect(log.filter((l) => l.startsWith('PUT'))).toEqual([]);
    expect(await get('privateFiles', `${a.id}/use-cases/u.ttl`)).toBeUndefined();
  });

  it('needs CONCORD_ENCRYPTION_KEY to keep the login, and says so', async () => {
    const a = await account();
    delete process.env.CONCORD_ENCRYPTION_KEY;
    expect(await keepOwnPodLogin(a.id, await login(a.webId), a.pod)).toEqual({ status: 'no-key' });
    expect(await status(solid.write(a.id, 'use-cases/u.ttl', 'x'))).toMatch(/^409 .*CONCORD_ENCRYPTION_KEY/);
  });

  it('keeps the login sealed, and refreshes it under an id of its own sign-in', async () => {
    const a = await account();
    const kept = await keepOwnPodLogin(a.id, await login(a.webId, { refreshToken: 'rt-secret' }), a.pod);
    if (kept.status !== 'kept') throw new Error('not kept');
    expect(kept.sharedId).toMatch(new RegExp(`^user:${a.id}#[0-9a-f]+$`));
    expect(JSON.stringify(await get('kv', `solid-user:${a.id}`))).not.toContain('rt-secret');
    expect(await loadOwnPodLogin(kept.sharedId)).toMatchObject({ refreshToken: 'rt-secret', sharedId: kept.sharedId });
  });

  // Review r1 of step 5e: one sealing context for every account, and loading took the row's word for whose login it
  // was, so a sealed login copied into another account's row was used as that account.
  it('opens a sealed login only for the account, WebID and pod it was kept for', async () => {
    const a = await account();
    const b = await account();
    const ka = await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    const kb = await keepOwnPodLogin(b.id, await login(b.webId), b.pod);
    if (ka.status !== 'kept' || kb.status !== 'kept') throw new Error('not kept');
    const rowA = (await get<{ sealed: string; gen: string }>('kv', `solid-user:${a.id}`))!;
    const rowB = (await get<{ id: string; webId: string; pod: string; gen: string; sealed: string }>('kv', `solid-user:${b.id}`))!;
    await put('kv', { ...rowB, sealed: rowA.sealed, gen: rowA.gen });
    expect(await loadOwnPodLogin(`user:${b.id}#${rowA.gen}`)).toBeUndefined();
    await put('kv', { ...rowB, pod: a.pod });
    expect(await loadOwnPodLogin(kb.sharedId)).toBeUndefined();
    expect(await loadOwnPodLogin(ka.sharedId)).toBeDefined();
  });

  // Review r1 of step 5e: signing out left the kept login in place, so work after it (and a refresh) could go on as them.
  it('forgets the login at sign-out, and a refresh under way can’t bring it back', async () => {
    const a = await account();
    const kept = await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    if (kept.status !== 'kept') throw new Error('not kept');
    const refreshing = (await loadOwnPodLogin(kept.sharedId))!;
    await forgetOwnPodLogin(a.id);
    await saveOwnPodLogin(kept.sharedId, { ...refreshing, accessToken: 'at-2', refreshToken: 'rt-2' });
    expect(await get('kv', `solid-user:${a.id}`)).toBeUndefined();
    expect(await status(solid.write(a.id, 'use-cases/u.ttl', 'x'))).toMatch(/^409 .*sign in with Solid again/i);
  });

  // Review r2 of step 5e: a requester made before sign-out kept sending with its unexpired token, and a refresh
  // whose save was discarded (signed out meanwhile) still reported success.
  it('sends nothing more once signed out, even through a requester made before', async () => {
    const { ownPodOf } = await import('../src/services/ownPods.js');
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    const req = await (await ownPodOf(a.id))!.request();
    expect((await req('HEAD', `${a.pod}concord/`)).status).toBe(404);
    await forgetOwnPodLogin(a.id);
    log = [];
    expect(await status(req('PUT', `${a.pod}concord/x.ttl`, { body: 'x' }))).toMatch(/^409 Your Solid sign-in has ended/);
    expect(log).toEqual([]);
  });

  // Review r3 of step 5e: the check ran once per send, outside the DPoP nonce retry, so a PUT whose first attempt met a
  // nonce challenge was sent again after a sign-out that finished while the challenge came back.
  it('sends nothing more once signed out, even when the pod first asks for a DPoP nonce', async () => {
    const { ownPodOf } = await import('../src/services/ownPods.js');
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    const req = await (await ownPodOf(a.id))!.request();
    nonceChallenge = () => forgetOwnPodLogin(a.id);
    log = [];
    expect(await status(req('PUT', `${a.pod}concord/x.ttl`, { body: 'x' }))).toMatch(/^409 Your Solid sign-in has ended/);
    expect(log).toEqual([`PUT /${a.id}/concord/x.ttl`]);
    expect(docs.has(`/${a.id}/concord/x.ttl`)).toBe(false);
  });

  it('doesn’t count a refresh that ended in a sign-out as a refresh', async () => {
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId, { expiresAt: Date.now() - 1000, refreshToken: 'rt-old' }), a.pod);
    onToken = () => forgetOwnPodLogin(a.id);
    expect(await status(solid.write(a.id, 'use-cases/u.ttl', 'x'))).toMatch(/^409 .*sign/i);
    expect(log).toContain('POST /token');
    expect(log.filter((l) => l.startsWith('PUT'))).toEqual([]);
  });

  it('signs out through the API: the kept login goes with the session', async () => {
    const request = (await import('supertest')).default;
    const { createApp } = await import('../src/app.js');
    const { createSession } = await import('../src/services/users.js');
    const { SESSION_COOKIE } = await import('../src/auth.js');
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    const token = await createSession(a.id);
    await request(createApp()).post('/api/auth/logout').set('Cookie', `${SESSION_COOKIE}=${token}`).send({}).expect(200);
    expect(await get('kv', `solid-user:${a.id}`)).toBeUndefined();
  });

  // Review r1 of step 5e: a refresh merged its tokens into whatever row was there, so a newer sign-in's key and
  // client were paired with the older sign-in's tokens.
  it('saves a refresh only into the sign-in it refreshed, never into a newer one', async () => {
    const a = await account();
    const first = await keepOwnPodLogin(a.id, await login(a.webId, { refreshToken: 'rt-first' }), a.pod);
    if (first.status !== 'kept') throw new Error('not kept');
    const old = (await loadOwnPodLogin(first.sharedId))!;
    const second = await keepOwnPodLogin(a.id, await login(a.webId, { refreshToken: 'rt-second' }), a.pod);
    if (second.status !== 'kept') throw new Error('not kept');
    await saveOwnPodLogin(first.sharedId, { ...old, refreshToken: 'rt-first-rotated' });
    expect(await loadOwnPodLogin(first.sharedId)).toBeUndefined();
    expect(await loadOwnPodLogin(second.sharedId)).toMatchObject({ refreshToken: 'rt-second' });
    await saveOwnPodLogin(second.sharedId, { ...(await loadOwnPodLogin(second.sharedId))!, refreshToken: 'rt-second-rotated' });
    expect(await loadOwnPodLogin(second.sharedId)).toMatchObject({ refreshToken: 'rt-second-rotated' });
  });

  // Review r1 of step 5e: a failed read of their own pod fell back to this server's store, so a refused or broken pod
  // looked like stale or missing data.
  it('reports a read their pod fails, and only a missing document reads as missing', async () => {
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    await put('privateFiles', { id: `${a.id}/use-cases/u.ttl`, data: Buffer.from('stale copy here').toString('base64') }, a.id);
    expect(await solid.read(a.id, 'use-cases/u.ttl')).toBeUndefined();
    await solid.write(a.id, 'use-cases/u.ttl', 'in the pod');
    expect(await solid.read(a.id, 'use-cases/u.ttl')).toBe('in the pod');
    refuse = (method) => (method === 'GET' ? 500 : undefined);
    expect(await status(solid.read(a.id, 'use-cases/u.ttl'))).toMatch(/^502 Couldn’t read from your pod: .*500/);
  });

  // A Solid sign-in gives one refresh token, which a provider may rotate at each use. An administrator's session
  // kept its own copy beside the own-pod one, so a refresh through either would have ended the other.
  it('gives an administrator’s session the same login as their own pod, refreshed in one place', async () => {
    const { adminLoginFor, keepAdminLogin, SESSION_COOKIE } = await import('../src/auth.js');
    const { sessionKey } = await import('../src/solidOidc.js');
    const a = await account();
    const l = await login(a.webId, { refreshToken: 'rt-shared' });
    const kept = await keepOwnPodLogin(a.id, l, a.pod);
    if (kept.status !== 'kept') throw new Error('not kept');
    const token = `admin-session-${a.id}`;
    expect(await keepAdminLogin(token, l, { sharedWith: kept.sharedId })).toBe(true);
    const row = await get<{ ref?: string; sealed: string }>('kv', `admin-login:${sessionKey(token)}`);
    expect(row).toMatchObject({ ref: kept.sharedId, sealed: '' });
    expect(await adminLoginFor({ cookies: { [SESSION_COOKIE]: token } } as never)).toMatchObject({ refreshToken: 'rt-shared', sharedId: kept.sharedId });
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

describe('private data kept on this server for a Solid account', () => {
  // Follow-up to step 5e: the cutover brings what Concord kept in the pods the VM made into this server's store
  // (migrate --pods). For a Solid account that isn't where it belongs, and on Vercel it would never have been read
  // again (their reads go to their own pod), so it was as good as lost.
  it('moves into their own pod, never over what is there, and only then leaves this server', async () => {
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    const row = (rel: string, body: string) => put('privateFiles', { id: `${a.id}/${rel}`, data: Buffer.from(body).toString('base64') }, a.id);
    await row('use-cases/u.ttl', 'from the VM');
    await row('interviews/i.ttl', 'transcript');
    docs.set(`/${a.id}/concord/use-cases/u.ttl`, { body: Buffer.from('theirs'), type: 'text/turtle', etag: '"t"' });
    refuse = (method, path) => (method === 'PUT' && path.endsWith('/i.ttl') ? 503 : undefined);
    await expect(solid.carryIntoOwnPod(a.id)).rejects.toThrow(/503/);
    // What did move is gone from here; the rest waits for the next try.
    expect(await get('privateFiles', `${a.id}/use-cases/u.ttl`)).toBeUndefined();
    expect(await get('privateFiles', `${a.id}/interviews/i.ttl`)).toBeDefined();
    refuse = undefined;
    expect(await solid.carryIntoOwnPod(a.id)).toBe(1);
    expect(docs.get(`/${a.id}/concord/use-cases/u.ttl`)?.body.toString()).toBe('theirs');
    expect(docs.get(`/${a.id}/concord/use-cases/u.from-concord-1.ttl`)?.body.toString()).toBe('from the VM');
    expect(docs.get(`/${a.id}/concord/interviews/i.ttl`)?.body.toString()).toBe('transcript');
    expect(await get('privateFiles', `${a.id}/interviews/i.ttl`)).toBeUndefined();
    expect(await solid.carryIntoOwnPod(a.id)).toBe(0);
  });

  // Review r1 of the pod copy: when a document's move reached the pod but removing it here failed, the next try found
  // its own copy in the way, as if someone else's. With the original name and the first three spare names taken, it
  // then found no free name at all and stopped for good, holding up everything after it.
  it('recognises a move that reached the pod but was never removed here, and finishes it', async () => {
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    await put('privateFiles', { id: `${a.id}/use-cases/u.ttl`, data: Buffer.from('from the VM').toString('base64') }, a.id);
    await put('privateFiles', { id: `${a.id}/use-cases/v.ttl`, data: Buffer.from('next').toString('base64') }, a.id);
    const at = (name: string) => `/${a.id}/concord/use-cases/${name}`;
    docs.set(at('u.ttl'), { body: Buffer.from('theirs'), type: 'text/turtle', etag: '"0"' });
    for (const n of [1, 2, 3]) docs.set(at(`u.from-concord-${n}.ttl`), { body: Buffer.from(`theirs ${n}`), type: 'text/turtle', etag: `"${n}"` });
    // The last try wrote the fourth spare name, then couldn't remove the row.
    docs.set(at('u.from-concord-4.ttl'), { body: Buffer.from('from the VM'), type: 'text/turtle', etag: '"4"' });
    expect(await solid.carryIntoOwnPod(a.id)).toBe(2);
    expect(await get('privateFiles', `${a.id}/use-cases/u.ttl`)).toBeUndefined();
    expect(docs.get(at('v.ttl'))?.body.toString()).toBe('next');
    // Nothing of theirs was touched, and no second copy was made.
    expect(docs.get(at('u.ttl'))?.body.toString()).toBe('theirs');
    expect([...docs.keys()].filter((k) => k.includes('/use-cases/u.from-concord-'))).toHaveLength(4);
  });

  it('stays here for Google and GitHub accounts', async () => {
    const g = await account('github');
    await put('privateFiles', { id: `${g.id}/use-cases/u.ttl`, data: Buffer.from('x').toString('base64') }, g.id);
    expect(await solid.carryIntoOwnPod(g.id)).toBe(0);
    expect(await get('privateFiles', `${g.id}/use-cases/u.ttl`)).toBeDefined();
  });

  // The testing record's state (kept aside, revision copied) came over from the VM, where it described the VM's pod.
  // In their own pod nothing had been kept aside, so their own document at that path would have been replaced.
  it('copies the testing record afresh in their own pod, keeping what is there aside first', async () => {
    const { mirrorToPod } = await import('../src/services/alpha.js');
    const a = await account();
    await keepOwnPodLogin(a.id, await login(a.webId), a.pod);
    await put('kv', { id: `alpha-history:${a.id}`, versions: [{ version: '0.9.0', firstSeen: '2026-11-01T00:00:00.000Z', lastSeen: '2026-11-01T00:00:00.000Z' }], rev: 3, mirroredRev: 3, keptExisting: true });
    docs.set(`/${a.id}/concord/alpha/testing.jsonld`, { body: Buffer.from('{"mine":true}'), type: 'application/ld+json', etag: '"m"' });
    await mirrorToPod((await get('users', a.id))!);
    const aside = [...docs.keys()].filter((k) => /\/alpha\/testing\.previous-\d+-\d+\.jsonld$/.test(k));
    expect(aside).toHaveLength(1);
    expect(docs.get(aside[0]!)?.body.toString()).toBe('{"mine":true}');
    expect(JSON.parse(docs.get(`/${a.id}/concord/alpha/testing.jsonld`)!.body.toString())).toMatchObject({ '@type': 'concord:AlphaTestingRecord', revision: 3 });
    expect(await get('kv', `alpha-history:${a.id}`)).toMatchObject({ keptIn: `${a.pod}concord/alpha/`, mirroredRev: 3 });
  });
});

describe('finding someone’s pod', () => {
  it('finds the folder above a WebID that says it is a pod, when the profile names none', async () => {
    expect(await storageAbove(`${base}/alice/profile/card#me`)).toBe(`${base}/alice/`);
    expect(await storageAbove(`${base}/nostorage/profile/card#me`)).toBeUndefined();
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
