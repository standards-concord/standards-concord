import fs from 'node:fs';
import path from 'node:path';
import { FORMAT_INFO, serialize, stampRelease, XSD } from '@concord/core';
import type { OutputFormat } from '@concord/core/types';
import type { ActivityItem, ChangeRequest, OntologyProject, Release, User } from '@concord/shared';
import { clock, DAY_MS } from '../clock.js';
import { config } from '../config.js';
import { clearAll, list, put } from '../db.js';
import { newId } from '../ids.js';
import { PERSONA_ACTOR } from '../llm/prompts.js';
import { llm } from '../llm/provider.js';
import { PersonaActionSchema } from '../llm/schemas.js';
import { reportGap } from './agents.js';
import { addReview, addVote, createChangeRequest, getCR, governanceFor, merge, submit, tick as crTick } from './changeRequests.js';
import { canApprove, canVote } from './governance.js';
import { createFork, editFork } from './forks.js';
import { createProject, rolesFor, setRoles, updateProject } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { releasePageFiles } from '../public/routes.js';
import { PERSONAS, type PersonaSpec } from './personas.js';
import { describeOp } from './proposals.js';
import { releaseTick, voteOnRelease } from './releases.js';
import { createUseCase } from './useCases.js';
import { aggregationCompetencyQuestions, aggregationExampleData, AGGREGATION_USE_CASE, WEEKLY_SHIFTS_QUESTIONS, WEEKLY_SHIFTS_TERMS, WEEKLY_SHIFTS_USE_CASE } from './demoUseCases.js';
import { createUser, getUser, listActivity, personas } from './users.js';

const FIXTURE = path.join(config.repoRoot, 'packages/core/fixtures/volunteering.ttl');
const VOL = 'https://w3id.org/odi/volunteering#';
export const DEMO_SLUG = 'volunteering';

async function ensurePersonas(): Promise<Map<string, User>> {
  const byKey = new Map<string, User>();
  const existing = personas();
  for (const p of PERSONAS) {
    let u = existing.find((x) => x.name === p.name);
    u ??= await createUser({ name: p.name, organisation: p.organisation, persona: p.persona, simulated: true, provider: 'demo', subject: `persona:${p.key}` });
    byKey.set(p.key, u);
  }
  return byKey;
}

export const personaFor = (u: User | undefined) => PERSONAS.find((p) => p.name === u?.name);

/** The demo ontology every alpha tester lands in: the volunteering standard, mid-flight. */
export async function seedDemo(): Promise<OntologyProject | undefined> {
  const existing = list<OntologyProject>('ontologies').find((o) => o.slug === DEMO_SLUG);
  if (existing) return existing;
  if (!fs.existsSync(FIXTURE)) {
    console.warn('[seed] volunteering fixture not found; skipping demo seed');
    return undefined;
  }
  // Seed history in the recent past so review periods are partly elapsed.
  const realOffset = clock.offsetMs;
  clock.offsetMs = realOffset - 21 * DAY_MS;
  try {
    return await seedHistory();
  } finally {
    clock.offsetMs = realOffset;
  }
}

