import { beforeAll, describe, expect, it } from 'vitest';
import type { OntologyProject } from '@concord/shared';
import type { ReasonerResult } from '@concord/core/types';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/services/simulation.js';
import { validateData } from '../src/services/agents.js';

const VOL = 'https://w3id.org/odi/volunteering#';
const data = `<urn:example:ada> a <${VOL}Volunteer> .`;
let demo: OntologyProject;

beforeAll(async () => {
  openDb();
  demo = (await seedDemo())!;
});

const verdict = (r: Partial<ReasonerResult>) => async (): Promise<ReasonerResult> => ({
  engine: 'sparq', available: true, checked: 'complete', consistent: true, unsatisfiable: [], inferredSubClassOf: [], durationMs: 1, ...r,
});

describe('validateData (agents and MCP validate_data)', () => {
  it('passes data that sparq shows is consistent with the ontology', async () => {
    const out = await validateData(demo, data);
    expect(out.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(out.valid).toBe(true);
  });

  it('fails closed when the reasoner gave no verdict', async () => {
    const out = await validateData(demo, data, verdict({ engine: 'structural', available: false, checked: 'none', error: 'out of budget' }));
    expect(out.valid).toBe(false);
    expect(out.issues).toContainEqual(expect.objectContaining({ severity: 'error', message: expect.stringMatching(/could not check the data.*out of budget/) }));
  });

  it('fails data that contradicts the ontology', async () => {
    expect((await validateData(demo, data, verdict({ consistent: false, explanation: 'Ada is both a person and an organisation.' }))).valid).toBe(false);
  });

  // Data validity is consistency of ontology + data. When sparq proved that but stopped before
  // classifying every class, the data is valid; the unfinished classification is reported as a warning.
  it('passes data proven consistent even if not every class could be classified, with a warning', async () => {
    const out = await validateData(demo, data, verdict({ available: false, checked: 'consistency', error: 'classification ran out of budget' }));
    expect(out.valid).toBe(true);
    expect(out.issues).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringMatching(/consistent with the ontology, but couldn't finish.*out of budget/) }));
  });
});
