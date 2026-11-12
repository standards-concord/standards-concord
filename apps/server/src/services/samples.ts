import fs from 'node:fs';
import path from 'node:path';
import { SAMPLE_VOCABULARIES, type OntologyProject } from '@concord/shared';
import { config } from '../config.js';
import { get, list } from '../db.js';
import { withLease } from '../lease.js';
import { createProject } from './ontologies.js';
import { bootstrapRelease, ensurePersonas } from './simulation.js';

/** A separate lease also protects sign-in's cold-start fallback and reset. Existing slugs are never touched. */
export async function seedSamples(): Promise<OntologyProject[]> {
  if (!config.demoMode) return [];
  const missing = async () => {
    const slugs = new Set((await list<OntologyProject>('ontologies')).map((p) => p.slug));
    return SAMPLE_VOCABULARIES.filter((s) => !slugs.has(s.slug));
  };
  if (!(await missing()).length) return [];
  return await withLease('sample-seed', 60_000, async () => {
    const pending = await missing();
    if (!pending.length) return [];
    // A failed initial demo must be repairable before samples become other data beside it.
    if ((await get<{ state: string }>('kv', 'demo-seed-state'))?.state === 'seeding') throw new Error('The demo seed is unfinished; sample standards will be tried after it finishes.');
    const priya = (await ensurePersonas()).get('priya')!;
    const created: OntologyProject[] = [];
    for (const definition of pending) {
      const { slug, title, prefix, namespace, description, ...sample } = definition;
      const project = await createProject({
        slug, title, prefix, namespace, description, sample,
        seedTurtle: fs.readFileSync(path.join(config.repoRoot, `packages/core/fixtures/samples/${slug}.ttl`), 'utf8'),
        governanceTemplate: 'working-group',
      }, priya);
      project.stage = 'released';
      await bootstrapRelease(project, priya, '1.0.0', `Concord sample copy of ${sample.sourceTitle}, published by ${sample.publisher}. Authoritative vocabulary: ${sample.source}. ${sample.changes}`);
      created.push(project);
    }
    return created;
  }, { renew: true, waitMs: 5 * 60_000 }) ?? [];
}