async function seedHistory() {
  const people = await ensurePersonas();
  const priya = people.get('priya')!;
  const project = await createProject(
    {
      title: 'Volunteering opportunities',
      description: 'A shared standard for publishing volunteering opportunities: who offers them, the roles, skills, sessions and locations involved, and how people apply. One of the Open Data Institute launch standards.',
      prefix: 'vol',
      domain: 'volunteering in the UK (charities, councils, volunteering platforms)',
      governanceTemplate: 'working-group',
      seedTurtle: fs.readFileSync(FIXTURE, 'utf8'),
      demo: true,
      slug: DEMO_SLUG,
    },
    priya,
  );
  for (const p of PERSONAS) setRoles(project.id, people.get(p.key)!.id, p.roles);

  // Version 1.0.0 is already out: that makes the semver story concrete.
  await bootstrapRelease(project, priya, '1.0.0', 'First release of the volunteering standard, agreed by the working group.');

  const aisha = people.get('aisha')!;
  const mei = people.get('mei')!;
  const tom = people.get('tom')!;
  const gareth = people.get('gareth')!;

  // The use case behind 1.0.0, with executable competency questions run on every change.
  const cqs = aggregationCompetencyQuestions();
  if (cqs.length) {
    const exampleData = aggregationExampleData();
    createUseCase(project, tom, {
      source: 'form',
      status: 'synthesised',
      sections: structuredClone(AGGREGATION_USE_CASE),
      competencyQuestions: cqs.map((q) => ({ id: newId('cq'), question: q.question, sparql: q.sparql, exampleData, status: 'answerable' as const })),
    });
  }

  createUseCase(project, aisha, {
    source: 'chat',
    status: 'ready',
    sections: structuredClone(WEEKLY_SHIFTS_USE_CASE),
    competencyQuestions: WEEKLY_SHIFTS_QUESTIONS.map((q) => ({ id: newId('cq'), ...q, status: 'untested' as const })),
    terms: structuredClone(WEEKLY_SHIFTS_TERMS),
  });

  // A merged patch waiting for the next release.
  const patch = await createChangeRequest(project, mei, {
    title: 'Clarify the definition of cause',
    description: 'Funders and platforms read “cause” differently. Make clear it is the purpose an opportunity advances, not the organisation’s charitable objects.',
    kind: 'editorial',
    origin: { type: 'direct' },
    ops: [
      {
        op: 'updateAnnotations',
        iri: `${VOL}Cause`,
        set: { definition: 'A social, environmental, cultural or other purpose that a volunteering opportunity is intended to advance, as distinct from the charitable objects of the organisation offering it.' },
      },
    ],
  });
  await submit(patch, mei);
  await addReview(getCR(patch.id), tom, 'approve', 'Clearer, thanks. Annotation-only, so a patch.');
  clock.advance(2 * DAY_MS);
  await crTick();
  const patchNow = getCR(patch.id);
  if (patchNow.status === 'approved') await merge(patchNow, priya);
  clock.advance(8 * DAY_MS);

  // A minor change in review: the tester can approve it.
  const minor = await createChangeRequest(project, aisha, {
    title: 'Say whether an opportunity reimburses expenses',
    description: 'Many volunteers can only take part if travel and other out-of-pocket costs are reimbursed. People want to filter on this before applying.',
    kind: 'feature',
    origin: { type: 'chat' },
    ops: [
      {
        op: 'addDatatypeProperty',
        localName: 'expensesReimbursed',
        label: 'expenses reimbursed',
        definition: 'Whether volunteers taking up a volunteering opportunity can claim back reasonable out-of-pocket expenses, such as travel.',
        domain: [`${VOL}VolunteeringOpportunity`],
        range: [XSD.boolean],
        functional: true,
      },
    ],
  });
  await submit(minor, aisha);
  await addReview(getCR(minor.id), mei, 'comment', 'Would we also want the kinds of expense covered (travel, meals, childcare)? Could be a follow-up.');

  // A major change being voted on: shows a breaking change and a real disagreement.
  const major = await createChangeRequest(project, tom, {
    title: 'Allow only one location per session',
    description: 'Make “has location” functional so each session has exactly one place. Simplifies search and mapping.',
    kind: 'feature',
    origin: { type: 'direct' },
    ops: [{ op: 'setCharacteristics', iri: `${VOL}hasLocation`, characteristics: ['functional'] }],
  });
  await submit(major, tom);
  clock.advance(2 * DAY_MS);
  await addReview(getCR(major.id), gareth, 'comment', 'This breaks our data: multi-site opportunities have several locations. Could we make it functional only on Session, via a restriction, instead?');
  await addReview(getCR(major.id), priya, 'approve', 'Happy in principle; it needs a vote as it is breaking.');

  clock.advance(5 * DAY_MS);
  // An agent report that needs discussion.
  await reportGap(project, gareth, {
    agentName: 'Claude Code',
    kind: 'missing-concept',
    summary: 'No way to express that a session recurs weekly',
    details: 'Building the CharityBase export, shifts are stored as recurring sessions with an iCalendar RRULE (e.g. FREQ=WEEKLY;BYDAY=SA). The ontology has startDateTime and endDateTime on Session but nothing for recurrence, so the export would have to emit every occurrence.',
    context: 'shift: { start: "2026-10-17T09:00", end: "2026-10-17T13:00", rrule: "FREQ=WEEKLY;BYDAY=SA", places: 4 }',
  });

  // Gareth isn't blocked by that gap: he forks the standard and carries on building.
  const fork = await createFork(project, gareth, { name: 'CharityBase recurring shifts', purpose: 'Exporting recurring shifts from CharityBase without listing every occurrence.' });
  await editFork(fork, gareth, {
    message: 'Add a recurrence rule for sessions',
    ops: [
      {
        op: 'addDatatypeProperty',
        localName: 'recurrenceRule',
        label: 'recurrence rule',
        definition: 'An iCalendar (RFC 5545) recurrence rule giving the pattern on which a session repeats, such as every Saturday morning.',
        domain: [`${VOL}Session`],
        range: [XSD.string],
        examples: ['FREQ=WEEKLY;BYDAY=SA'],
      },
    ],
  });

  updateProject({ ...project, stage: 'maintenance', currentVersion: '1.0.0' });
  return list<OntologyProject>('ontologies').find((o) => o.slug === DEMO_SLUG);
}

