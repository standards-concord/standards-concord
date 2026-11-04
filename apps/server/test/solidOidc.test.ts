import fs from 'node:fs';
import request from 'supertest';
import { Parser } from 'n3';
import { beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@concord/shared';
import { createApp } from '../src/app.js';
import { isAdmin } from '../src/auth.js';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { parseLinks, shareFolder, wacMerge } from '../src/services/solid.js';
import type { PodRequest } from '../src/solidOidc.js';
import { feedbackMembers } from '../src/services/feedback.js';
import { clientIdDocument, issuerListed, nameFromWebId, parseProfile, resolveIssuer, sameIssuer, SolidLoginError } from '../src/solidOidc.js';

const app = createApp();
beforeAll(() => openDb());

const WEBID = 'https://alice.example/profile/card#me';
const PROFILE = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
<#me> a foaf:Person ; foaf:name "Alice" ; solid:oidcIssuer <https://idp.example/> .
<#someone-else> solid:oidcIssuer <https://evil.example/> .`;

describe('WebID profiles', () => {
  it('reads the WebID’s own issuers and name, not anyone else’s in the document', () => {
    const p = parseProfile(WEBID, 'https://alice.example/profile/card', PROFILE);
    expect(p).toEqual({ webId: WEBID, issuers: ['https://idp.example/'], name: 'Alice' });
  });

  it('accepts a sign-in only from a provider the profile names (trailing slash aside)', () => {
    const p = parseProfile(WEBID, 'https://alice.example/profile/card', PROFILE);
    expect(issuerListed(p, 'https://idp.example')).toBe(true);
    expect(issuerListed(p, 'https://idp.example/')).toBe(true);
    expect(issuerListed(p, 'https://evil.example/')).toBe(false);
    expect(issuerListed(p, 'https://idp.example.evil/')).toBe(false);
    expect(sameIssuer('https://a.example/', 'https://a.example')).toBe(true);
  });

  it('rejects a profile that isn’t Turtle', () => {
    expect(() => parseProfile(WEBID, 'https://alice.example/profile/card', '<<< not turtle')).toThrow(SolidLoginError);
  });

  it('names someone from their WebID when the profile has no name', () => {
    expect(nameFromWebId('http://localhost:3990/visitor/profile/card#me')).toBe('visitor');
    expect(nameFromWebId('https://jesse.solidcommunity.net/profile/card#me')).toBe('jesse.solidcommunity.net');
  });
});

describe('where a Solid sign-in may go', () => {
  it('refuses private addresses, plain http and user names in the WebID or provider', async () => {
    await expect(resolveIssuer('https://127.0.0.1/profile/card#me')).rejects.toThrow(/isn’t reachable from Concord/);
    await expect(resolveIssuer('https://localhost:9/profile/card#me')).rejects.toThrow(/isn’t reachable from Concord/);
    await expect(resolveIssuer('https://[::1]/')).rejects.toThrow(/isn’t reachable from Concord/);
    await expect(resolveIssuer('https://169.254.169.254/latest/')).rejects.toThrow(/isn’t reachable from Concord/);
    await expect(resolveIssuer('http://alice.example/profile/card#me')).rejects.toThrow(/must start with https/);
    await expect(resolveIssuer('https://user:pw@alice.example/')).rejects.toThrow(/user name or password/);
    await expect(resolveIssuer('not a url')).rejects.toThrow(/doesn’t look like/);
  });

  it('allows a private, plain-http provider only when the operator trusts it', async () => {
    const saved = [...config.solidOidc.trustedIssuers];
    config.solidOidc.trustedIssuers.push('http://127.0.0.1:1/');
    try {
      // Trusted, so it is tried (and here fails to connect) rather than refused outright.
      await expect(resolveIssuer('http://127.0.0.1:1/alice/profile/card#me')).rejects.toThrow(/doesn’t look like a Solid provider/);
    } finally {
      config.solidOidc.trustedIssuers.splice(0, config.solidOidc.trustedIssuers.length, ...saved);
    }
  });

  it('sends a sign-in error back to the login page instead of a bare error', async () => {
    const r = await request(app).get('/auth/solid').query({ webId: 'https://127.0.0.1/profile/card#me', returnTo: '/feedback' });
    expect(r.status).toBe(302);
    const to = new URL(r.headers.location);
    expect(to.pathname).toBe('/login');
    expect(to.searchParams.get('next')).toBe('/feedback');
    expect(to.searchParams.get('solidError')).toMatch(/isn’t reachable from Concord/);
  });

  it('refuses a callback that this browser didn’t start', async () => {
    const r = await request(app).get('/auth/solid/callback?code=abc&state=xyz').set('Cookie', 'solid_login=not-a-login');
    expect(r.status).toBe(302);
    expect(new URL(r.headers.location).searchParams.get('solidError')).toMatch(/expired or was started in another browser/);
    expect(String(r.headers['set-cookie'])).toMatch(/solid_login=;/);
  });

  it('serves a Solid-OIDC Client ID Document', async () => {
    const r = await request(app).get('/auth/solid/client.jsonld');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/ld\+json/);
    expect(r.body).toMatchObject({ client_name: 'Concord', redirect_uris: [`${config.publicUrl}/auth/solid/callback`], token_endpoint_auth_method: 'none' });
    expect(clientIdDocument().scope).toContain('webid');
  });

  it('reports Solid sign-in and the feedback readers in the session', async () => {
    const r = await request(app).get('/api/session');
    expect(r.body.providers.solid).toBe(true);
    expect(r.body.feedbackReaders).toEqual(config.adminWebIds);
  });
});

