import { gunzipSync } from 'node:zlib';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/services/simulation.js';

const app = createApp();

beforeAll(async () => {
  await openDb();
  await seedDemo();
});

/** Reads a binary response into a Buffer. */
const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('SHACL compact syntax at the ontology IRI', () => {
  it('serves SHACLC by extension and by Accept', async () => {
    for (const req of [request(app).get('/def/volunteering/1.0.0.shaclc'), request(app).get('/def/volunteering/1.0.0').set('Accept', 'text/shaclc')]) {
      const res = await req;
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/shaclc/);
      expect(res.text).toMatch(/^# SHACL shapes for /);
      expect(res.text).toMatch(/^BASE </m);
      expect(res.text).toMatch(/shape volsh:VolunteeringOpportunityShape -> vol:VolunteeringOpportunity/);
    }
  });
});

describe('extended SHACLC', () => {
  it('keeps shape names with ?syntax=extended', async () => {
    const plain = await request(app).get('/def/volunteering/1.0.0.shaclc');
    expect(plain.text).not.toContain('sh:name');
    const ext = await request(app).get('/def/volunteering/1.0.0.shaclc?syntax=extended');
    expect(ext.text).toContain('sh:name "volunteering opportunity"@en');
  });
});

describe('generated JavaScript classes at the ontology IRI', () => {
  it('serves an ES module that imports @rdfjs/wrapper from a CDN, with CORS for other sites', async () => {
    const res = await request(app).get('/def/volunteering/1.0.0.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/javascript/);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['x-typescript-types']).toMatch(/\/def\/volunteering\/1\.0\.0\.d\.ts$/);
    expect(res.text).toMatch(/from "https:\/\/cdn\.jsdelivr\.net\/npm\/@rdfjs\/wrapper@[\d.]+\/\+esm"/);
    expect(res.text).toContain('class VolunteeringOpportunity extends TermWrapper');
    expect(res.text).toContain('class VolunteeringDataset extends DatasetWrapper');
    expect(res.text).toContain('export {');
  });

  it('negotiates JavaScript and TypeScript on the version IRI', async () => {
    const js = await request(app).get('/def/volunteering/1.0.0').set('Accept', 'text/javascript');
    expect(js.headers['content-type']).toMatch(/^text\/javascript/);
    expect(js.text).toContain('class Volunteer extends Person');
    const ts = await request(app).get('/def/volunteering/1.0.0').set('Accept', 'application/typescript');
    expect(ts.headers['content-type']).toMatch(/^application\/typescript/);
    expect(ts.text).toContain('export class VolunteeringDataset extends DatasetWrapper');
    // Browsers still get the page.
    const html = await request(app).get('/def/volunteering/1.0.0').set('Accept', 'text/html,*/*;q=0.8');
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.text).toContain('Use in JavaScript and TypeScript');
    expect(html.text).toContain('/def/volunteering/1.0.0.js');
    // The example loops over a getter the dataset class really has.
    const getter = /for \(const item of data\.(\w+)\)/.exec(html.text)?.[1];
    expect(getter).toBeTruthy();
    expect(ts.text).toMatch(new RegExp(`get ${getter}\\(\\): Iterable<`));
  });

  it('serves a bare-import module for bundlers, the declarations and the TypeScript source', async () => {
    const bare = await request(app).get('/def/volunteering/draft.js?deps=bare');
    expect(bare.text).toContain('from "@rdfjs/wrapper"');
    expect(bare.headers['cache-control']).toBe('no-cache');
    const dts = await request(app).get('/def/volunteering/1.0.0.d.ts');
    expect(dts.headers['content-type']).toMatch(/^application\/typescript/);
    expect(dts.text).toContain('export declare class VolunteeringOpportunity extends TermWrapper');
    const ts = await request(app).get('/def/volunteering.ts');
    expect(ts.text).toMatch(/get minimumAge\(\): number \| undefined/);
  });

  it('serves an npm package of the classes', async () => {
    const res = await request(app).get('/def/volunteering/1.0.0.tgz').buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/gzip/);
    const tar = gunzipSync(res.body as Buffer);
    const files = new Map<string, string>();
    for (let off = 0; off + 512 <= tar.length; ) {
      const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '');
      if (!name) break;
      const size = parseInt(tar.subarray(off + 124, off + 136).toString('ascii'), 8);
      files.set(name, tar.subarray(off + 512, off + 512 + size).toString('utf8'));
      off += 512 + Math.ceil(size / 512) * 512;
    }
    const pkg = JSON.parse(files.get('package/package.json')!);
    expect(pkg).toMatchObject({ name: 'volunteering-ontology', version: '1.0.0', type: 'module' });
    expect(files.get('package/index.js')).toContain('from "@rdfjs/wrapper"');
    expect(files.get('package/shapes.ttl')).toContain('sh:codeIdentifier');
  });

  it('versions the draft package ahead of the latest release', async () => {
    const res = await request(app).get('/def/volunteering/draft.tgz').buffer(true).parse(binary);
    const tar = gunzipSync(res.body as Buffer).toString('utf8');
    expect(tar).toMatch(/"version": "1\.1\.0-draft"/);
  });
});

describe('formats in the app and over MCP', () => {
  it('offers SHACLC and the classes on the Formats tab endpoint', async () => {
    const res = await request(app).get('/api/ontologies');
    const id = (res.body as { slug: string; id: string }[]).find((o) => o.slug === 'volunteering')?.id;
    expect(id).toBeTruthy();
    for (const [format, type] of [['shaclc', /text\/shaclc/], ['typescript', /application\/typescript/], ['javascript', /text\/javascript/]] as const) {
      const r = await request(app).get(`/api/ontologies/${id}/source?format=${format}`);
      expect(r.status, format).toBe(200);
      expect(r.headers['content-type'], format).toMatch(type);
    }
  });
});
