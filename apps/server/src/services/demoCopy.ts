import type { ChangeRequest, OntologyProject, Release, Review, TimelineEvent, User, Vote } from '@concord/shared';
import { clock } from '../clock.js';
import { get, list, put, transaction } from '../db.js';
import { markReleasePagesStale } from '../public/routes.js';
import { withOntologyLocks } from './changeRequests.js';
import { ontologyStore } from './ontologyStore.js';
import { PERSONAS, personaByKey } from './personas.js';
import { assertStillHeld } from './repoLock.js';
import { DEMO_REVIEW_COMMENT } from './simulation.js';

const decode = (text: string) => Buffer.from(text, 'base64').toString('utf8');

// wording the demo was seeded with before 0.48.1
// encoded so the retired wording doesn't reappear in searches
export const LEGACY_DEMO_COPY = {
  priya: {
    from: decode('U3RhbmRhcmRzIGh1YiBsZWFkIGF0IHRoZSBPREkuIENoYWlycyB0aGUgdm9sdW50ZWVyaW5nIGRhdGEgc3RhbmRhcmQgd29ya2luZyBncm91cC4gUHJhZ21hdGljLCBjYXJlcyBhYm91dCBhZG9wdGlvbiBhbmQgYWJvdXQgbm90IGJyZWFraW5nIGV4aXN0aW5nIGltcGxlbWVudGVycy4='),
    to: personaByKey('priya')!.persona,
  },
  daniel: {
    from: decode('T0RJIHRlY2huaWNhbCBvdmVyc2lnaHQuIENoZWNrcyB0aGF0IHN0YW5kYXJkcyBtZWV0IHRoZSBodWLigJlzIHF1YWxpdHkgYmFyIChGQUlSLCBsaWNlbnNpbmcsIGxvZ2ljYWwgY29uc2lzdGVuY3kpLiBSYXJlbHkgaW50ZXJ2ZW5lcy4='),
    to: personaByKey('daniel')!.persona,
  },
  description: {
    from: decode('IE9uZSBvZiB0aGUgT0RJIHN0YW5kYXJkcyBodWIgbGF1bmNoIHN0YW5kYXJkcy4='),
    to: '',
  },
  readme: {
    from: decode('TWFuYWdlZCBvbiB0aGUgT0RJIHN0YW5kYXJkcyBodWIgd2l0aCBDb25jb3JkLg=='),
    to: 'Managed with Concord.',
  },
  comment: {
    from: decode('Q2hlY2tlZCBhZ2FpbnN0IHRoZSBodWIgcXVhbGl0eSBiYXI6IEZBSVIgbWV0YWRhdGEgYW5kIGxpY2VuY2UgYXJlIGZpbmUu'),
    to: DEMO_REVIEW_COMMENT,
  },
} as const;

const personaFor = (u: User) => u.simulated === true
  ? PERSONAS.find((p) => u.providers.some((identity) => identity.provider === 'demo' && identity.subject === `persona:${p.key}`))
  : undefined;

function currentMessage(e: TimelineEvent): string {
  const { from, to } = LEGACY_DEMO_COPY.comment;
  // Timeline entries wrap the exact review/vote comment; longer or edited messages are left alone.
  const verbs = e.type === 'comment' ? ['commented']
    : e.type === 'review' ? ['approved', 'requested changes', 'objected']
      : e.type === 'vote' ? ['voted yes', 'voted no', 'voted abstain'] : [];
  for (const verb of verbs) if (e.message === `${verb}: “${from}”`) return `${verb}: “${to}”`;
  return e.message;
}

