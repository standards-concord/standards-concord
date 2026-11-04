import fs from 'node:fs';
import path from 'node:path';
import { Session } from '@inrupt/solid-client-authn-node';
import type { User } from '@concord/shared';
import { config } from '../config.js';
import { get, list, put } from '../db.js';
import { DataFactory, Parser, Writer, type Quad } from 'n3';
import { slugify } from '../ids.js';

/**
 * Private data lives in each person's Solid pod. People never see this:
 * on first sign-in the platform silently provisions a pod and WebID on a
 * Community Solid Server (v7 JSON account API) under one platform-owned
 * account, mints client credentials bound to that WebID, and from then on
 * reads and writes that person's private resources as them.
 *
 * Without a Solid server configured, the same API falls back to local files,
 * and the WebID is a profile document served by this platform.
 */

interface PodRecord {
  id: string; // user id
  podUrl: string;
  webId: string;
  clientId: string;
  clientSecret: string;
}

interface Kv<T> {
  id: string;
  value: T;
}

const json = async (r: Response) => {
  if (!r.ok) throw new Error(`Solid server ${r.url} → ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
};

async function platformAccountToken(base: string): Promise<string> {
  const saved = get<Kv<string>>('kv', 'solid-account-token');
  if (saved) {
    // Check it still works; CSS account tokens expire with the cookie lifetime.
    const r = await fetch(`${base}/.account/`, { headers: { authorization: `CSS-Account-Token ${saved.value}` } });
    const body = await r.json().catch(() => undefined);
    if (body?.controls?.account?.pod) return saved.value;
  }
  // Create a platform account with a password so we can log back in.
  const creds = get<Kv<{ email: string; password: string }>>('kv', 'solid-account-login');
  let { controls } = await json(await fetch(`${base}/.account/`));
  let authorization: string;
  if (creds) {
    ({ authorization } = await json(
      await fetch(controls.password.login, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: creds.value.email, password: creds.value.password }),
      }),
    ));
  } else {
    ({ authorization } = await json(await fetch(controls.account.create, { method: 'POST' })));
    const login = { email: `platform@${new URL(config.publicUrl).hostname || 'concord.local'}`, password: crypto.randomUUID() };
    ({ controls } = await json(await fetch(`${base}/.account/`, { headers: { authorization: `CSS-Account-Token ${authorization}` } })));
    await json(
      await fetch(controls.password.create, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `CSS-Account-Token ${authorization}` },
        body: JSON.stringify(login),
      }),
    );
    put('kv', { id: 'solid-account-login', value: login });
  }
  put('kv', { id: 'solid-account-token', value: authorization });
  return authorization;
}

const sessions = new Map<string, Session>();

async function sessionFor(rec: PodRecord): Promise<Session> {
  let s = sessions.get(rec.id);
  if (s?.info.isLoggedIn) return s;
  s = new Session({ keepAlive: true });
  await s.login({ clientId: rec.clientId, clientSecret: rec.clientSecret, oidcIssuer: `${config.solid.serverUrl}/` });
  sessions.set(rec.id, s);
  return s;
}

export const solid = {
  get enabled() {
    return !!config.solid.serverUrl;
  },

  localWebId(userId: string) {
    return `${config.publicUrl}/people/${userId}#me`;
  },

  /** Provision a pod + WebID for a user. Idempotent. Returns {webId, podUrl}. */
  async provision(user: Pick<User, 'id' | 'name'>): Promise<{ webId: string; podUrl?: string }> {
    if (!this.enabled) return { webId: this.localWebId(user.id), podUrl: `${config.publicUrl}/people/${user.id}/` };
    const existing = get<PodRecord>('kv', `pod:${user.id}`);
    if (existing) return { webId: existing.webId, podUrl: existing.podUrl };
    const base = config.solid.serverUrl!;
    const token = await platformAccountToken(base);
    const headers = { 'content-type': 'application/json', authorization: `CSS-Account-Token ${token}` };
    // No content-type on the GET: CSS 7.3 then tries to parse the empty body as JSON and fails with a 500.
    const { controls } = await json(await fetch(`${base}/.account/`, { headers: { authorization: headers.authorization } }));
    const name = `${slugify(user.name).slice(0, 24)}-${user.id.slice(-6)}`.toLowerCase();
    const pod = await json(await fetch(controls.account.pod, { method: 'POST', headers, body: JSON.stringify({ name }) }));
    const podUrl: string = pod.pod ?? `${base}/${name}/`;
    const webId: string = pod.webId ?? `${podUrl}profile/card#me`;
    const cc = await json(
      await fetch(controls.account.clientCredentials, { method: 'POST', headers, body: JSON.stringify({ name: `concord-${user.id}`, webId }) }),
    );
    const rec: PodRecord = { id: `pod:${user.id}`, podUrl, webId, clientId: cc.id, clientSecret: cc.secret };
    put('kv', rec);
    return { webId, podUrl };
  },

  /** Write a private resource (path relative to the user's pod / private area). Returns its URL. */
  async write(userId: string, relPath: string, body: string, contentType = 'text/turtle'): Promise<{ kind: 'solid' | 'local'; url: string }> {
    const rec = get<PodRecord>('kv', `pod:${userId}`);
    if (this.enabled && rec) {
      try {
        const s = await sessionFor({ ...rec, id: userId });
        const url = `${rec.podUrl}concord/${relPath}`;
        const res = await s.fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body });
        if (!res.ok) throw new Error(`PUT ${url} → ${res.status}`);
        return { kind: 'solid', url };
      } catch (err) {
        console.warn(`[solid] write failed for ${userId}, storing locally: ${(err as Error).message}`);
      }
    }
    const file = path.join(config.dataDir, 'private', userId, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return { kind: 'local', url: `${config.publicUrl}/people/${userId}/private/${relPath}` };
  },

  async read(userId: string, relPath: string): Promise<string | undefined> {
    const rec = get<PodRecord>('kv', `pod:${userId}`);
    if (this.enabled && rec) {
      try {
        const s = await sessionFor({ ...rec, id: userId });
        const res = await s.fetch(`${rec.podUrl}concord/${relPath}`);
        if (res.ok) return await res.text();
      } catch {
        /* fall through to local */
      }
    }
    const file = path.join(config.dataDir, 'private', userId, relPath);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  },

  /** Pods this server provisioned (user id and pod URL; never the credentials). */
  pods(): { userId: string; podUrl: string; webId: string }[] {
    return list<PodRecord>('kv')
      .filter((r) => typeof r.id === 'string' && r.id.startsWith('pod:') && typeof r.podUrl === 'string')
      .map((r) => ({ userId: r.id.slice(4), podUrl: r.podUrl, webId: r.webId }));
  },

  /** URL of a folder (relative path ending in /) in a user's pod, when it lives on the Solid server. */
  folderUrl(userId: string, relFolder: string): string | undefined {
    const rec = get<PodRecord>('kv', `pod:${userId}`);
    return this.enabled && rec ? `${rec.podUrl}concord/${relFolder}` : undefined;
  },

  /**
   * Give `readers` (WebIDs) read-only access to a folder in a user's pod and
   * everything in it, alongside the pod owner's full control. Writes the folder's
   * access control resource: a WAC .acl, or an ACP .acr if the server uses ACP.
   * Rewritten whole each time, so a WebID taken off the list loses access.
   * Skips the write when the folder is already shared with exactly these readers.
   */
  async shareRead(userId: string, relFolder: string, readers: string[], opts: { create?: boolean; force?: boolean } = {}): Promise<'shared' | 'unchanged' | 'missing' | 'local'> {
    const rec = get<PodRecord>('kv', `pod:${userId}`);
    if (!this.enabled || !rec) return 'local';
    const want = [...new Set(readers)].sort();
    const key = `share:${userId}:${relFolder}`;
    const prev = get<Kv<string[]>>('kv', key);
    if (!opts.force && prev && JSON.stringify(prev.value) === JSON.stringify(want)) return 'unchanged';
    const s = await sessionFor({ ...rec, id: userId });
    const folder = `${rec.podUrl}concord/${relFolder}`;
    let head = await s.fetch(folder, { method: 'HEAD' });
    if (head.status === 404) {
      if (!opts.create) return 'missing';
      const made = await s.fetch(folder, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '' });
      if (!made.ok) throw new Error(`PUT ${folder} → ${made.status}`);
      head = await s.fetch(folder, { method: 'HEAD' });
    }
    if (!head.ok) throw new Error(`HEAD ${folder} → ${head.status}`);
    const { acl, acp } = aclOf(head.headers.get('link'), folder);
    // Change only Concord's own sharing rule: whatever else the folder's access control says stays.
    const existing = await readRdf(s.fetch.bind(s), acl);
    let body: string;
    if (acp) body = await acpMerge(folder, acl, existing ?? [], want);
    else {
      // No ACL of its own yet: it inherits one. Writing one stops the inheritance, so carry the inherited rules over.
      const inherited = existing ? undefined : await inheritedAcl(s.fetch.bind(s), folder, rec.podUrl);
      body = await wacMerge(folder, acl, existing, inherited, rec.webId, want);
    }
    const res = await s.fetch(acl, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body });
    if (!res.ok) throw new Error(`PUT ${acl} → ${res.status}`);
    put('kv', { id: key, value: want });
    return 'shared';
  },

  /** A minimal WebID profile document for locally-hosted WebIDs. */
  profileDocument(user: User): string {
    const me = this.localWebId(user.id);
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix schema: <http://schema.org/> .

<> a foaf:PersonalProfileDocument ; foaf:primaryTopic <${me}> .
<${me}> a foaf:Person, schema:Person ;
  foaf:name "${esc(user.name)}" ;
  solid:oidcIssuer <${config.publicUrl}/> ${user.organisation ? `;\n  schema:affiliation [ a schema:Organization ; schema:name "${esc(user.organisation)}" ]` : ''} .
`;
  },
};

/** Parse an HTTP Link header into absolute URLs and their rel values. */
export function parseLinks(header: string | null, base: string): { url: string; rel: string }[] {
  if (!header) return [];
  const out: { url: string; rel: string }[] = [];
  for (const m of header.matchAll(/<([^>]*)>\s*((?:;\s*[^;,]+)*)/g)) {
    const rels = m[2]?.match(/rel\s*=\s*"?([^";,]+)"?/i)?.[1]?.trim().split(/\s+/) ?? [];
    let url: string;
    try {
      url = new URL(m[1]!, base).href;
    } catch {
      continue;
    }
    for (const rel of rels) out.push({ url, rel });
  }
  return out;
}

const ACL = 'http://www.w3.org/ns/auth/acl#';
const ACP = 'http://www.w3.org/ns/solid/acp#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const { namedNode: nn, quad: q } = DataFactory;

/** The ACL resource a Link header points to, and whether it is ACP (.acr) rather than WAC. */
function aclOf(link: string | null, resource: string) {
  const links = parseLinks(link, resource);
  const acl = links.find((l) => l.rel === 'acl')?.url;
  if (!acl) throw new Error(`${resource} has no access control resource (Link rel="acl")`);
  const acp = acl.endsWith('.acr') || links.some((l) => l.rel === 'type' && l.url === `${ACP}AccessControlResource`);
  return { acl, acp };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** GET an RDF document; undefined when it doesn't exist. */
async function readRdf(fetchFn: Fetch, url: string): Promise<Quad[] | undefined> {
  const r = await fetchFn(url, { headers: { accept: 'text/turtle' } });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return new Parser({ baseIRI: url, format: 'text/turtle' }).parse(await r.text());
}

/** The nearest ancestor's ACL (the one a folder without its own inherits), up to the pod root. */
async function inheritedAcl(fetchFn: Fetch, folder: string, podUrl: string): Promise<{ container: string; quads: Quad[] } | undefined> {
  let container = new URL('..', folder).href;
  while (container.startsWith(podUrl)) {
    const head = await fetchFn(container, { method: 'HEAD' });
    if (head.ok) {
      const quads = await readRdf(fetchFn, aclOf(head.headers.get('link'), container).acl);
      if (quads) return { container, quads };
    }
    if (container === podUrl) break;
    container = new URL('..', container).href;
  }
  return undefined;
}

const usable = (u: string) => {
  // Only absolute http(s) IRIs go into an access control document.
  const url = new URL(u);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Not a usable IRI: ${u}`);
  return nn(url.href);
};

