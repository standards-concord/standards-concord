import fs from 'node:fs';
import path from 'node:path';
import { Session } from '@inrupt/solid-client-authn-node';
import type { User } from '@concord/shared';
import { config } from '../config.js';
import { get, put } from '../db.js';
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

/** A precondition for `writeExisting`: replace only this version (ETag), or only create (`*`). */
export interface WriteCondition {
  ifMatch?: string;
  ifNoneMatch?: '*';
}
export class PreconditionFailed extends Error {}

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
    const { controls } = await json(await fetch(`${base}/.account/`, { headers }));
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
  async write(userId: string, relPath: string, body: string | Buffer, contentType = 'text/turtle'): Promise<{ kind: 'solid' | 'local'; url: string }> {
    const rec = get<PodRecord>('kv', `pod:${userId}`);
    if (this.enabled && rec) {
      try {
        const s = await sessionFor({ ...rec, id: userId });
        const url = `${rec.podUrl}concord/${relPath}`;
        const res = await s.fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body: typeof body === 'string' ? body : new Uint8Array(body) });
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

  /**
   * If something is already at `relPath` (in the pod, or this server's private
   * files when there is no pod), keep a byte-for-byte copy beside it under a new
   * name (`<name>.previous-<time>-<n><ext>`, never replacing another file).
   * Returns the precondition the caller's write must carry so it only replaces
   * exactly what was kept (or, if nothing was there, only creates). Throws if the
   * pod can't say, so the caller writes nothing.
   */
  async keepExisting(userId: string, relPath: string): Promise<WriteCondition> {
    const rec = get<PodRecord>('kv', `pod:${userId}`);
    const asideName = (n: number) => relPath.replace(/(\.[^./]+)?$/, (ext) => `.previous-${Date.now()}-${n}${ext}`);
    if (this.enabled && rec) {
      const s = await sessionFor({ ...rec, id: userId });
      const url = `${rec.podUrl}concord/${relPath}`;
      const res = await s.fetch(url);
      if (res.status === 404 || res.status === 410) return { ifNoneMatch: '*' };
      if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
      const etag = res.headers.get('etag');
      if (!etag) throw new Error(`GET ${url} gave no ETag, so it can't be replaced safely`);
      const type = res.headers.get('content-type') ?? 'application/octet-stream';
      const bytes = await res.arrayBuffer();
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
    const dir = path.join(config.dataDir, 'private', userId);
    const file = path.join(dir, relPath);
    if (!fs.existsSync(file)) return {};
    for (let n = 0; ; n++) {
      if (n >= 5) throw new Error(`could not find a free name to keep ${file}`);
      try {
        fs.copyFileSync(file, path.join(dir, asideName(n)), fs.constants.COPYFILE_EXCL);
        return {};
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  },

  /**
   * Like `write`, but when the user has a pod the write must reach it: no quiet
   * fallback to this server, which later reads of the pod wouldn't see. Throws
   * if the pod refuses or can't be reached (`PreconditionFailed` when `when`
   * doesn't hold: the resource changed, or already exists).
   */
  async writeExisting(userId: string, relPath: string, body: string | ArrayBuffer, contentType = 'text/turtle', when: WriteCondition = {}): Promise<{ kind: 'solid' | 'local'; url: string }> {
    const rec = get<PodRecord>('kv', `pod:${userId}`);
    if (!(this.enabled && rec)) return this.write(userId, relPath, typeof body === 'string' ? body : Buffer.from(body), contentType);
    const s = await sessionFor({ ...rec, id: userId });
    const url = `${rec.podUrl}concord/${relPath}`;
    const headers: Record<string, string> = { 'content-type': contentType };
    if (when.ifMatch) headers['if-match'] = when.ifMatch;
    if (when.ifNoneMatch) headers['if-none-match'] = when.ifNoneMatch;
    const res = await s.fetch(url, { method: 'PUT', headers, body });
    if (res.status === 412) throw new PreconditionFailed(`PUT ${url} → 412`);
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
