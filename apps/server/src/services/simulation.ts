import fs from 'node:fs';
import path from 'node:path';
import { FORMAT_INFO, serialize, stampRelease, XSD } from '@concord/core';
import type { OutputFormat } from '@concord/core/types';
import type { ActivityItem, ChangeRequest, Meeting, OntologyProject, Release, TranscriptLine, UseCase, User } from '@concord/shared';
import { clock, DAY_MS, saveClock, syncClock } from '../clock.js';
import { config } from '../config.js';
import { clearAll, get, HttpError, list, put, remove, transaction, type Collection } from '../db.js';
import { restoreSpending, snapshotSpending } from '../llm/budget.js';
import { newId } from '../ids.js';
import { PERSONA_ACTOR, UNTRUSTED_TEXT } from '../llm/prompts.js';
import { requestText } from '../llm/context.js';
import { llm } from '../llm/provider.js';
import { PersonaActionSchema } from '../llm/schemas.js';
import { reportGap } from './agents.js';
import { baselineRevision, createApp as createConnectedApp, finishFollowUps, reportAs, revisionOf, startRunAs } from './appChecks.js';
import { addReview, addVote, createChangeRequest, getCR, governanceFor, hasRespondedThisRound, hasVotedOnTheseEdits, merge, submit, tick as crTick } from './changeRequests.js';
import { canApprove, canVote } from './governance.js';
import { snapshotKeptMedia } from './media.js';
import { createProject, rolesFor, setRoles, updateProject } from './ontologies.js';
import { createFork, editFork } from './forks.js';
import { ontologyStore } from './ontologyStore.js';
import { releasePageFiles } from '../public/routes.js';
import { PERSONAS, type PersonaSpec } from './personas.js';
import { describeOp } from './proposals.js';
import { releaseGovernance, releaseTick, voteOnRelease } from './releases.js';
import { sourceLinesFor } from './meetings.js';
import { generateRequirements, markPublished } from './requirements.js';
import { addLink, createUseCase, getUseCase, proposeAnonymised, publishAnonymised } from './useCases.js';
import { aggregationCompetencyQuestions, aggregationExampleData, AGGREGATION_USE_CASE, WEEKLY_SHIFTS_QUESTIONS, WEEKLY_SHIFTS_TERMS, WEEKLY_SHIFTS_USE_CASE } from './demoUseCases.js';
import { createUser, getUser, listActivity, personas } from './users.js';
import { withLease } from '../lease.js';

const FIXTURE = path.join(config.repoRoot, 'packages/core/fixtures/volunteering.ttl');
const VOL = 'https://w3id.org/odi/volunteering#';
export const DEMO_SLUG = 'volunteering';

async function ensurePersonas(): Promise<Map<string, User>> {
  const byKey = new Map<string, User>();
  const existing = await personas();
  for (const p of PERSONAS) {
    let u = existing.find((x) => x.name === p.name);
    u ??= await createUser({ name: p.name, organisation: p.organisation, persona: p.persona, simulated: true, provider: 'demo', subject: `persona:${p.key}` });
    byKey.set(p.key, u);
  }
  return byKey;
}

/** Records a demo use case's seeded content as the only version public pages show. */
async function freezeDemoSeed(u: UseCase) {
  await put('useCases', { ...u, demoSeed: structuredClone({ sections: u.sections, competencyQuestions: u.competencyQuestions }) }, u.ontologyId);
}

export const personaFor = (u: User | undefined) => PERSONAS.find((p) => p.name === u?.name);

/**
 * Whether the demo seed finished: 'seeding' is recorded before it starts and 'done' once it has, so a seed cut short
 * (a function stopped part way) is told apart from a finished one. No record: a demo seeded before this existed.
 */
const SEED_STATE = 'demo-seed-state';
type SeedState = { id: string; state: 'seeding' | 'done' };

