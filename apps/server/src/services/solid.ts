import type { User } from '@concord/shared';
import { config } from '../config.js';
import { get, HttpError, list, put, refuseWhenReadOnly } from '../db.js';
import { DataFactory, Parser, Writer, type Quad } from 'n3';
import { slugify } from '../ids.js';
import { localTag, PreconditionFailed, privateStore, type WriteCondition } from './privateStore.js';
import { clientCredentialsLogin, podFetch, podRequester, type PodRequest, type SolidLogin } from '../solidOidc.js';
import { concordFolder, ownPodOf, ownPods, OwnPodUnavailable, type OwnPod } from './ownPods.js';

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
 * Without a Solid server configured, the same API falls back to this server's private store (files on the VM,
 * database rows on Vercel: privateStore.ts),
 * and the WebID is a profile document served by this platform.
 *
 * People who sign in with Solid, where this server keeps their data in their own pod (config.solidOwnPods, step 5e),
 * are written to as themselves, in Concord's folder in that pod (ownPods.ts). That folder is made private to them
 * before the first write, and a write that fails is reported, never kept here instead.
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
  const saved = await get<Kv<string>>('kv', 'solid-account-token');
  if (saved) {
    // Check it still works; CSS account tokens expire with the cookie lifetime.
    const r = await podFetch(`${base}/.account/`, { headers: { authorization: `CSS-Account-Token ${saved.value}` } });
    const body = await r.json().catch(() => undefined);
    if (body?.controls?.account?.pod) return saved.value;
  }
  // Create a platform account with a password so we can log back in.
  const creds = await get<Kv<{ email: string; password: string }>>('kv', 'solid-account-login');
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
    await put('kv', { id: 'solid-account-login', value: login });
  }
  await put('kv', { id: 'solid-account-token', value: authorization });
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

/** Where a person's private data goes when it goes to a pod: Concord's folder in it, and requests as its owner. */
interface PodAccess {
  pod: string;
  webId: string;
  /** Concord's folder in the pod. */
  base: string;
  request(): Promise<PodRequest>;
  own?: OwnPod;
}

/**
 * The URL of a path inside Concord's folder. Only plain relative paths: no `.` or `..` segments (nor encoded ones),
 * no leading slash, query or fragment, so nothing Concord writes can land outside the folder it made private.
 */