describe('administrators by WebID', () => {
  const user = (over: Partial<User>): User => ({ id: 'u', name: 'U', webId: 'https://jesse.example/profile/card#me', providers: [], createdAt: '', ...over });

  it('counts a WebID in ADMIN_WEBIDS when they signed in with Solid, never as a demo account or persona', () => {
    const saved = [...config.adminWebIds];
    config.adminWebIds.splice(0, saved.length, 'https://jesse.example/profile/card#me');
    try {
      expect(isAdmin(user({ providers: [{ provider: 'solid', subject: 'https://jesse.example/profile/card#me' }] }))).toBe(true);
      expect(isAdmin(user({ providers: [{ provider: 'demo', subject: 'x' }] }))).toBe(false);
      expect(isAdmin(user({ providers: [{ provider: 'solid', subject: 'https://jesse.example/profile/card#me' }], simulated: true }))).toBe(false);
      expect(isAdmin(user({ webId: 'https://other.example/#me', providers: [{ provider: 'solid', subject: 'https://other.example/#me' }] }))).toBe(false);
    } finally {
      config.adminWebIds.splice(0, config.adminWebIds.length, ...saved);
    }
  });
});

describe('sharing a pod folder with the admins', () => {
  const folder = 'https://pods.example/t1/concord/feedback/';
  const acl = `${folder}.acl`;
  const owner = 'https://pods.example/t1/profile/card#me';
  const admins = ['https://jesse.example/profile/card#me', 'https://kim.example/#me'];
  const parse = (ttl: string, base: string) => new Parser({ baseIRI: base }).parse(ttl);
  /** Authorization subject → its "predicate object" pairs (local names for predicates). */
  const auths = (ttl: string, base = acl) => {
    const out = new Map<string, string[]>();
    for (const q of parse(ttl, base)) {
      const k = q.subject.value;
      out.set(k, [...(out.get(k) ?? []), `${q.predicate.value.replace(/.*[#/]/, '')} ${q.object.value}`]);
    }
    return out;
  };
  const A = 'http://www.w3.org/ns/auth/acl#';

  it('WAC, no ACL yet: carries over the inherited default rules, then adds read for the admins', async () => {
    const root = 'https://pods.example/t1/';
    const inherited = parse(
      `@prefix acl: <${A}> .
<#owner> a acl:Authorization ; acl:agent <${owner}>, <https://owner-elsewhere.example/#me> ; acl:accessTo <./> ; acl:default <./> ; acl:mode acl:Read, acl:Write, acl:Control .
<#public-root> a acl:Authorization ; acl:agentClass <http://xmlns.com/foaf/0.1/Agent> ; acl:accessTo <./> ; acl:mode acl:Read .`,
      `${root}.acl`,
    );
    const out = auths(await wacMerge(folder, acl, undefined, { container: root, quads: inherited }, owner, admins));
    const copy = out.get(`${acl}#inherited-1`)!;
    expect(copy).toEqual(expect.arrayContaining([`agent ${owner}`, 'agent https://owner-elsewhere.example/#me', `accessTo ${folder}`, `default ${folder}`, `mode ${A}Control`]));
    // A rule that applied to the root only (no acl:default) is not inherited, so it isn't copied.
    expect([...out.keys()].some((k) => k.includes('inherited-2'))).toBe(false);
    expect(out.get(`${acl}#concord-admins`)).toEqual(expect.arrayContaining([...admins.map((a) => `agent ${a}`), `accessTo ${folder}`, `default ${folder}`, `mode ${A}Read`]));
    expect(out.get(`${acl}#concord-admins`)!.filter((x) => x.startsWith('mode'))).toEqual([`mode ${A}Read`]);
    // The owner's Control came over with the inherited rule, so no extra owner rule is added.
    expect(out.has(`${acl}#concord-owner`)).toBe(false);
  });

  it('WAC, existing ACL: keeps every other rule and replaces only Concord’s', async () => {
    const existing = parse(
      `@prefix acl: <${A}> .
<#owner> a acl:Authorization ; acl:agent <${owner}> ; acl:accessTo <./> ; acl:default <./> ; acl:mode acl:Read, acl:Write, acl:Control .
<#their-app> a acl:Authorization ; acl:agent <https://someone.example/#me> ; acl:accessTo <./> ; acl:mode acl:Read, acl:Control .
<#concord-admins> a acl:Authorization ; acl:agent <https://removed-admin.example/#me> ; acl:accessTo <./> ; acl:default <./> ; acl:mode acl:Read .`,
      acl,
    );
    const out = auths(await wacMerge(folder, acl, existing, undefined, owner, [admins[0]!]));
    expect(out.get(`${acl}#their-app`)).toEqual(expect.arrayContaining(['agent https://someone.example/#me', `mode ${A}Control`]));
    expect(out.get(`${acl}#owner`)).toEqual(expect.arrayContaining([`agent ${owner}`, `mode ${A}Control`]));
    expect(out.get(`${acl}#concord-admins`)).toContain(`agent ${admins[0]}`);
    expect(out.get(`${acl}#concord-admins`)).not.toContain('agent https://removed-admin.example/#me');

    // No admins any more: Concord's rule goes, the rest stays.
    const none = auths(await wacMerge(folder, acl, existing, undefined, owner, []));
    expect(none.has(`${acl}#concord-admins`)).toBe(false);
    expect(none.has(`${acl}#their-app`)).toBe(true);
  });

  it('WAC: the pod owner always keeps control of the folder', async () => {
    const out = auths(await wacMerge(folder, acl, [], undefined, owner, admins));
    expect(out.get(`${acl}#concord-owner`)).toEqual(expect.arrayContaining([`agent ${owner}`, `accessTo ${folder}`, `mode ${A}Control`, `mode ${A}Write`]));
  });

  it('serialises with an RDF writer: an odd WebID stays one IRI and grants nothing more', async () => {
    const odd = 'https://x.example/> ; acl:mode acl:Write . <#a';
    const ttl = await wacMerge(folder, acl, [], undefined, owner, [odd]);
    const out = auths(ttl);
    expect(out.get(`${acl}#concord-admins`)!.filter((x) => x.startsWith('mode'))).toEqual([`mode ${A}Read`]);
    expect(out.get(`${acl}#concord-admins`)!.filter((x) => x.startsWith('agent'))).toHaveLength(1);
    await expect(wacMerge(folder, acl, [], undefined, owner, ['javascript:alert(1)'])).rejects.toThrow(/Not a usable IRI/);
  });

  it('finds the access control resource in Link headers, however they are combined', () => {
    const links = parseLinks('<http://www.w3.org/ns/ldp#Container>; rel="type", <.acl>; rel="acl", <http://x/.meta>; rel=describedby', folder);
    expect(links.find((l) => l.rel === 'acl')?.url).toBe(`${folder}.acl`);
    expect(links.find((l) => l.rel === 'describedby')?.url).toBe('http://x/.meta');
  });
});

