import request from 'supertest';
import { Parser } from 'n3';
import { beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@concord/shared';
import { createApp } from '../src/app.js';
import { isAdmin } from '../src/auth.js';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { acpDocument, parseLinks, wacDocument } from '../src/services/solid.js';
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
  const owner = 'https://pods.example/t1/profile/card#me';
  const admins = ['https://jesse.example/profile/card#me', 'https://kim.example/#me'];
  const triples = (ttl: string, base: string) => new Parser({ baseIRI: base }).parse(ttl).map((q) => [q.subject.termType === 'BlankNode' ? '_' : q.subject.value, q.predicate.value.replace(/.*[#/]/, ''), q.object.termType === 'BlankNode' ? '_' : q.object.value]);

  it('WAC: the owner keeps control; admins may read the folder and what’s in it', () => {
    const t = triples(wacDocument(folder, owner, admins), `${folder}.acl`);
    const auth = (name: string) => t.filter(([s]) => s === `${folder}.acl#${name}`).map(([, p, o]) => `${p} ${o}`);
    expect(auth('owner')).toEqual(expect.arrayContaining([`agent ${owner}`, `accessTo ${folder}`, `default ${folder}`, 'mode http://www.w3.org/ns/auth/acl#Control']));
    expect(auth('concord-admins')).toEqual(expect.arrayContaining([...admins.map((a) => `agent ${a}`), `accessTo ${folder}`, `default ${folder}`, 'mode http://www.w3.org/ns/auth/acl#Read']));
    expect(auth('concord-admins')).not.toContain('mode http://www.w3.org/ns/auth/acl#Write');
    // No admins listed: only the owner.
    expect(wacDocument(folder, owner, [])).not.toContain('concord-admins');
  });

  it('ACP: the same policy for servers that use Access Control Policies', () => {
    const ttl = acpDocument(folder, owner, admins);
    const t = triples(ttl, `${folder}.acr`);
    expect(t).toEqual(expect.arrayContaining([[`${folder}.acr`, 'resource', folder], [`${folder}.acr`, 'memberAccessControl', `${folder}.acr#admin-access`]]));
    expect(t.filter(([, p]) => p === 'agent').map(([, , o]) => o)).toEqual([owner, ...admins]);
  });

  it('won’t write an IRI that could break out of the document', () => {
    expect(() => wacDocument(folder, owner, ['https://x.example/> ; acl:mode acl:Write . <#a'])).toThrow(/Not a usable IRI/);
    expect(() => wacDocument(folder, owner, ['javascript:alert(1)'])).toThrow(/Not a usable IRI/);
  });

  it('finds the access control resource in Link headers, however they are combined', () => {
    const links = parseLinks('<http://www.w3.org/ns/ldp#Container>; rel="type", <.acl>; rel="acl", <http://x/.meta>; rel=describedby', folder);
    expect(links.find((l) => l.rel === 'acl')?.url).toBe(`${folder}.acl`);
    expect(links.find((l) => l.rel === 'describedby')?.url).toBe('http://x/.meta');
  });
});

describe('starting a Solid sign-in from another site', () => {
  it('is refused, so the route can’t be used to send people to an arbitrary site', async () => {
    const r = await request(app).get('/auth/solid').query({ webId: 'https://idp.example/' }).set('Sec-Fetch-Site', 'cross-site');
    expect(r.status).toBe(302);
    expect(new URL(r.headers.location).searchParams.get('solidError')).toBe('Start signing in with your WebID from this page.');
  });
});
