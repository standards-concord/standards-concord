import fs from 'node:fs';
import path from 'node:path';
import { SAMPLE_VOCABULARIES, type OntologyProject } from '@concord/shared';
import { config } from '../config.js';
import { checkFence, get, list, transaction, withFence } from '../db.js';
import { withLease } from '../lease.js';
import { createProject, SlugConflictError } from './ontologies.js';
import { bootstrapRelease, ensurePersonas } from './simulation.js';
import { resetGeneration, SeedResetError } from './resetGeneration.js';

/** A separate lease also protects sign-in's cold-start fallback and reset. Existing slugs are never touched. */
export async function seedSamples(): Promise<OntologyProject[]> {
  if (!config.demoMode) return [];
  const generation = await resetGeneration();
  const guard = async () => {
    if (await resetGeneration() !== generation) throw new SeedResetError();
  };
  const missing = async () => {
    const slugs = new Set((await list<OntologyProject>('ontologies')).map((p) => p.slug));
    return SAMPLE_VOCABULARIES.filter((s) => !slugs.has(s.slug));
  };
  if (!(await missing()).length) return [];
  const seed = async () => {
    const pending = await missing();
    if (!pending.length) return [];
    // A failed initial demo must be repairable before samples become other data beside it.
    if ((await get<{ state: string }>('kv', 'demo-seed-state'))?.state === 'seeding') throw new Error('The demo seed is unfinished; sample standards will be tried after it finishes.');
    const priya = await transaction(async () => {
      await checkFence();
      return (await ensurePersonas()).get('priya')!;
    });
    const created: OntologyProject[] = [];
    for (const definition of pending) {
      const { slug, title, prefix, namespace, description, ...sample } = definition;
      let project: OntologyProject;
      try {
        project = await createProject({
          slug, title, prefix, namespace, description, sample,
          seedTurtle: fs.readFileSync(path.join(config.repoRoot, `packages/core/fixtures/samples/${slug}.ttl`), 'utf8'),
          governanceTemplate: 'working-group',
        }, priya);
      } catch (err) {
        if (err instanceof SlugConflictError) continue; // Someone created this slug since pending was read.
        throw err;
      }
      project.stage = 'released';
      await bootstrapRelease(project, priya, '1.0.0', `Concord sample copy of ${sample.sourceTitle}, published by ${sample.publisher}. Authoritative vocabulary: ${sample.source}. ${sample.changes}`);
      created.push(project);
    }
    return created;
  };
  try {
    return await withLease('sample-seed', 60_000, () => withFence(guard, seed), { renew: true, waitMs: 5 * 60_000 }) ?? [];
  } catch (err) {
    if (err instanceof SeedResetError) return [];
    throw err;
  }
}