export function urlIn(base: string, relPath: string): string {
  const segments = relPath.split('/');
  const bad =
    !relPath ||
    relPath.startsWith('/') ||
    /[\\?#]/.test(relPath) ||
    /%(2e|2f|5c)/i.test(relPath) ||
    segments.some((seg, i) => seg === '.' || seg === '..' || (seg === '' && i < segments.length - 1));
  const url = bad ? undefined : new URL(relPath, base).href;
  if (!url || !url.startsWith(base) || url === base) throw new HttpError(400, `Not a path inside Concord’s folder: ${relPath}`);
  return url;
}

/**
 * The pod a person's private data goes to, if any: their own (a Solid account, where own pods are used; throws when
 * Concord can't write to it now) or the one this server provisioned for them on its Solid server.
 */
async function podAccess(userId: string): Promise<PodAccess | undefined> {
  const own = await ownPodOf(userId);
  if (own) return { pod: own.pod, webId: own.webId, base: concordFolder(own.pod), own, request: () => own.request() };
  if (!config.solid.serverUrl) return undefined;
  const rec = await get<PodRecord>('kv', `pod:${userId}`);
  return rec ? { pod: rec.podUrl, webId: rec.webId, base: `${rec.podUrl}concord/`, request: () => ownerRequest({ ...rec, id: userId }) } : undefined;
}

/** A failed write to someone's own pod, as the person sees it (the sign-in and configuration messages pass through). */
const ownPodFailed = (err: unknown, verb = 'save to') =>
  err instanceof HttpError || err instanceof PreconditionFailed ? err : new HttpError(502, `Couldn’t ${verb} your pod: ${(err as Error).message}`.slice(0, 300));

/** A precondition for `writeExisting`: replace only this version (ETag), or only create (`*`). */
export { PreconditionFailed, type WriteCondition } from './privateStore.js';

export const solid = {
  get enabled() {
    return !!config.solid.serverUrl;
  },

  localWebId(userId: string) {
    return `${config.publicUrl}/people/${userId}#me`;
  },

  /** Provision a pod + WebID for a user. Idempotent. Returns {webId, podUrl}. */
  async provision(user: Pick<User, 'id' | 'name'>): Promise<{ webId: string; podUrl?: string }> {
    refuseWhenReadOnly(); // a pod or a private file, written before any database write
    if (!this.enabled) return { webId: this.localWebId(user.id), podUrl: `${config.publicUrl}/people/${user.id}/` };
    const existing = await get<PodRecord>('kv', `pod:${user.id}`);
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
    await put('kv', rec);
    return { webId, podUrl };
  },

  /** Write a private resource (path relative to the user's pod / private area). Returns its URL. */
  async write(userId: string, relPath: string, body: string | Buffer, contentType = 'text/turtle'): Promise<{ kind: 'solid' | 'local'; url: string }> {
    refuseWhenReadOnly(); // a pod or a private file, written before any database write
    const access = await podAccess(userId);
    if (access) {
      try {
        const req = await access.request();
        const url = urlIn(access.base, relPath);
        if (access.own) await privateTarget(req, access.base, url, access.webId);
        const res = await req('PUT', url, { headers: { 'content-type': contentType }, body: typeof body === 'string' ? body : new Uint8Array(body) });
        if (!res.ok) throw new Error(`PUT ${url} → ${res.status}`);
        return { kind: 'solid', url };
      } catch (err) {
        // Their own pod, or no lasting disk (Vercel): there is nowhere quiet to put it, so the person is told it failed.
        if (access.own) throw ownPodFailed(err);
        if (config.privateStore === 'db') throw err;
        console.warn(`[solid] write failed for ${userId}, storing locally: ${(err as Error).message}`);
      }
    }
    await privateStore().write(userId, relPath, typeof body === 'string' ? Buffer.from(body) : body);
    return { kind: 'local', url: `${config.publicUrl}/people/${userId}/private/${relPath}` };
  },

  async read(userId: string, relPath: string): Promise<string | undefined> {
    const access = await podAccess(userId);
    // Their own pod is the only place their data is: a failure is reported, and only a missing document is missing.
    if (access?.own) {
      try {
        const req = await access.request();
        const url = urlIn(access.base, relPath);
        const res = await req('GET', url);
        if (res.status === 404 || res.status === 410) return undefined;
        if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
        return await res.text();
      } catch (err) {
        throw ownPodFailed(err, 'read from');
      }
    }
    if (access) {
      try {
        const req = await access.request();
        const res = await req('GET', urlIn(access.base, relPath));
        if (res.ok) return await res.text();
      } catch {
        /* fall through to local */
      }
    }
    return (await privateStore().read(userId, relPath))?.toString('utf8');
  },

  /** Pods this server provisioned (user id and pod URL; never the credentials). */
  async pods(): Promise<{ userId: string; podUrl: string; webId: string }[]> {
    // People's own pods first: where both exist (a Solid account from before own pods), theirs is where data goes now.
    const own = await ownPods();
    const provisioned = (await list<PodRecord>('kv'))
      .filter((r) => typeof r.id === 'string' && r.id.startsWith('pod:') && typeof r.podUrl === 'string')
      .map((r) => ({ userId: r.id.slice(4), podUrl: r.podUrl, webId: r.webId }));
    return [...own, ...provisioned.filter((p) => !own.some((o) => o.userId === p.userId))];
  },

  /** URL of a folder (relative path ending in /) in a user's pod, when it lives on the Solid server. */
  async folderUrl(userId: string, relFolder: string): Promise<string | undefined> {
    const access = await podAccess(userId).catch(() => undefined);
    return access && urlIn(access.base, relFolder);
  },

  /**
   * Give `readers` (WebIDs) read-only access to a folder in a user's pod and
   * everything in it, alongside the pod owner's full control (see shareFolder).
   * A WebID taken off the list loses access the next time this runs. Skips the
   * work when the folder is already shared with exactly these readers.
   */
  async shareRead(userId: string, relFolder: string, readers: string[], opts: { create?: boolean; force?: boolean } = {}): Promise<'shared' | 'unchanged' | 'missing' | 'local'> {
    refuseWhenReadOnly(); // a pod or a private file, written before any database write
    const access = await podAccess(userId);
    if (!access) return 'local';
    const want = [...new Set(readers)].sort();
    // Per pod: a Solid account that moves to another pod shares the folder there afresh.
    const key = `share:${userId}:${relFolder}`;
    const prev = await get<Kv<string[]> & { pod?: string }>('kv', key);
    if (!opts.force && prev && (prev.pod ?? access.pod) === access.pod && JSON.stringify(prev.value) === JSON.stringify(want)) return 'unchanged';
    const req = await access.request();
    // In their own pod, Concord's folder is made private first: a folder shared below it starts from its rules.
    if (access.own) await makePrivate(req, access.base, access.webId);
    const r = await shareFolder(req, urlIn(access.base, relFolder), access.pod, access.webId, want, { create: opts.create });
    if (r === 'shared') await put('kv', { id: key, value: want, pod: access.pod });
    return r;
  },

  /**
   * If something is already at `relPath` (in the pod, or this server's private
   * files when there is no pod), keep a byte-for-byte copy beside it under a new
   * name (`<name>.previous-<time>-<n><ext>`, never replacing another file).
   * Returns the precondition the caller's write must carry so it only replaces
   * exactly what was kept (or, if nothing was there, only creates). Throws if the
   * pod can't say, so the caller writes nothing.
   */
  async keepExisting(userId: string, relPath: string, opts: { ours?: (bytes: Buffer) => boolean } = {}): Promise<WriteCondition & { existing?: Buffer }> {
    refuseWhenReadOnly(); // a pod or a private file, written before any database write
    const access = await podAccess(userId);
    const asideName = (n: number) => relPath.replace(/(\.[^./]+)?$/, (ext) => `.previous-${Date.now()}-${n}${ext}`);
    if (access) {
      const req = await access.request();
      const url = urlIn(access.base, relPath);
      const res = await req('GET', url);
      if (res.status === 404 || res.status === 410) return { ifNoneMatch: '*' };
      if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
      const etag = res.headers.get('etag');
      if (!etag) throw new Error(`GET ${url} gave no ETag, so it can't be replaced safely`);
      const type = res.headers.get('content-type') ?? 'application/octet-stream';
      const bytes = await res.arrayBuffer();
      // Concord's own document (`ours`) isn't kept aside: the caller decides from it, and replaces exactly it.
      if (opts.ours?.(Buffer.from(bytes))) return { ifMatch: etag, existing: Buffer.from(bytes) };
      for (let n = 0; ; n++) {
        if (n >= 5) throw new Error(`could not find a free name to keep ${url}`);
        try {
          await this.writeExisting(userId, asideName(n), bytes, type, { ifNoneMatch: '*' });
          break;
        } catch (err) {
          if (!(err instanceof PreconditionFailed)) throw err;
        }
      }
      return { ifMatch: etag };
    }
    // Locally the "ETag" is a hash of the stored bytes, and the copy is made from those same bytes.
    const store = privateStore();
    const bytes = await store.read(userId, relPath);
    if (!bytes) return { ifNoneMatch: '*' };
    if (opts.ours?.(bytes)) return { ifMatch: localTag(bytes), existing: bytes };
    for (let n = 0; ; n++) {
      if (n >= 5) throw new Error(`could not find a free name to keep ${relPath}`);
      if (await store.createCopy(userId, asideName(n), bytes, relPath)) return { ifMatch: localTag(bytes) };
    }
  },

  /** What is at a private path now, and the tag that replaces exactly that (the pod's ETag; locally a hash). */
  async readTagged(userId: string, relPath: string): Promise<{ bytes?: Buffer; tag?: string }> {
    const access = await podAccess(userId);
    if (access) {
      const req = await access.request();
      const url = urlIn(access.base, relPath);
      const res = await req('GET', url);
      if (res.status === 404 || res.status === 410) return {};
      if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
      const etag = res.headers.get('etag');
      if (!etag) throw new Error(`GET ${url} gave no ETag, so it can't be replaced safely`);
      return { bytes: Buffer.from(await res.arrayBuffer()), tag: etag };
    }
    const bytes = await privateStore().read(userId, relPath);
    return bytes ? { bytes, tag: localTag(bytes) } : {};
  },

  /**
   * Like `write`, but when the user has a pod the write must reach it: no quiet
   * fallback to this server, which later reads of the pod wouldn't see. Throws
   * if the pod refuses or can't be reached (`PreconditionFailed` when `when`
   * doesn't hold: the resource changed, or already exists).
   */
  async writeExisting(userId: string, relPath: string, body: string | ArrayBuffer, contentType = 'text/turtle', when: WriteCondition = {}): Promise<{ kind: 'solid' | 'local'; url: string }> {
    refuseWhenReadOnly(); // a pod or a private file, written before any database write
    const access = await podAccess(userId);
    if (!access) {
      const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
      if (!when.ifMatch && !when.ifNoneMatch) return this.write(userId, relPath, bytes, contentType);
      await privateStore().writeIf(userId, relPath, bytes, when);
      return { kind: 'local', url: `${config.publicUrl}/people/${userId}/private/${relPath}` };
    }
    if (access.own) {
      try {
        return await this.writeTo(access, relPath, body, contentType, when);
      } catch (err) {
        throw ownPodFailed(err);
      }
    }
    return await this.writeTo(access, relPath, body, contentType, when);
  },

  /** writeExisting's PUT to a pod. */
  async writeTo(access: PodAccess, relPath: string, body: string | ArrayBuffer, contentType: string, when: WriteCondition): Promise<{ kind: 'solid'; url: string }> {
    const req = await access.request();
    const url = urlIn(access.base, relPath);
    if (access.own) await privateTarget(req, access.base, url, access.webId);
    const headers: Record<string, string> = { 'content-type': contentType };
    if (when.ifMatch) headers['if-match'] = when.ifMatch;
    if (when.ifNoneMatch) headers['if-none-match'] = when.ifNoneMatch;
    const res = await req('PUT', url, { headers, body });
    if (res.status === 412) throw new PreconditionFailed(`PUT ${url} → 412`);
    if (!res.ok) throw new Error(`PUT ${url} → ${res.status}`);
    return { kind: 'solid', url };
  },

  /** A minimal WebID profile document for locally-hosted WebIDs. */
  /** The WebID profile. The name and organisation are left out unless `named` (the server only names people to signed-in users). */
  profileDocument(user: User, { named = true }: { named?: boolean } = {}): string {
    const me = this.localWebId(user.id);
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix schema: <http://schema.org/> .

<> a foaf:PersonalProfileDocument ; foaf:primaryTopic <${me}> .
<${me}> a foaf:Person, schema:Person ;${named ? `\n  foaf:name "${esc(user.name)}" ;` : ''}
  solid:oidcIssuer <${config.publicUrl}/> ${named && user.organisation ? `;\n  schema:affiliation [ a schema:Organization ; schema:name "${esc(user.organisation)}" ]` : ''} .
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

/**
 * Make Concord's folder in someone's own pod private to them before anything is written in it: an access control of
 * its own that gives the owner Read, Write and Control over it and everything in it (acl:default), and nobody else
 * anything, so nothing is inherited from the pod (whose root may be readable by everyone). A folder that already has
 * an access control, the person's own or one made meanwhile, is checked rather than trusted: anything that lets
 * someone else in, or leaves what is in the folder to rules from above it, is refused with nothing written. Pods
 * using ACP are refused the same way.
 */
export async function makePrivate(req: PodRequest, folder: string, owner: string): Promise<void> {
  let head = await req('HEAD', folder);
  if (head.status === 404) {
    const made = await req('PUT', folder, { headers: { 'content-type': 'text/turtle', 'if-none-match': '*' }, body: '' });
    if (!made.ok && made.status !== 412) throw new Error(`PUT ${folder} → ${made.status}`);
    head = await req('HEAD', folder);
  }
  if (head.status !== 200) throw new Error(`HEAD ${folder} → ${head.status}`);
  const { acl, acp } = aclOf(head.headers.get('link'), folder);
  if (acp) throw acpRefusal(folder);
  let existing = await readAcl(req, acl, folder);
  if (!existing) {
    const res = await req('PUT', acl, { headers: { 'content-type': 'text/turtle', 'if-none-match': '*' }, body: await wacMerge(folder, acl, undefined, undefined, owner, []) });
    if (!res.ok && res.status !== 412) throw new Error(`PUT ${acl} → ${res.status}`);
    // Whatever is there now (Concord's, or one made meanwhile) is what counts, so it is read back and checked.
    existing = await readAcl(req, acl, folder);
    if (!existing) throw new Error(`${acl} wasn’t there after it was written`);
  }
  onlyTheOwner(existing.quads, acl, folder, owner, { folder: true, readers: false });
}

/**
 * Before Concord writes `url` in someone's own pod: Concord's folder is private to them (makePrivate), and no access
 * control between it and `url` (a folder's, or the document's own) lets anyone else in, apart from Concord's own
 * rule that lets the administrators read a shared folder (shareRead).
 */
async function privateTarget(req: PodRequest, base: string, url: string, owner: string): Promise<void> {
  await makePrivate(req, base, owner);
  const rest = url.slice(base.length).split('/');
  for (let i = 0; i < rest.length; i++) {
    const at = base + rest.slice(0, i + 1).join('/') + (i < rest.length - 1 ? '/' : '');
    if (at === base) continue;
    const head = await req('HEAD', at);
    if (head.status === 404 || head.status === 410) return; // not there yet, nor anything below it: it takes the rules above
    if (head.status !== 200) throw new Error(`HEAD ${at} → ${head.status}`);
    const { acl, acp } = aclOf(head.headers.get('link'), at);
    if (acp) throw acpRefusal(at);
    const own = await readAcl(req, acl, at);
    if (own) onlyTheOwner(own.quads, acl, at, owner, { folder: at.endsWith('/'), readers: true });
  }
}

/** Something in someone's own pod isn't private to them, so Concord writes nothing there. */
const notPrivate = (resource: string, why: string) =>
  new OwnPodUnavailable(`Concord didn’t save to your pod: ${resource} ${why}. Make it private to you (or remove its access rules), then try again.`);

/**
 * Checks an access control document gives access to the owner only: every rule names agents (no classes such as
 * everyone or any signed-in agent, and no groups), and only the owner, except Concord's own read-only rule for the
 * administrators where `readers` allows it. For a folder, the owner's rule must also cover what is in it
 * (acl:default), or its documents would take rules from above it.
 */
function onlyTheOwner(quads: Quad[], aclUrl: string, resource: string, owner: string, opts: { folder: boolean; readers: boolean }) {
  const rules = new Set(quads.filter((x) => x.predicate.value.startsWith(ACL) || (x.predicate.value === RDF_TYPE && x.object.value === `${ACL}Authorization`)).map((x) => x.subject.value));
  const of = (rule: string, p: string) => quads.filter((x) => x.subject.value === rule && x.predicate.value === `${ACL}${p}`).map((x) => x.object.value);
  let coversContents = false;
  for (const rule of rules) {
    if (of(rule, 'agentClass').length || of(rule, 'agentGroup').length) throw notPrivate(resource, 'can be opened by others than you');
    const others = of(rule, 'agent').filter((a) => a !== owner);
    const adminsRead = opts.readers && rule === `${aclUrl}#concord-admins` && of(rule, 'mode').every((m) => m === `${ACL}Read`);
    if (others.length && !adminsRead) throw notPrivate(resource, 'can be opened by others than you');
    if (of(rule, 'agent').includes(owner) && of(rule, 'default').includes(resource)) coversContents = true;
  }
  if (opts.folder && !coversContents) throw notPrivate(resource, 'has access rules that don’t cover what is in it');
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