/** Repairs persisted demo copy, with fresh reads in transactions and the normal ontology writer locks. */
export async function refreshDemoCopy() {
  const counts = { personas: 0, descriptions: 0, readmes: 0, reviews: 0, votes: 0, timeline: 0, releasePages: 0 };
  counts.personas = await transaction(async () => {
    let changed = 0;
    for (const u of await list<User>('users')) {
      const spec = personaFor(u);
      if (!spec || u.persona === spec.persona) continue;
      await put('users', { ...u, persona: spec.persona });
      changed++;
    }
    return changed;
  });

  for (const candidate of (await list<OntologyProject>('ontologies')).filter((p) => p.demo === true)) {
    // Also serialises direct/retried runs. The consent lock protects release rendering from withdrawals.
    await withOntologyLocks(candidate.id, async () => {
      const project = await transaction(async () => {
        let p = await get<OntologyProject>('ontologies', candidate.id);
        if (p?.demo !== true) return undefined;
        const changed = { descriptions: 0, reviews: 0, votes: 0, timeline: 0 };
        const { from, to } = LEGACY_DEMO_COPY.description;
        if (p.description.endsWith(from)) {
          p = { ...p, description: p.description.slice(0, -from.length) + to, updatedAt: clock.iso() };
          await put('ontologies', p);
          changed.descriptions++;
        }
        const simulated = new Set((await list<User>('users')).filter(personaFor).map((u) => u.id));
        const requests = (await list<ChangeRequest>('changeRequests', p.id)).filter((cr) => cr.ontologyId === p.id);
        for (const cr of requests) {
          for (const review of await list<Review>('reviews', cr.id)) {
            if (review.changeRequestId !== cr.id || !simulated.has(review.userId) || review.comment !== LEGACY_DEMO_COPY.comment.from) continue;
            await put('reviews', { ...review, comment: LEGACY_DEMO_COPY.comment.to }, cr.id);
            changed.reviews++;
          }
          const timeline = cr.timeline.map((e) => {
            if (!e.actorId || !simulated.has(e.actorId)) return e;
            const message = currentMessage(e);
            if (message === e.message) return e;
            changed.timeline++;
            return { ...e, message };
          });
          if (timeline.some((e, i) => e !== cr.timeline[i]))
            await put('changeRequests', { ...cr, timeline, rev: (cr.rev ?? 0) + 1 }, p.id);
        }
        const subjects = [
          ...requests.map((cr) => ({ id: cr.id, type: 'change-request' })),
          ...(await list<Release>('releases', p.id)).filter((r) => r.ontologyId === p.id).map((r) => ({ id: r.id, type: 'release' })),
        ];
        for (const subject of subjects) {
          for (const vote of await list<Vote>('votes', subject.id)) {
            if (vote.subjectId !== subject.id || vote.subjectType !== subject.type || !simulated.has(vote.userId) || vote.comment !== LEGACY_DEMO_COPY.comment.from) continue;
            await put('votes', { ...vote, comment: LEGACY_DEMO_COPY.comment.to }, subject.id);
            changed.votes++;
          }
        }
        for (const key of Object.keys(changed) as (keyof typeof changed)[]) counts[key] += changed[key];
        return p;
      });
      if (!project) return;

      const base = await ontologyStore.head(project);
      const readme = await ontologyStore.readRepoFile(project, 'README.md', base);
      if (readme !== undefined) {
        let updated = readme;
        for (const { from, to } of [LEGACY_DEMO_COPY.description, LEGACY_DEMO_COPY.readme]) updated = updated.replaceAll(from, to);
        if (updated !== readme) {
          await assertStillHeld(project);
          await ontologyStore.updateRepoFile(project, 'README.md', updated, 'Refresh legacy demo wording in README', base);
          counts.readmes++;
        }
      }

      // Release pages that embed the old description are re-rendered by the `release-pages` start-up task, which
      // runs after this one, through the same path (and the same locking) as any renderer change.
      let stale = 0;
      for (const r of (await list<Release>('releases', project.id)).filter((r) => r.ontologyId === project.id && r.status === 'published'))
        if ((await ontologyStore.readReleaseFile(project, r.version, 'index.html'))?.includes(LEGACY_DEMO_COPY.description.from)) stale++;
      if (stale) {
        await markReleasePagesStale(project.slug);
        counts.releasePages += stale;
      }
    });
  }
  return counts;
}