/** The demo ontology every alpha tester lands in: the volunteering standard, mid-flight. */
export async function seedDemo(): Promise<OntologyProject | undefined> {
  const find = async () => (await list<OntologyProject>('ontologies')).find((o) => o.slug === DEMO_SLUG);
  const finished = async () => (await get<SeedState>('kv', SEED_STATE))?.state !== 'seeding';
  const existing = await find();
  if (existing && (await finished())) return existing;
  if (!fs.existsSync(FIXTURE)) {
    console.warn('[seed] volunteering fixture not found; skipping demo seed');
    return undefined;
  }
  // One instance seeds (Vercel starts several at once); the others wait for it and find its demo.
  // Seed history in the recent past so review periods are partly elapsed, on a clock of its own: requests
  // meanwhile (and other instances) keep the shared one.
  return await withLease(
    'demo-seed',
    60_000,
    async () => {
      const now = await find();
      if (now && (await finished())) return now;
      // A seed cut short left part of a demo behind: it is cleared and the demo seeded again.
      if (now) await clearUnfinishedSeed(now);
      await put<SeedState>('kv', { id: SEED_STATE, state: 'seeding' });
      const seeded = await clock.withShift(-21 * DAY_MS, seedHistory);
      await put<SeedState>('kv', { id: SEED_STATE, state: 'done' });
      return seeded;
    },
    { renew: true, waitMs: 5 * 60_000 },
  );
}

/** Where a demo seed writes rows that belong to its ontology (named by parent, or by an `ontologyId` field). */
const SEEDED: Collection[] = ['memberships', 'useCases', 'interviews', 'meetings', 'changeRequests', 'reviews', 'votes', 'releases', 'requirementsDocs', 'activity', 'apps', 'appChecks', 'appFollowUps', 'forks', 'agentReports', 'federations', 'federationReleases'];

/** Collections whose rows are kept under a seeded row's id (not the ontology's), by the parent's collection. */
const CHILDREN: Partial<Record<Collection, Collection[]>> = { changeRequests: ['reviews', 'votes', 'appChecks'], releases: ['votes'], federations: ['federationReleases'] };

/**
 * Clears what a seed cut short left behind, and only that: the unfinished demo ontology, the rows that belong to it
 * and its history. Accounts (the personas too, which the next seed reuses), feedback, private data and the server's
 * own records (the import marker, leases, start-up records, the clock) are kept. The rows go in one transaction, so a
 * writer meanwhile either comes before (and its row, if it is the demo's, goes too) or after (and finds no demo).
 * Only in demo mode, and only if the unfinished demo is the only ontology: otherwise nothing is cleared and the
 * start-up task fails, so it is tried again and an administrator can reset the demo.
 */
async function clearUnfinishedSeed(partial: OntologyProject) {
  const others = (await list<OntologyProject>('ontologies')).filter((o) => o.id !== partial.id);
  if (!config.demoMode || others.length) throw new Error('The demo seed was cut short part way, and other data has been added since, so it was not cleared. Reset the demo to seed it again.');
  console.warn('[seed] the demo seed was cut short part way; clearing it and seeding again');
  // History first: if this stops in between, the unfinished demo is still there to be found, and cleared again.
  await ontologyStore.forget(partial);
  await transaction(async () => {
    const parents: string[] = [];
    for (const c of SEEDED) {
      const owned = new Set([...(await list<{ id: string }>(c, partial.id)).map((d) => d.id), ...(await list<{ id: string; ontologyId?: string }>(c)).filter((d) => d.ontologyId === partial.id).map((d) => d.id)]);
      for (const id of owned) await remove(c, id);
      if (c in CHILDREN) parents.push(...owned);
    }
    // Rows kept under a change request, release or federation rather than the ontology (reviews, votes, app
    // checks, federation releases) go with it, in the same transaction.
    const childCollections = [...new Set(Object.values(CHILDREN).flat())];
    for (const parent of parents) for (const c of childCollections) for (const d of await list<{ id: string }>(c, parent)) await remove(c, d.id);
    await remove('ontologies', partial.id);
  });
}

