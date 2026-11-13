import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { npmPackage, OntologyGraph, serialize, toLinkML, toManchester, toShacl, toShaclc, toWrapperClasses } from '../src/index.js';
import { distributionNotice, noticeComment } from '../src/notices.js';
import { SAMPLE_VOCABULARIES } from '../../shared/src/samples.js';

function unpack(tgz: Buffer): Record<string, string> {
  const tar = gunzipSync(tgz);
  const files: Record<string, string> = {};
  for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString('ascii'), 8);
    files[name] = tar.subarray(off + 512, off + 512 + size).toString('utf8');
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

describe('notices in generated distributions', () => {
  for (const slug of ['acl', 'foaf']) it(`carries ${slug} rights and attribution through every exporter and the npm archive`, async () => {
    const sample = SAMPLE_VOCABULARIES.find((s) => s.slug === slug)!;
    const graph = await OntologyGraph.fromTurtle(fs.readFileSync(new URL(`../fixtures/samples/${slug}.ttl`, import.meta.url), 'utf8'));
    const mod = await toWrapperClasses(graph);
    const shapes = await toShacl(graph);
    const files = unpack(npmPackage(mod, { name: `${slug}-ontology`, version: '1.0.0', shapes }));
    const expected = [sample.licence.url, sample.source, `Original vocabulary published by ${sample.publisher}.`, ...(sample.authors ?? []), ...(sample.copyrightNotice ? [sample.copyrightNotice] : [])];
    const exports = [toLinkML(graph), toManchester(graph), shapes, await toShaclc(graph), mod.ts, mod.js, mod.dts,
      await serialize(graph, 'typescript'), await serialize(graph, 'javascript'), files['package/NOTICE'], files['package/shapes.ttl']];
    for (const content of exports) for (const text of expected) expect(content).toContain(text);
    expect(JSON.parse(files['package/package.json']).license).toBe('SEE LICENSE IN NOTICE');
    if (slug === 'acl') {
      const full = fs.readFileSync(new URL('../../../docs/licences/W3C-20150513.md', import.meta.url), 'utf8');
      expect(files['package/NOTICE']).toContain(full);
      for (const content of exports) expect(content).toContain('/licences/W3C-20150513');
    }
    // RDF formats carry the actual statements, including JSON-LD where Turtle comments disappear.
    const { namedNode: n } = DataFactory;
    for (const format of ['turtle', 'ntriples', 'rdfxml', 'jsonld'] as const) {
      const back = await OntologyGraph.parse(await serialize(graph, format), format);
      for (const predicate of ['license', 'rights', 'source', 'creator']) {
        const p = n(`http://purl.org/dc/terms/${predicate}`);
        const values = (g: OntologyGraph) => g.store.getObjects(n(graph.ontologyIRI), p, null).map((v) => v.value).sort();
        expect(values(back)).toEqual(values(graph));
      }
    }
  });

  it('reads ordinary ontology notices and keeps multiline text inside comments', async () => {
    const graph = await OntologyGraph.fromTurtle(`
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix dct: <http://purl.org/dc/terms/> .
      <https://example.org/ont> a owl:Ontology; dct:license <https://example.org/licence>;
        dct:rights "Copyright Example.\\nDo not close */ this comment."; dct:source <https://example.org/source>;
        dct:creator [ <http://xmlns.com/foaf/0.1/name> "Example Author" ] .
    `);
    const notice = distributionNotice(graph);
    for (const text of ['https://example.org/licence', 'Copyright Example.', 'https://example.org/source', 'Example Author']) expect(notice).toContain(text);
    expect(noticeComment(notice)).toContain('# Do not close */ this comment.');
    expect(noticeComment(notice, 'block')).toContain(' * Do not close * / this comment.');
  });
});
