import fs from 'node:fs';
import path from 'node:path';
import type { ElicitedTerm, UseCaseSections } from '@concord/shared';
import { config } from '../config.js';

/**
 * The demo's two seeded use cases, as fixed content. The simulation seeds the
 * database from these, and the public page shows these (never the database
 * copies, which testers can sign in as a persona and edit).
 */

const FIXTURES = path.join(config.repoRoot, 'packages/core/fixtures');

export const AGGREGATION_USE_CASE: UseCaseSections = {
  name: 'Aggregate volunteering opportunities across platforms',
  goal: 'Let volunteering platforms, councils and charities publish opportunities once, so that aggregators can show them all in one search.',
  actors: 'Volunteer-involving organisations (publishers); volunteering platforms and aggregators (consumers); prospective volunteers.',
  description: 'Organisations publish opportunities as open data using the standard. Aggregators harvest them and let people search by cause, place, time, skills and accessibility.',
  usageScenarios: [
    'A national platform harvests opportunities from forty local volunteer centres and shows them in one map-based search.',
    'A person who uses a wheelchair searches for remote or step-free opportunities supporting the environment.',
  ],
};

/** The executable competency questions behind 1.0.0 (question and SPARQL). */
export function aggregationCompetencyQuestions(): { question: string; sparql: string }[] {
  const file = path.join(FIXTURES, 'volunteering-cqs.json');
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { question: string; sparql: string }[]) : [];
}

export function aggregationExampleData(): string | undefined {
  const file = path.join(FIXTURES, 'volunteering-example-data.ttl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

export const WEEKLY_SHIFTS_USE_CASE: UseCaseSections = {
  name: 'Find weekly shifts that need volunteers',
  goal: 'Help council volunteer coordinators fill recurring shifts, and help residents find regular volunteering that fits around work.',
  actors: 'Volunteer coordinator (primary); resident looking to volunteer; council volunteering website; partner charities.',
  description: 'Coordinators publish rotas of recurring shifts at council-run and partner services. Residents search for shifts by day, place and whether they need a DBS check, and sign up to a rota.',
  usageScenarios: [
    'The Northvale food bank needs four people every Saturday 9am–1pm. The coordinator publishes the shift once as a weekly rota and residents sign up.',
    'A resident who works weekdays searches for weekend shifts within two miles that reimburse bus fares and do not need a DBS check.',
  ],
  basicFlow: [
    { step: 1, actorPerson: 'Coordinator', description: 'Publishes an opportunity with a recurring weekly session and the number of places.' },
    { step: 2, actorSystem: 'Council website', description: 'Lists sessions that still have places, with location and requirements.' },
    { step: 3, actorPerson: 'Resident', description: 'Filters by day, distance, expenses and DBS requirement, then applies.' },
  ],
  dataSources: [{ name: 'Council volunteering CRM' }, { name: 'Partner charity rotas (spreadsheets)' }],
};

export const WEEKLY_SHIFTS_QUESTIONS: { question: string; exampleAnswer: string }[] = [
  { question: 'Which weekly shifts near Northvale still need volunteers this Saturday?', exampleAnswer: 'Food bank, Saturday 9am–1pm, 2 places left' },
  { question: 'Which opportunities reimburse travel expenses?', exampleAnswer: 'Library reading buddies; park clean-up' },
];

export const WEEKLY_SHIFTS_TERMS: ElicitedTerm[] = [
  { label: 'shift', kind: 'class', definition: 'A recurring session on a rota.', evidence: ['coordinators think in terms of shifts'] },
  { label: 'expenses reimbursed', kind: 'datatypeProperty', definition: 'Whether volunteers can claim back out-of-pocket costs.', evidence: ['which opportunities pay expenses'] },
];
