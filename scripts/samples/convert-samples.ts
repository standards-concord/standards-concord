/** Run: pnpm samples:convert (offline; only writes converted .ttl files). */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertSample } from '../../packages/core/src/sampleConversion.js';
import { SAMPLE_VOCABULARIES } from '../../packages/shared/src/samples.js';

const root = new URL('../../packages/core/fixtures/samples/', import.meta.url);
for (const sample of SAMPLE_VOCABULARIES) {
  const upstream = fs.readFileSync(new URL(`upstream/${sample.upstreamCopy}`, root), 'utf8');
  const output = new URL(`${sample.slug}.ttl`, root);
  fs.writeFileSync(output, convertSample(upstream, sample));
  console.log(fileURLToPath(output));
}