async function bootstrapRelease(project: OntologyProject, steward: User, version: string, notes: string) {
  const working = await ontologyStore.working(project);
  const stamped = stampRelease(working, { version, level: 'major', date: clock.iso().slice(0, 10), backwardCompatible: true });
  const files: Record<string, string> = {};
  for (const f of Object.keys(FORMAT_INFO) as OutputFormat[]) {
    if (f === 'turtle') continue;
    try {
      files[`ontology.${FORMAT_INFO[f].extension}`] = await serialize(stamped, f, { name: project.slug });
    } catch {
      /* format not available */
    }
  }
  const now = clock.iso();
  const r: Release = {
    id: newId('rel'),
    ontologyId: project.id,
    version,
    level: 'major',
    status: 'published',
    changeRequestIds: [],
    notes,
    versionIRI: `${project.ontologyIRI}/${version}`,
    createdBy: steward.id,
    createdAt: now,
    publishedAt: now,
    statusSince: now,
  };
  Object.assign(files, await releasePageFiles(project, r, stamped));
  r.commit = await ontologyStore.writeRelease(project, version, stamped, files, notes, { name: steward.name });
  put('releases', r, project.id);
  project.currentVersion = version;
  updateProject(project);
}

/* ------------------------------------------------------------------------ */
/* Simulated participants acting                                             */
/* ------------------------------------------------------------------------ */

/** Deterministic in-character reactions, used when no model is configured. */
function scriptedReaction(p: PersonaSpec, cr: ChangeRequest): { decision: 'approve' | 'request-changes' | 'object' | 'comment'; comment: string; vote: 'yes' | 'no' | 'abstain' } {
  const level = cr.classification?.level ?? 'minor';
  const failing = cr.validation && !cr.validation.passed;
  if (failing) return { decision: 'request-changes', comment: 'Validation is failing on this one. Can we fix the errors before we look at it properly?', vote: 'no' };
  switch (p.key) {
    case 'tom':
      return level === 'major'
        ? { decision: 'comment', comment: 'If we go ahead I would like a migration note in the release, and a deprecation period first if possible.', vote: 'yes' }
        : { decision: 'approve', comment: 'Definitions read well and the axioms are minimal. Approving.', vote: 'yes' };
    case 'gareth':
      return level === 'major'
        ? { decision: 'object', comment: 'This will break existing exports from our CRM. I can support it with a deprecation period and a migration script.', vote: 'no' }
        : { decision: 'approve', comment: 'Easy for us to map. Fine by me.', vote: 'yes' };
    case 'mei':
      return { decision: 'approve', comment: level === 'major' ? 'I see the benefit for analysis. Approving, but let us document the change clearly.' : 'Useful for impact reporting. Approve.', vote: level === 'major' ? 'yes' : 'yes' };
    case 'aisha':
      return { decision: 'approve', comment: 'From a coordinator’s point of view this makes sense.', vote: 'yes' };
    case 'priya':
      return { decision: 'approve', comment: 'Thanks all. Approving from the chair.', vote: 'yes' };
    case 'daniel':
      return { decision: 'comment', comment: 'Checked against the hub quality bar: FAIR metadata and licence are fine.', vote: 'abstain' };
    default:
      return { decision: 'comment', comment: 'Looks reasonable.', vote: 'abstain' };
  }
}

