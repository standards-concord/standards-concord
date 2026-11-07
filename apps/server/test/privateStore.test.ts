import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { get, openDb, put } from '../src/db.js';
import { localTag, PreconditionFailed, privateStore } from '../src/services/privateStore.js';
import { solid } from '../src/services/solid.js';

/**
 * Private data this server keeps (no pod): files under the data directory on the VM, database rows on Vercel,
 * which has no lasting disk (step 5). Both must behave the same, conditional writes included.
 */
beforeAll(async () => {
  await openDb();
});
const before = config.privateStore;
afterEach(() => {
  (config as { privateStore: string }).privateStore = before;
});
const use = (kind: 'files' | 'db') => ((config as { privateStore: string }).privateStore = kind);
let n = 0;
const who = () => `private-${Date.now()}-${++n}`;

describe.each(['files', 'db'] as const)('the private store (%s)', (kind) => {
  it('reads back what was written, and nothing for what wasn’t', async () => {
    use(kind);
    const u = who();
    expect(await privateStore().read(u, 'alpha/testing.jsonld')).toBeUndefined();
    await privateStore().write(u, 'alpha/testing.jsonld', Buffer.from('{"v":1}'));
    expect((await privateStore().read(u, 'alpha/testing.jsonld'))?.toString()).toBe('{"v":1}');
  });

  it('writes conditionally, the way a pod’s PUT does', async () => {
    use(kind);
    const u = who();
    const store = privateStore();
    await store.writeIf(u, 'f.json', Buffer.from('one'), { ifNoneMatch: '*' });
    await expect(store.writeIf(u, 'f.json', Buffer.from('two'), { ifNoneMatch: '*' })).rejects.toBeInstanceOf(PreconditionFailed);
    await expect(store.writeIf(u, 'f.json', Buffer.from('two'), { ifMatch: localTag(Buffer.from('other')) })).rejects.toBeInstanceOf(PreconditionFailed);
    await store.writeIf(u, 'f.json', Buffer.from('two'), { ifMatch: localTag(Buffer.from('one')) });
    expect((await store.read(u, 'f.json'))?.toString()).toBe('two');
    await expect(store.writeIf(u, 'gone.json', Buffer.from('x'), { ifMatch: localTag(Buffer.from('x')) })).rejects.toBeInstanceOf(PreconditionFailed);
    expect(await store.createCopy(u, 'f.previous.json', Buffer.from('two'), 'f.json')).toBe(true);
    expect(await store.createCopy(u, 'f.previous.json', Buffer.from('again'), 'f.json')).toBe(false);
    expect((await store.read(u, 'f.previous.json'))?.toString()).toBe('two');
  });

  it('keeps what was already there before replacing it (solid.keepExisting), and keeps users apart', async () => {
    use(kind);
    const [a, b] = [who(), who()];
    await solid.write(a, 'alpha/testing.jsonld', 'theirs', 'text/plain');
    const when = await solid.keepExisting(a, 'alpha/testing.jsonld');
    expect(when.ifMatch).toBe(localTag(Buffer.from('theirs')));
    await solid.writeExisting(a, 'alpha/testing.jsonld', 'ours', 'application/ld+json', when);
    expect(await solid.read(a, 'alpha/testing.jsonld')).toBe('ours');
    expect(await solid.read(b, 'alpha/testing.jsonld')).toBeUndefined();
  });
});

describe('on Vercel', () => {
  it('keeps private data in the database, not on disk', async () => {
    use('db');
    const u = who();
    await solid.write(u, 'interviews/x.ttl', '<a> <b> <c> .');
    expect(await get('privateFiles', `${u}/interviews/x.ttl`)).toMatchObject({ data: Buffer.from('<a> <b> <c> .').toString('base64') });
  });

  // On the VM a pod that can't be written falls back to this server's files. Without a lasting disk that copy
  // would be lost, or be a second copy the pod never sees, so the person is told the write failed instead.
  it('reports a pod write that failed instead of quietly keeping a copy here', async () => {
    const url = config.solid.serverUrl;
    (config.solid as { serverUrl?: string }).serverUrl = 'http://127.0.0.1:9';
    try {
      const u = who();
      await put('kv', { id: `pod:${u}`, podUrl: 'http://127.0.0.1:9/p/', webId: 'http://127.0.0.1:9/p/profile/card#me', clientId: 'c', clientSecret: 's' });
      use('db');
      await expect(solid.write(u, 'interviews/y.ttl', 'x')).rejects.toThrow();
      expect(await get('privateFiles', `${u}/interviews/y.ttl`)).toBeUndefined();
      use('files');
      expect((await solid.write(u, 'interviews/y.ttl', 'x')).kind).toBe('local');
    } finally {
      (config.solid as { serverUrl?: string }).serverUrl = url;
    }
  });
});