/**
 * A pod in memory: containers answer HEAD with their ACL's Link, ACLs have ETags
 * and honour If-Match / If-None-Match on PUT. `status` overrides a container's
 * HEAD; `beforePut` runs just before a PUT is checked (a concurrent edit).
 */
function fakePod(opts: { acp?: boolean; noEtag?: boolean } = {}) {
  const root = 'https://pods.example/t1/';
  const folder = `${root}concord/feedback/`;
  const containers = new Set([root, `${root}concord/`, folder]);
  const docs = new Map<string, { body: string; version: number }>();
  const status = new Map<string, number>();
  const puts: { url: string; headers: Record<string, string>; body: string }[] = [];
  let version = 0;
  let beforePut: ((url: string) => void) | undefined;
  const etag = (url: string) => `"v${docs.get(url)!.version}"`;
  const set = (url: string, body: string) => docs.set(url, { body, version: ++version });
  const req: PodRequest = async (method, url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (method === 'HEAD') {
      if (status.has(url)) return new Response(null, { status: status.get(url) });
      if (!containers.has(url)) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { link: opts.acp ? '<.acr>; rel="acl"' : '<.acl>; rel="acl", <http://www.w3.org/ns/ldp#Container>; rel="type"' } });
    }
    if (method === 'GET') {
      const d = docs.get(url);
      if (!d) return new Response('', { status: 404 });
      return new Response(d.body, { status: 200, headers: { 'content-type': 'text/turtle', ...(opts.noEtag ? {} : { etag: etag(url) }) } });
    }
    beforePut?.(url);
    puts.push({ url, headers, body: init.body ?? '' });
    if (containers.has(url)) return new Response('', { status: 205 });
    if (headers['if-none-match'] === '*' && docs.has(url)) return new Response('', { status: 412 });
    if (headers['if-match'] && (!docs.has(url) || headers['if-match'] !== etag(url))) return new Response('', { status: 412 });
    set(url, init.body ?? '');
    return new Response('', { status: 201 });
  };
  return { root, folder, acl: `${folder}.acl`, docs, set, status, puts, req, onPut: (fn: typeof beforePut) => (beforePut = fn) };
}