async function personaReaction(p: PersonaSpec, cr: ChangeRequest, compact: (iri: string) => string) {
  const { value } = await llm.json({
    task: 'persona',
    system: `${PERSONA_ACTOR}\n\nYou are ${p.name} from ${p.organisation}. ${p.persona}`,
    schema: PersonaActionSchema,
    effort: 'low',
    maxTokens: 1500,
    messages: [
      {
        role: 'user',
        content: `Change request #${cr.number}: ${cr.title} (${cr.classification?.level ?? 'unclassified'})\n${cr.description}\n\nEdits:\n${cr.ops.map((o) => `- ${describeOp(o, compact)}`).join('\n')}\n\nValidation: ${cr.validation?.passed ? 'passed' : 'failed'}\nComments so far:\n${cr.timeline.filter((e) => e.type === 'review' || e.type === 'comment').map((e) => `- ${getUser(e.actorId ?? '')?.name ?? 'someone'}: ${e.message}`).join('\n') || '(none)'}\n\nHow do you respond? Also say how you would vote if it goes to a vote.`,
      },
    ],
    fallback: () => scriptedReaction(p, cr),
  });
  return value;
}

/**
 * Advance the simulated working group by one "beat": a few personas react to
 * open change requests and vote on open releases. The tester's own user is never moved.
 */
export async function step(ontologyId: string, testerId?: string, maxActions = 3): Promise<ActivityItem[]> {
  const since = clock.iso();
  const people = await ensurePersonas();
  const actors = [...people.values()].filter((u) => u.id !== testerId);
  let actions = 0;
  const open = list<ChangeRequest>('changeRequests', ontologyId).filter((c) => ['review', 'voting'].includes(c.status)).sort((a, b) => a.number - b.number);
  const project = list<OntologyProject>('ontologies').find((o) => o.id === ontologyId);
  const graph = project ? await ontologyStore.working(project) : undefined;
  const compact = (iri: string) => (graph ? (iri.startsWith(graph.namespace) ? `${project!.prefix}:${iri.slice(graph.namespace.length)}` : iri) : iri);

  for (const cr0 of open) {
    for (const u of actors) {
      if (actions >= maxActions) break;
      const cr = getCR(cr0.id);
      if (!['review', 'voting'].includes(cr.status) || cr.authorId === u.id) continue;
      const p = personaFor(u);
      if (!p) continue;
      const g = governanceFor(cr);
      const roles = rolesFor(ontologyId, u.id);
      if (cr.status === 'voting') {
        if (!canVote(g.rule, roles) || list<{ userId: string; at: string }>('votes', cr.id).some((v) => v.userId === u.id && v.at >= (cr.opsUpdatedAt ?? ''))) continue;
        const r = await personaReaction(p, cr, compact);
        await addVote(cr, u, r.vote, r.comment);
        actions++;
      } else {
        const reviewed = list<{ userId: string; at: string }>('reviews', cr.id).some((v) => v.userId === u.id && v.at >= (cr.opsUpdatedAt ?? ''));
        if (reviewed || !(canApprove(g.rule, roles) || roles.includes('member'))) continue;
        const r = await personaReaction(p, cr, compact);
        await addReview(cr, u, r.decision, r.comment);
        actions++;
      }
    }
  }
  for (const r of list<Release>('releases', ontologyId).filter((x) => x.status === 'voting')) {
    for (const u of actors) {
      if (actions >= maxActions) break;
      if (list<{ userId: string }>('votes', r.id).some((v) => v.userId === u.id)) continue;
      try {
        await voteOnRelease(r, u, personaFor(u)?.key === 'gareth' && r.level === 'major' ? 'no' : 'yes');
        actions++;
      } catch {
        /* not eligible */
      }
    }
  }
  return listActivity(ontologyId, 50).filter((a) => a.at >= since);
}

/** Fast-forward the governance clock (review periods, voting windows) and run the lifecycle sweep. */
export async function advanceClock(days: number) {
  clock.advance(days * DAY_MS);
  return runTick();
}

export async function runTick() {
  const changed = (await crTick()) + (await releaseTick());
  return changed;
}

/** Wipe everything and re-seed. Demo mode only. */
export async function resetAll() {
  clearAll();
  clock.reset();
  fs.rmSync(path.join(config.dataDir, 'ontologies'), { recursive: true, force: true });
  return seedDemo();
}
