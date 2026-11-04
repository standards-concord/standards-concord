import fs from 'node:fs';
import path from 'node:path';
import type { User } from '@concord/shared';
import { config } from '../config.js';
import { get, list, put } from '../db.js';
import { DataFactory, Parser, Writer, type Quad } from 'n3';
import { slugify } from '../ids.js';
import { clientCredentialsLogin, podFetch, podRequester, type PodRequest, type SolidLogin } from '../solidOidc.js';

/**
 * Private data lives in each person's Solid pod. People never see this:
 * on first sign-in the platform silently provisions a pod and WebID on a
 * Community Solid Server (v7 JSON account API) under one platform-owned
 * account, mints client credentials bound to that WebID, and from then on
 * reads and writes that person's private resources as them.
 *
 * Every request to the Solid server goes through `podFetch` (solidOidc.ts):
 * this server's origin only, no redirects, capped size and time. The plain
 * `fetch` is never used here (a test checks).
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
  if (!r.ok) throw new Error(`Solid server account API → ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return r.json();
};

async function platformAccountToken(base: string): Promise<string> {
  const saved = get<Kv<string>>('kv', 'solid-account-token');
  if (saved) {
    // Check it still works; CSS account tokens expire with the cookie lifetime.
    const r = await podFetch(`${base}/.account/`, { headers: { authorization: `CSS-Account-Token ${saved.value}` } });
    const body = await r.json().catch(() => undefined);
    if (body?.controls?.account?.pod) return saved.value;
  }
  // Create a platform account with a password so we can log back in.
  const creds = get<Kv<{ email: string; password: string }>>('kv', 'solid-account-login');
  let { controls } = await json(await podFetch(`${base}/.account/`));
  let authorization: string;
  if (creds) {
    ({ authorization } = await json(
      await podFetch(controls.password.login, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: creds.value.email, password: creds.value.password }),
      }),
    ));
  } else {
    ({ authorization } = await json(await podFetch(controls.account.create, { method: 'POST' })));
    const login = { email: `platform@${new URL(config.publicUrl).hostname || 'concord.local'}`, password: crypto.randomUUID() };
    ({ controls } = await json(await podFetch(`${base}/.account/`, { headers: { authorization: `CSS-Account-Token ${authorization}` } })));
    await json(
      await podFetch(controls.password.create, {
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

const owners = new Map<string, SolidLogin>();

/** Requests that act as the pod's owner (client credentials, DPoP), through podFetch. */
async function ownerRequest(rec: PodRecord): Promise<PodRequest> {
  const known = owners.get(rec.id);
  const req = known && (await podRequester(known));
  if (req) return req;
  const login = await clientCredentialsLogin(rec.webId, rec.clientId, rec.clientSecret);
  owners.set(rec.id, login);
  return (await podRequester(login))!;
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
    const { controls } = await json(await podFetch(`${base}/.account/`, { headers: { authorization: headers.authorization } }));
    const name = `${slugify(user.name).slice(0, 24)}-${user.id.slice(-6)}`.toLowerCase();
    const pod = await json(await podFetch(controls.account.pod, { method: 'POST', headers, body: JSON.stringify({ name }) }));
    const podUrl: string = pod.pod ?? `${base}/${name}/`;
    const webId: string = pod.webId ?? `${podUrl}profile/card#me`;
    const cc = await json(
      await podFetch(controls.account.clientCredentials, { method: 'POST', headers, body: JSON.stringify({ name: `concord-${user.id}`, webId }) }),
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
        const req = await ownerRequest({ ...rec, id: userId });
        const url = `${rec.podUrl}concord/${relPath}`;
        const res = await req('PUT', url, { headers: { 'content-type': contentType }, body });
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
        const req = await ownerRequest({ ...rec, id: userId });
        const res = await req('GET', `${rec.podUrl}concord/${relPath}`);
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
   * everything in it, alongside the pod owner's full control (see shareFolder).
   * A WebID taken off the list loses access the next time this runs. Skips the
   * work when the folder is already shared with exactly these readers.
   */
  async shareRead(userId: string, relFolder: string, readers: string[], opts: { create?: boolean; force?: boolean } = {}): Promise<'shared' | 'unchanged' | 'missing' | 'local'> {
    const rec = get<PodRecord>('kv', `pod:${userId}`);
    if (!this.enabled || !rec) return 'local';
    const want = [...new Set(readers)].sort();
    const key = `share:${userId}:${relFolder}`;
    const prev = get<Kv<string[]>>('kv', key);
    if (!opts.force && prev && JSON.stringify(prev.value) === JSON.stringify(want)) return 'unchanged';
    const req = await ownerRequest({ ...rec, id: userId });
    const r = await shareFolder(req, `${rec.podUrl}concord/${relFolder}`, rec.podUrl, rec.webId, want, { create: opts.create });
    if (r === 'shared') put('kv', { id: key, value: want });
    return r;
  },

  /**
   * If something is already at `relPath` (in the pod, or this server's private
   * files when there is no pod), keep a verbatim copy beside it
   * (`<name>.previous-<time><ext>`) before it is written over. Throws if the pod
   * can't say, so the caller writes nothing.
   */
  async keepExisting(userId: string, relPath: string): Promise<void> {
    const rec = get<PodRecord>('kv', `pod:${userId}`);
    const aside = relPath.replace(/(\.[^./]+)?$/, (ext) => `.previous-${Date.now()}${ext}`);
    if (this.enabled && rec) {
      const req = await ownerRequest({ ...rec, id: userId });
      const url = `${rec.podUrl}concord/${relPath}`;
      const res = await req('GET', url);
      if (res.status === 404 || res.status === 410) return;
      if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
      const type = res.headers.get('content-type') ?? 'application/octet-stream';
      await this.writeExisting(userId, aside, await res.text(), type);
      return;
    }
    const file = path.join(config.dataDir, 'private', userId, relPath);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(config.dataDir, 'private', userId, aside));
  },

  /**
   * Like `write`, but when the user has a pod the write must reach it: no quiet
   * fallback to this server, which later reads of the pod wouldn't see. Throws
   * if the pod refuses or can't be reached.
   */
  async writeExisting(userId: string, relPath: string, body: string, contentType = 'text/turtle'): Promise<{ kind: 'solid' | 'local'; url: string }> {
    const rec = get<PodRecord>('kv', `pod:${userId}`);
    if (!(this.enabled && rec)) return this.write(userId, relPath, body, contentType);
    const req = await ownerRequest({ ...rec, id: userId });
    const url = `${rec.podUrl}concord/${relPath}`;
    const res = await req('PUT', url, { headers: { 'content-type': contentType }, body });
    if (!res.ok) throw new Error(`PUT ${url} → ${res.status}`);
    return { kind: 'solid', url };
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

/** The access control resource a Link header points to, and whether it is ACP (.acr) rather than WAC. */
function aclOf(link: string | null, resource: string) {
  const links = parseLinks(link, resource);
  const acl = links.find((l) => l.rel === 'acl')?.url;
  if (!acl) throw new Error(`${resource} has no access control resource (Link rel="acl")`);
  const acp = acl.endsWith('.acr') || links.some((l) => l.rel === 'type' && l.url === `${ACP}AccessControlResource`);
  return { acl, acp };
}

const acpRefusal = (resource: string) => new Error(`${resource} is on a pod that uses ACP access control. Concord only shares folders on WAC pods, so nothing was changed.`);

/**
 * GET an access control document and its ETag; undefined when it doesn't exist.
 * Any other answer than 200 or 404 is an error. An ACP server marks its access
 * control resources on their own responses (Link rel="type" acp:AccessControlResource),
 * whatever their URL looks like, so that, and an ACR's own type in the body, refuse.
 */
async function readAcl(req: PodRequest, url: string, resource: string): Promise<{ quads: Quad[]; etag: string } | undefined> {
  const r = await req('GET', url, { headers: { accept: 'text/turtle' } });
  if (parseLinks(r.headers.get('link'), url).some((l) => l.rel === 'type' && l.url === `${ACP}AccessControlResource`)) throw acpRefusal(resource);
  if (r.status === 404) return undefined;
  if (r.status !== 200) throw new Error(`GET ${url} → ${r.status}`);
  const etag = r.headers.get('etag');
  if (!etag) throw new Error(`${url} has no ETag, so it can’t be changed safely`);
  const quads = new Parser({ baseIRI: url, format: 'text/turtle' }).parse(await r.text());
  if (quads.some((x) => x.predicate.value === RDF_TYPE && x.object.value === `${ACP}AccessControlResource`)) throw acpRefusal(resource);
  return { quads, etag };
}

/**
 * The nearest ancestor's ACL (the one a folder without its own inherits), up to
 * the pod root. Never guesses: an ancestor that answers anything but 200 or 404
 * stops it, since a nearer ACL could be hiding behind the error.
 */
async function inheritedAcl(req: PodRequest, folder: string, podUrl: string): Promise<{ container: string; quads: Quad[] }> {
  let container = new URL('..', folder).href;
  while (container.startsWith(podUrl)) {
    const head = await req('HEAD', container);
    if (head.status === 200) {
      const { acl, acp } = aclOf(head.headers.get('link'), container);
      if (acp) throw acpRefusal(folder);
      const found = await readAcl(req, acl, folder);
      if (found) return { container, quads: found.quads };
    } else if (head.status !== 404) throw new Error(`Couldn’t tell what ${folder} inherits: ${container} answered ${head.status}. Nothing was changed.`);
    if (container === podUrl) break;
    container = new URL('..', container).href;
  }
  throw new Error(`Couldn’t find the access control ${folder} inherits. Nothing was changed.`);
}

/**
 * Share `folder` read-only with `readers` by changing only Concord's own rule in
 * its WAC ACL (see wacMerge). The write is conditional on what was read (If-Match
 * its ETag, or If-None-Match: * when the ACL is new), so a concurrent change is
 * never overwritten: a conflict is retried once from a fresh read, then reported.
 * Pods using ACP are refused without changing anything.
 */
export async function shareFolder(req: PodRequest, folder: string, podUrl: string, owner: string, readers: string[], opts: { create?: boolean } = {}): Promise<'shared' | 'missing'> {
  let head = await req('HEAD', folder);
  if (head.status === 404) {
    if (!opts.create) return 'missing';
    const made = await req('PUT', folder, { headers: { 'content-type': 'text/turtle', 'if-none-match': '*' }, body: '' });
    if (!made.ok && made.status !== 412) throw new Error(`PUT ${folder} → ${made.status}`);
    head = await req('HEAD', folder);
  }
  if (head.status !== 200) throw new Error(`HEAD ${folder} → ${head.status}`);
  const { acl, acp } = aclOf(head.headers.get('link'), folder);
  if (acp) throw acpRefusal(folder);
  for (let attempt = 1; ; attempt++) {
    const existing = await readAcl(req, acl, folder);
    // No ACL of its own yet: it inherits one. Writing one stops the inheritance, so carry the inherited rules over.
    const inherited = existing ? undefined : await inheritedAcl(req, folder, podUrl);
    const body = await wacMerge(folder, acl, existing?.quads, inherited, owner, readers);
    const condition: Record<string, string> = existing ? { 'if-match': existing.etag } : { 'if-none-match': '*' };
    const res = await req('PUT', acl, { headers: { 'content-type': 'text/turtle', ...condition }, body });
    if (res.status === 412 && attempt === 1) continue;
    if (res.status === 412) throw new Error(`${acl} changed while Concord was updating it, twice. Nothing was written.`);
    if (!res.ok) throw new Error(`PUT ${acl} → ${res.status}`);
    return 'shared';
  }
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