describe('writing the sharing rule to a pod', () => {
  const owner = 'https://pods.example/t1/profile/card#me';
  const admin = 'https://jesse.example/profile/card#me';
  const A = 'http://www.w3.org/ns/auth/acl#';
  const rootAcl = `@prefix acl: <${A}> .
<#owner> a acl:Authorization ; acl:agent <${owner}> ; acl:accessTo <./> ; acl:default <./> ; acl:mode acl:Read, acl:Write, acl:Control .`;

  it('creates the folder’s ACL only if it still doesn’t exist, from the ACL it inherits', async () => {
    const pod = fakePod();
    pod.set(`${pod.root}.acl`, rootAcl);
    expect(await shareFolder(pod.req, pod.folder, pod.root, owner, [admin])).toBe('shared');
    expect(pod.puts).toHaveLength(1);
    expect(pod.puts[0]!.headers['if-none-match']).toBe('*');
    const ttl = pod.docs.get(pod.acl)!.body;
    expect(ttl).toContain('inherited-1');
    expect(ttl).toContain(admin);
  });

  it('updates an existing ACL only if it is still the version it read (If-Match its ETag)', async () => {
    const pod = fakePod();
    pod.set(pod.acl, rootAcl);
    const read = `"v${pod.docs.get(pod.acl)!.version}"`;
    await shareFolder(pod.req, pod.folder, pod.root, owner, [admin]);
    expect(pod.puts[0]!.headers['if-match']).toBe(read);
  });

  it('never overwrites a concurrent edit: it re-reads once and keeps the edit, and gives up on a second', async () => {
    const pod = fakePod();
    pod.set(pod.acl, rootAcl);
    const theirs = `${rootAcl}\n<#their-app> a acl:Authorization ; acl:agent <https://someone.example/#me> ; acl:accessTo <./> ; acl:mode acl:Read, acl:Control .`;
    let edits = 1;
    pod.onPut(() => edits-- > 0 && pod.set(pod.acl, theirs));
    await shareFolder(pod.req, pod.folder, pod.root, owner, [admin]);
    expect(pod.puts).toHaveLength(2);
    const ttl = pod.docs.get(pod.acl)!.body;
    expect(ttl).toContain('https://someone.example/#me');
    expect(ttl).toContain(admin);

    const busy = fakePod();
    busy.set(busy.acl, rootAcl);
    busy.onPut(() => busy.set(busy.acl, theirs));
    await expect(shareFolder(busy.req, busy.folder, busy.root, owner, [admin])).rejects.toThrow(/changed while Concord was updating it/);
    expect(busy.docs.get(busy.acl)!.body).toBe(theirs);
  });

  it('stops without writing when an ancestor’s access can’t be read (403, 503), rather than skipping it', async () => {
    for (const code of [403, 503, 401]) {
      const pod = fakePod();
      // The root would let everyone read; the nearer folder is the one that can't be seen.
      pod.set(`${pod.root}.acl`, `${rootAcl}\n<#public> a acl:Authorization ; acl:agentClass <http://xmlns.com/foaf/0.1/Agent> ; acl:accessTo <./> ; acl:default <./> ; acl:mode acl:Read .`);
      pod.status.set(`${pod.root}concord/`, code);
      await expect(shareFolder(pod.req, pod.folder, pod.root, owner, [admin])).rejects.toThrow(new RegExp(`answered ${code}`));
      expect(pod.puts).toHaveLength(0);
    }
  });

  it('stops without writing when an ancestor’s ACL answers anything but 200 or 404', async () => {
    const pod = fakePod();
    const req: PodRequest = async (method, url, init) => (method === 'GET' && url === `${pod.root}concord/.acl` ? new Response('', { status: 500 }) : pod.req(method, url, init));
    pod.set(`${pod.root}.acl`, rootAcl);
    await expect(shareFolder(req, pod.folder, pod.root, owner, [admin])).rejects.toThrow(/→ 500/);
    expect(pod.puts).toHaveLength(0);
  });

  it('stops without writing when no inherited ACL can be found at all', async () => {
    const pod = fakePod();
    await expect(shareFolder(pod.req, pod.folder, pod.root, owner, [admin])).rejects.toThrow(/Couldn’t find the access control/);
    expect(pod.puts).toHaveLength(0);
  });

  it('refuses a pod that uses ACP, changing nothing', async () => {
    const pod = fakePod({ acp: true });
    await expect(shareFolder(pod.req, pod.folder, pod.root, owner, [admin])).rejects.toThrow(/uses ACP access control/);
    expect(pod.puts).toHaveLength(0);
  });

  it('refuses to change an ACL that has no ETag', async () => {
    const pod = fakePod({ noEtag: true });
    pod.set(pod.acl, rootAcl);
    await expect(shareFolder(pod.req, pod.folder, pod.root, owner, [admin])).rejects.toThrow(/no ETag/);
    expect(pod.puts).toHaveLength(0);
  });
});