function serialise(quads: Quad[], prefixes: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = new Writer({ prefixes });
    w.addQuads(quads);
    w.end((err, out) => (err ? reject(err) : resolve(out)));
  });
}

/**
 * WAC: the folder's ACL with Concord's sharing rule (<#concord-admins>: readers
 * may read the folder and everything in it) set to `readers`, and nothing else
 * changed. A folder without its own ACL starts from the rules it inherited
 * (those with acl:default), re-pointed at the folder. The pod owner always keeps
 * Read, Write and Control.
 */
export async function wacMerge(folder: string, aclUrl: string, existing: Quad[] | undefined, inherited: { container: string; quads: Quad[] } | undefined, owner: string, readers: string[]): Promise<string> {
  const ours = nn(`${aclUrl}#concord-admins`);
  const f = usable(folder);
  let quads: Quad[] = [];
  if (existing) quads = existing.filter((x) => !x.subject.equals(ours));
  else if (inherited) {
    const inheritedAuths = inherited.quads.filter((x) => x.predicate.value === `${ACL}default` && x.object.value === inherited.container).map((x) => x.subject);
    inheritedAuths.forEach((auth, i) => {
      const copy = nn(`${aclUrl}#inherited-${i + 1}`);
      for (const x of inherited.quads.filter((y) => y.subject.equals(auth) && y.predicate.value !== `${ACL}accessTo` && y.predicate.value !== `${ACL}default`)) quads.push(q(copy, x.predicate, x.object));
      quads.push(q(copy, nn(`${ACL}accessTo`), f), q(copy, nn(`${ACL}default`), f));
    });
  }
  const o = usable(owner);
  const ownerControls = quads.some(
    (x) =>
      x.predicate.value === `${ACL}agent` &&
      x.object.equals(o) &&
      quads.some((y) => y.subject.equals(x.subject) && y.predicate.value === `${ACL}mode` && y.object.value === `${ACL}Control`) &&
      quads.some((y) => y.subject.equals(x.subject) && y.predicate.value === `${ACL}accessTo` && y.object.equals(f)),
  );
  if (!ownerControls) {
    const me = nn(`${aclUrl}#concord-owner`);
    quads = quads.filter((x) => !x.subject.equals(me));
    quads.push(q(me, nn(RDF_TYPE), nn(`${ACL}Authorization`)), q(me, nn(`${ACL}agent`), o), q(me, nn(`${ACL}accessTo`), f), q(me, nn(`${ACL}default`), f));
    for (const m of ['Read', 'Write', 'Control']) quads.push(q(me, nn(`${ACL}mode`), nn(`${ACL}${m}`)));
  }
  if (readers.length) {
    quads.push(q(ours, nn(RDF_TYPE), nn(`${ACL}Authorization`)), q(ours, nn(`${ACL}accessTo`), f), q(ours, nn(`${ACL}default`), f), q(ours, nn(`${ACL}mode`), nn(`${ACL}Read`)));
    for (const r of readers) quads.push(q(ours, nn(`${ACL}agent`), usable(r)));
  }
  return serialise(quads, { acl: ACL });
}