async function seedHistory() {
  const people = await ensurePersonas();
  const priya = people.get('priya')!;
  const project = await createProject(
    {
      title: 'Volunteering opportunities',
      description: 'A shared standard for publishing volunteering opportunities: who offers them, the roles, skills, sessions and locations involved, and how people apply.',
      prefix: 'vol',
      domain: 'volunteering in the UK (charities, councils, volunteering platforms)',
      governanceTemplate: 'working-group',
      seedTurtle: fs.readFileSync(FIXTURE, 'utf8'),
      demo: true,
      slug: DEMO_SLUG,
    },
    priya,
  );
  for (const p of PERSONAS) await setRoles(project.id, people.get(p.key)!.id, p.roles);

  const aisha = people.get('aisha')!;
  const mei = people.get('mei')!;
  const tom = people.get('tom')!;
  const gareth = people.get('gareth')!;

  // Version 1.0.0 is already out: that makes the semver story concrete. Its use case,
  // and its use cases and requirements document, exist before its files are written,
  // so the release's public page and snapshot include them.
  await bootstrapRelease(project, priya, '1.0.0', 'First release of the volunteering standard, agreed by the working group.', async (first) => {
    // The use case behind 1.0.0, with executable competency questions run on every change.
    const cqs = aggregationCompetencyQuestions();
    if (cqs.length) {
      const exampleData = aggregationExampleData();
      await freezeDemoSeed(await createUseCase(project, tom, {
        source: 'form',
        status: 'closed',
        visibility: 'public',
        resolution: { status: 'closed', at: clock.iso(), by: priya.id, releaseId: first.id, version: '1.0.0', note: 'The first release was designed around this use case.' },
        sections: structuredClone(AGGREGATION_USE_CASE),
        competencyQuestions: cqs.map((q) => ({ id: newId('cq'), question: q.question, sparql: q.sparql, exampleData, status: 'answerable' as const })),
      }));
    }
    try {
      await markPublished(await generateRequirements(project, { version: '1.0.0', release: first }), first);
    } catch (err) {
      console.warn(`[seed] requirements document: ${(err as Error).message}`);
    }
  });

  const shifts = await createUseCase(project, aisha, {
    source: 'chat',
    status: 'accepted',
    visibility: 'public',
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
  await addReview(await getCR(patch.id), tom, 'approve', 'Clearer, thanks. Annotation-only, so a patch.');
  clock.advance(2 * DAY_MS);
  await crTick();
  const patchNow = await getCR(patch.id);
  if (patchNow.status === 'approved') await merge(patchNow, priya);
  clock.advance(8 * DAY_MS);

  // A minor change in review: the tester can approve it.
  const minor = await createChangeRequest(project, aisha, {
    title: 'Say whether an opportunity reimburses expenses',
    description: 'Many volunteers can only take part if travel and other out-of-pocket costs are reimbursed. People want to filter on this before applying.',
    kind: 'feature',
    origin: { type: 'chat', useCaseId: shifts.id },
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
  await addReview(await getCR(minor.id), mei, 'comment', 'Would we also want the kinds of expense covered (travel, meals, childcare)? Could be a follow-up.');

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
  await addReview(await getCR(major.id), gareth, 'comment', 'This breaks our data: multi-site opportunities have several locations. Could we make it functional only on Session, via a restriction, instead?');
  await addReview(await getCR(major.id), priya, 'approve', 'Happy in principle; it needs a vote as it is breaking.');

  clock.advance(5 * DAY_MS);
  // An agent report that needs discussion.
  await reportGap(project, gareth, {
    agentName: 'Claude Code',
    kind: 'missing-concept',
    summary: 'No way to express that a session recurs weekly',
    details: 'Building the CharityBase export, shifts are stored as recurring sessions with an iCalendar RRULE (e.g. FREQ=WEEKLY;BYDAY=SA). The ontology has startDateTime and endDateTime on Session but nothing for recurrence, so the export would have to emit every occurrence.',
    context: 'shift: { start: "2026-10-17T09:00", end: "2026-10-17T13:00", rrule: "FREQ=WEEKLY;BYDAY=SA", places: 4 }',
  });
  // That gap doesn't block the CharityBase export: Gareth forks the standard and carries on building.
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

  await seedTraceability(project, { priya, aisha, mei, gareth }, shifts.id);
  // What the public pages may show of the personas' use cases, from now on.
  for (const u of await list<UseCase>('useCases', project.id)) if (u.visibility === 'public') await freezeDemoSeed(u);

  // Gareth's CRM export is a connected app with autopilot on. Its (simulated) CI passed the
  // expenses change, so autopilot approved it for him, and failed the one-location change.
  await seedConnectedApp(project, gareth, minor.id, major.id);

  await updateProject({ ...project, stage: 'maintenance', currentVersion: '1.0.0' });
  return (await list<OntologyProject>('ontologies')).find((o) => o.slug === DEMO_SLUG);
}

async function seedConnectedApp(project: OntologyProject, owner: User, passesId: string, failsId: string) {
  const app = await createConnectedApp(project, owner, { name: 'CharityBase volunteer export', repo: 'charitybase-demo/volunteer-export', autopilot: { enabled: true, levels: ['patch', 'minor'], onFailure: 'report' } });
  const sim = 'Simulated CI run for the demo.';
  const attempt = await startRunAs(app.id);
  await reportAs(app.id, { attempt, target: 'baseline', revision: await baselineRevision(project), outcome: 'passed', summary: sim });
  await reportAs(app.id, { attempt, target: passesId, revision: await revisionOf(await getCR(passesId)), outcome: 'passed', summary: `\`npm test\` passed. ${sim}` });
  await reportAs(app.id, {
    attempt,
    target: failsId,
    revision: await revisionOf(await getCR(failsId)),
    outcome: 'failed',
    summary: `\`npm test\` exited with code 1: "exports a session at several sites" expected 3 locations, got 1. ${sim}`,
  });
}

async function bootstrapRelease(project: OntologyProject, steward: User, version: string, notes: string, beforeWrite?: (r: Release) => Promise<void>) {
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
  await put('releases', r, project.id);
  await beforeWrite?.(r);
  Object.assign(files, await releasePageFiles(project, r, stamped));
  r.commit = await ontologyStore.writeRelease(project, version, stamped, files, notes, { name: 'Concord' });
  await put('releases', r, project.id);
  project.currentVersion = version;
  await updateProject(project);
  return r;
}

/**
 * Shows the sharing modes and links: a working group call with the use case it produced
 * (linked both ways, with the transcript lines it came from), and a private use case
 * whose author published an anonymised synthetic version with no name attached.
 */
async function seedTraceability(project: OntologyProject, p: Record<'priya' | 'aisha' | 'mei' | 'gareth', User>, shiftsId: string) {
  const transcript: TranscriptLine[] = [
    { speaker: p.priya.name, text: 'Thanks for joining. Today I would like to hear how people publish recurring shifts.', t: 4 },
    { speaker: p.gareth.name, text: 'Our charity runs the same Saturday shift every week. Today our export lists every single occurrence, so a year of shifts is fifty-two separate sessions.', t: 15 },
    { speaker: p.gareth.name, text: 'We store the rota as a weekly recurrence rule. It would be far simpler to publish the recurrence once and let aggregators expand it.', t: 31 },
    { speaker: p.aisha.name, text: 'Same for the council. Volunteers want to see “every Saturday morning”, not a list of dates.', t: 48 },
    { speaker: p.mei.name, text: 'For impact reporting we still need to count the sessions that actually happened, so cancellations matter.', t: 63 },
    { speaker: p.gareth.name, text: 'Which recurring shifts run every week, and which dates are cancelled? That is the question our volunteers ask.', t: 80 },
    { speaker: p.priya.name, text: 'Let us capture that as a use case and look at how other vocabularies model recurrence.', t: 96 },
  ];
  const now = clock.iso();
  const meeting: Meeting = {
    id: newId('mtg'),
    ontologyId: project.id,
    title: 'Working group call: recurring shifts',
    source: 'upload',
    transcript,
    facilitatorPrompts: [{ at: now, t: 70, text: 'Mei mentioned cancellations. Should a cancelled occurrence be recorded on the session, or as an exception to the recurrence?', posted: false }],
    analysis: {
      summary: 'Publishers want to describe a recurring shift once, with cancellations as exceptions, instead of listing every occurrence. Impact reporting still needs to count sessions that took place.',
      useCases: [
        {
          title: 'Publish recurring shifts once',
          speaker: p.gareth.name,
          sections: {
            name: 'Publish recurring shifts once',
            goal: 'Publish a weekly shift as a single recurring session rather than one record per date.',
            actors: 'Charity publishing a rota; aggregators; volunteers.',
            usageScenarios: ['A charity runs the same Saturday 9am–1pm shift every week and publishes it once with a weekly recurrence, plus the dates it is cancelled.'],
          },
        },
      ],
      terms: [{ label: 'recurrence rule', kind: 'datatypeProperty', definition: 'How often a session repeats, e.g. weekly on Saturdays.', evidence: ['We store the rota as a weekly recurrence rule.'] }],
      competencyQuestions: [{ question: 'Which recurring shifts run every week, and which dates are cancelled?', askedBy: p.gareth.name }],
      disagreements: [],
      openQuestions: ['Should cancellations be exceptions to the recurrence or properties of a session?'],
      decisions: ['Capture recurring shifts as a use case.'],
    },
    status: 'analysed',
    createdAt: now,
    createdBy: p.priya.id,
  };
  await put('meetings', meeting, project.id);
  const g = meeting.analysis!.useCases[0];
  const recurring = await createUseCase(project, p.priya, {
    source: 'meeting',
    sourceRef: meeting.id,
    sourceLines: sourceLinesFor(meeting, g),
    visibility: 'group',
    status: 'triage',
    sections: { ...g.sections, notes: `From the call “${meeting.title}”, described by ${g.speaker}.` },
    competencyQuestions: [{ id: newId('cq'), question: meeting.analysis!.competencyQuestions[0].question, status: 'untested' }],
    terms: meeting.analysis!.terms,
  });
  await addLink(recurring, p.priya, { type: 'use-case', id: shiftsId, relation: 'related' });

  // Mei described this privately; only the anonymised version is public.
  const impact = await createUseCase(project, p.mei, {
    source: 'chat',
    visibility: 'private',
    status: 'draft',
    sections: {
      name: 'Report volunteering hours to our funders',
      goal: 'Tell the Lottery Community Fund how many hours our volunteers gave at St Anne’s Hospice each quarter, broken down by cause.',
      actors: 'Impact officer at St Anne’s Hospice; funders; volunteering platforms.',
      usageScenarios: ['Every quarter Mei Chen exports hours from Better Impact and emails mei.chen@stannes.example to the Lottery Community Fund.'],
    },
    competencyQuestions: [
      { id: newId('cq'), question: 'How many volunteer hours were given last quarter, by cause?', exampleAnswer: 'Environment 320 hours; health 210 hours', status: 'untested' },
      { id: newId('cq'), question: 'Which opportunities count towards a funder’s outcome?', status: 'untested' },
    ],
  });
  await proposeAnonymised(impact, p.mei);
  await publishAnonymised(await getUseCase(impact.id), p.mei);
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
      return { decision: 'comment', comment: 'Checked against the ODI quality bar: FAIR metadata and licence are fine.', vote: 'abstain' };
    default:
      return { decision: 'comment', comment: 'Looks reasonable.', vote: 'abstain' };
  }
}

/** Run a persona's decision; false if it no longer applies (the request changed meanwhile, or they may not make it). */
async function decided(fn: () => Promise<unknown>) {
  try {
    await fn();
    return true;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 409 || err.status === 403)) return false;
    throw err;
  }
}

/**
 * A member's reaction is still wanted only if they haven't reacted meanwhile: checked on the stored request,
 * under its lock, just before writing. Throws a 409 when not, so `decided` doesn't count it.
 */
function notYet(stillWanted: (c: ChangeRequest) => Promise<boolean>) {
  return async (c: ChangeRequest) => {
    if (!(await stillWanted(c))) throw new HttpError(409, 'This member has already reacted to this request.');
    return true;
  };
}

async function personaReaction(p: PersonaSpec, cr: ChangeRequest, compact: (iri: string) => string) {
  const { value } = await llm.json({
    task: 'persona',
    system: `${PERSONA_ACTOR}\n\nYou are ${p.name} from ${p.organisation}. ${p.persona}\n\n${UNTRUSTED_TEXT}`,
    schema: PersonaActionSchema,
    effort: 'low',
    maxTokens: 1500,
    messages: [
      {
        role: 'user',
        content: `${requestText(cr)}\nLevel: ${cr.classification?.level ?? 'unclassified'}\n\nEdits:\n${cr.ops.map((o) => `- ${describeOp(o, compact)}`).join('\n')}\n\nValidation: ${cr.validation?.passed ? 'passed' : 'failed'}\nComments so far:\n${(await Promise.all(cr.timeline.filter((e) => e.type === 'review' || e.type === 'comment').map(async (e) => `- ${(await getUser(e.actorId ?? ''))?.name ?? 'someone'}: ${e.message}`))).join('\n') || '(none)'}\n\nHow do you respond? Also say how you would vote if it goes to a vote.`,
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
  const open = (await list<ChangeRequest>('changeRequests', ontologyId)).filter((c) => ['review', 'voting'].includes(c.status)).sort((a, b) => a.number - b.number);
  const project = (await list<OntologyProject>('ontologies')).find((o) => o.id === ontologyId);
  const graph = project ? await ontologyStore.working(project) : undefined;
  const compact = (iri: string) => (graph ? (iri.startsWith(graph.namespace) ? `${project!.prefix}:${iri.slice(graph.namespace.length)}` : iri) : iri);

  for (const cr0 of open) {
    for (const u of actors) {
      if (actions >= maxActions) break;
      const cr = await getCR(cr0.id);
      if (!['review', 'voting'].includes(cr.status) || cr.authorId === u.id) continue;
      const p = personaFor(u);
      if (!p) continue;
      const g = await governanceFor(cr);
      const roles = await rolesFor(ontologyId, u.id);
      if (cr.status === 'voting') {
        // A "no" on earlier edits still counts, but its voter is asked once about the new edits.
        if (!canVote(g.rule, roles) || (await hasVotedOnTheseEdits(cr, u.id))) continue;
        const r = await personaReaction(p, cr, compact);
        // The reaction is to the version read above: if it changed while the persona thought, skip it.
        // Another step may have run while the persona thought, so whether they have voted is asked again under the lock.
        if (await decided(() => addVote(cr, u, r.vote, r.comment, cr.round ?? 1, undefined, notYet(async (c) => !(await hasVotedOnTheseEdits(c, u.id)))))) actions++;
      } else {
        // A review from an earlier round (before a resubmission or new edits) no longer counts, so ask again;
        // but anyone who has already said something this round, a comment included, isn't asked twice.
        if ((await hasRespondedThisRound(cr, u.id)) || !(canApprove(g.rule, roles) || roles.includes('member'))) continue;
        const r = await personaReaction(p, cr, compact);
        if (await decided(() => addReview(cr, u, r.decision, r.comment, cr.round ?? 1, undefined, notYet(async (c) => !(await hasRespondedThisRound(c, u.id)))))) actions++;
      }
    }
  }
  for (const r of (await list<Release>('releases', ontologyId)).filter((x) => x.status === 'voting')) {
    for (const u of actors) {
      if (actions >= maxActions) break;
      if ((await list<{ userId: string }>('votes', r.id)).some((v) => v.userId === u.id)) continue;
      if (!canVote((await releaseGovernance(r)).rule, await rolesFor(ontologyId, u.id))) continue;
      try {
        await voteOnRelease(r, u, personaFor(u)?.key === 'gareth' && r.level === 'major' ? 'no' : 'yes');
        actions++;
      } catch {
        /* not eligible */
      }
    }
  }
  return (await listActivity(ontologyId, 50)).filter((a) => a.at >= since);
}

/** Fast-forward the governance clock (review periods, voting windows) and run the lifecycle sweep. */
export async function advanceClock(days: number) {
  await syncClock();
  clock.advance(days * DAY_MS);
  await saveClock();
  return runTick();
}

export async function runTick() {
  const changed = (await crTick()) + (await releaseTick());
  // Finish what any app result that failed part way still had to do (its note, autopilot).
  await finishFollowUps();
  return changed;
}

/**
 * Wipe everything and re-seed. Demo mode only. The AI spending totals survive, or a reset would refill the budget,
 * and so does the list of the welcome page's videos kept in case GitHub can't be read (services/media.ts).
 */
export async function resetAll() {
  // Only while this server holds the repositories, and keeping its hold (see ontologyStore). What the deployment
  // has spent on Claude survives the reset.
  await ontologyStore.wipe(async () => {
    const spend = await snapshotSpending();
    const restoreMedia = await snapshotKeptMedia();
    await clearAll();
    await restoreSpending(spend);
    await restoreMedia();
  });
  clock.reset();
  await saveClock();
  return seedDemo();
}