describe('the pod and sign-in modules never use the plain fetch', () => {
  const read = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  /** fetch( not preceded by a letter, digit, dot or underscore: the global fetch, or a bare import of it. */
  const bareFetch = /(?<![\w.$])fetch\s*\(/;
  it('solidOidc.ts and services/solid.ts go through guardedFetch / podFetch only', () => {
    for (const f of ['solidOidc.ts', 'services/solid.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(bareFetch);
      expect(src, f).not.toMatch(/globalThis\.fetch|@inrupt|from 'undici'|node:https?'/);
    }
  });
  it('the admin’s pod reads in services/feedback.ts use only the pod reader they are given', () => {
    const src = read('services/feedback.ts');
    const pods = src.slice(src.indexOf('Administrators read testers'), src.indexOf('export async function transcribe'));
    expect(pods.length).toBeGreaterThan(1000);
    expect(pods).not.toMatch(bareFetch);
  });
});

describe('reading a feedback folder listing', () => {
  const folder = 'https://pods.example/t1/concord/feedback/';
  const listing = (body: string) => `@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<${folder}> ${body} .`;

  it('takes only Concord’s own documents directly in the folder', () => {
    expect(feedbackMembers(folder, listing(`ldp:contains <fb_1.json>, <${folder}fb_2.json>`))).toEqual([`${folder}fb_1.json`, `${folder}fb_2.json`]);
  });

  it('ignores traversal, encoded slashes, other places, literals, other subjects and query strings', () => {
    const bad = [
      `ldp:contains <${folder}%2e%2e/private.json>`,
      `ldp:contains <${folder}..%2Fprivate.json>`,
      `ldp:contains <${folder}sub/fb.json>`,
      'ldp:contains <https://elsewhere.example/fb.json>',
      `ldp:contains "${folder}fb_1.json"`,
      `ldp:contains <${folder}fb_1.json?x=1>`,
      `ldp:contains <${folder}notes.txt>`,
    ];
    for (const b of bad) expect(feedbackMembers(folder, listing(b)), b).toEqual([]);
    expect(feedbackMembers(folder, `@prefix ldp: <http://www.w3.org/ns/ldp#> . <https://pods.example/other/> ldp:contains <${folder}fb_1.json> .`)).toEqual([]);
  });
});

describe('starting a Solid sign-in from another site', () => {
  it('is refused, so the route can’t be used to send people to an arbitrary site', async () => {
    const r = await request(app).get('/auth/solid').query({ webId: 'https://idp.example/' }).set('Sec-Fetch-Site', 'cross-site');
    expect(r.status).toBe(302);
    expect(new URL(r.headers.location).searchParams.get('solidError')).toBe('Start signing in with your WebID from this page.');
  });
});