/**
 * ACP: the folder's ACR with Concord's own access control (read for `readers`,
 * on the folder and its members) set, and nothing else changed. ACP adds up
 * policies, so the owner's inherited access is untouched.
 */
export async function acpMerge(folder: string, acrUrl: string, existing: Quad[], readers: string[]): Promise<string> {
  const ac = nn(`${acrUrl}#concord-admins-access`);
  const policy = nn(`${acrUrl}#concord-admins-policy`);
  const matcher = nn(`${acrUrl}#concord-admins-matcher`);
  const managed = [ac, policy, matcher];
  let quads = existing.filter((x) => !managed.some((m) => x.subject.equals(m) || x.object.equals(m)));
  if (readers.length) {
    const acr = quads.find((x) => x.predicate.value === RDF_TYPE && x.object.value === `${ACP}AccessControlResource`)?.subject ?? nn(acrUrl);
    if (!quads.some((x) => x.subject.equals(acr) && x.predicate.value === RDF_TYPE)) quads.push(q(acr as never, nn(RDF_TYPE), nn(`${ACP}AccessControlResource`)));
    if (!quads.some((x) => x.subject.equals(acr) && x.predicate.value === `${ACP}resource`)) quads.push(q(acr as never, nn(`${ACP}resource`), usable(folder)));
    quads = [
      ...quads,
      q(acr as never, nn(`${ACP}accessControl`), ac),
      q(acr as never, nn(`${ACP}memberAccessControl`), ac),
      q(ac, nn(RDF_TYPE), nn(`${ACP}AccessControl`)),
      q(ac, nn(`${ACP}apply`), policy),
      q(policy, nn(RDF_TYPE), nn(`${ACP}Policy`)),
      q(policy, nn(`${ACP}allow`), nn(`${ACL}Read`)),
      q(policy, nn(`${ACP}anyOf`), matcher),
      q(matcher, nn(RDF_TYPE), nn(`${ACP}Matcher`)),
      ...readers.map((r) => q(matcher, nn(`${ACP}agent`), usable(r))),
    ];
  }
  return serialise(quads, { acp: ACP, acl: ACL });
}

/** Serialise an interview transcript as Turtle (schema.org Conversation) for the pod. */
export function transcriptToTurtle(sessionId: string, title: string, messages: { role: string; content: string; at: string }[]): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  const lines = messages
    .filter((m) => m.role !== 'system')
    .map(
      (m, i) => `<#m${i}> a schema:Message ;
  schema:sender "${m.role === 'assistant' ? 'Concord interviewer' : 'me'}" ;
  schema:dateCreated "${m.at}"^^xsd:dateTime ;
  schema:position ${i} ;
  schema:text """${esc(m.content)}""" .`,
    );
  return `@prefix schema: <http://schema.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<> a schema:Conversation ;
  schema:name "${title.replace(/"/g, '\\"')}" ;
  schema:identifier "${sessionId}" ;
  schema:hasPart ${messages.filter((m) => m.role !== 'system').map((_, i) => `<#m${i}>`).join(', ') || '<#none>'} .

${lines.join('\n\n')}
`;
}
