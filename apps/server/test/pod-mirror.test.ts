import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The first copy of a tester's record in a real (here: in-memory) Solid pod:
 * whatever was already at the path is kept byte for byte under a fresh name,
 * and the record only replaces exactly that version. The fake pod honours
 * ETag, If-Match and If-None-Match the way a Community Solid Server does.
 */

const store = new Map<string, { bytes: Uint8Array; type: string; etag: string }>();
let etags = 0;
const pod = {
  /** Change a resource behind the server's back (another app writing to the pod). */
  set(url: string, body: string | Uint8Array, type: string) {
    store.set(url, { bytes: typeof body === 'string' ? new TextEncoder().encode(body) : body, type, etag: `"e${++etags}"` });
  },
  /** Called between the server's GET and its PUT, once. */
  beforeNextPut: undefined as undefined | (() => void),
};

/** The fake pod, as the owner's requests reach it (solidOidc's podRequester; the guarded transport itself is tested in solidOidcFlow). */
async function podRequest(method: string, url: string, init: { headers?: Record<string, string>; body?: string | Uint8Array | ArrayBuffer } = {}) {
  const have = store.get(url);
  if (method === 'GET') {
    if (!have) return new Response(null, { status: 404 });
    return new Response(have.bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': have.type, etag: have.etag } });
  }
  const hook = pod.beforeNextPut;
  pod.beforeNextPut = undefined;
  hook?.();
  const now = store.get(url);
  const h = init.headers ?? {};
  if (h['if-none-match'] === '*' && now) return new Response(null, { status: 412 });
  if (h['if-match'] && h['if-match'] !== now?.etag) return new Response(null, { status: 412 });
  const body = init.body;
  pod.set(url, typeof body === 'string' ? body : new Uint8Array(body as ArrayBuffer), h['content-type'] ?? 'application/octet-stream');
  return new Response(null, { status: 201 });
}

vi.mock('../src/solidOidc.js', async (original) => ({
  ...(await original<typeof import('../src/solidOidc.js')>()),
  clientCredentialsLogin: async () => ({}),
  podRequester: async () => podRequest,
}));

const { config } = await import('../src/config.js');
const { openDb, put } = await import('../src/db.js');
const { createUser } = await import('../src/services/users.js');
const { recordVersion } = await import('../src/services/alpha.js');

const saved = config.solid.serverUrl;
beforeAll(async () => {
  await openDb();
  config.solid.serverUrl = 'https://pods.example';
});
afterAll(() => {
  config.solid.serverUrl = saved;
});

async function testerWithPod(subject: string) {
  const u = await createUser({ name: `Pod tester ${subject}`, provider: 'demo', subject });
  const podUrl = `https://pods.example/${subject}/`;
  await put('kv', { id: `pod:${u.id}`, podUrl, webId: `${podUrl}profile/card#me`, clientId: 'c', clientSecret: 's' });
  return { u, record: `${podUrl}concord/alpha/testing.jsonld`, folder: `${podUrl}concord/alpha/` };
}
const asideOf = (folder: string) => [...store.keys()].filter((k) => k.startsWith(`${folder}testing.previous-`));

describe('the first copy of a record in a pod', () => {
  // The old document used to be read as text (mangling binary content) and written over without checking it hadn't changed.
  it('keeps what was there byte for byte, under a name that replaces nothing, then replaces only that version', async () => {
    const { u, record, folder } = await testerWithPod('bytes');
    const binary = new Uint8Array([0, 255, 128, 10, 13, 0xc3, 0x28]);
    pod.set(record, binary, 'application/octet-stream');
    // Something already sits at the first name the backup would take.
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    pod.set(`${folder}testing.previous-1234-0.jsonld`, 'someone else’s file', 'text/plain');
    const me = await recordVersion(u, { version: '0.8.0' });
    vi.restoreAllMocks();
    expect(me.podBehind).toBeUndefined();
    expect(new TextDecoder().decode(store.get(`${folder}testing.previous-1234-0.jsonld`)!.bytes)).toBe('someone else’s file');
    const kept = store.get(`${folder}testing.previous-1234-1.jsonld`)!;
    expect([...kept.bytes]).toEqual([...binary]);
    expect(kept.type).toBe('application/octet-stream');
    expect(JSON.parse(new TextDecoder().decode(store.get(record)!.bytes)).versions.map((v: { version: string }) => v.version)).toEqual(['0.8.0']);
  });

  it('writes nothing over a document that changed after it was kept, and keeps the new one too on the next try', async () => {
    const { u, record, folder } = await testerWithPod('changed');
    pod.set(record, 'first', 'text/turtle');
    pod.beforeNextPut = () => undefined; // the backup PUT goes through untouched
    let puts = 0;
    const realHook = () => {
      puts++;
      if (puts === 1) pod.beforeNextPut = () => pod.set(record, 'changed meanwhile', 'text/turtle');
    };
    pod.beforeNextPut = realHook;
    const me = await recordVersion(u, { version: '0.8.0' });
    expect(me.podBehind).toBe(true);
    expect(new TextDecoder().decode(store.get(record)!.bytes)).toBe('changed meanwhile');
    // Next time round, the changed document is kept as well before the record replaces it.
    const again = await recordVersion(u, { version: '0.8.1' });
    expect(again.podBehind).toBeUndefined();
    const kept = asideOf(folder).map((k) => new TextDecoder().decode(store.get(k)!.bytes)).sort();
    expect(kept).toEqual(['changed meanwhile', 'first']);
    expect(JSON.parse(new TextDecoder().decode(store.get(record)!.bytes)).versions.map((v: { version: string }) => v.version)).toEqual(['0.8.1', '0.8.0']);
  });

  it('only creates the record when nothing was there, and never replaces one that appeared meanwhile', async () => {
    const { u, record, folder } = await testerWithPod('appeared');
    pod.beforeNextPut = () => pod.set(record, 'appeared meanwhile', 'text/turtle');
    expect((await recordVersion(u, { version: '0.8.0' })).podBehind).toBe(true);
    expect(new TextDecoder().decode(store.get(record)!.bytes)).toBe('appeared meanwhile');
    expect((await recordVersion(u, { version: '0.8.1' })).podBehind).toBeUndefined();
    expect(asideOf(folder).map((k) => new TextDecoder().decode(store.get(k)!.bytes))).toEqual(['appeared meanwhile']);
  });

  it('after the first copy, later ones just replace its own record', async () => {
    const { u, folder } = await testerWithPod('later');
    await recordVersion(u, { version: '0.8.0' });
    await recordVersion(u, { version: '0.8.1' });
    expect(asideOf(folder)).toEqual([]);
  });
});
