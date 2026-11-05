import type { AgentReport, ChangeRequest, InterviewSession, Meeting, Release, ReleaseDetail, RequirementsDocument, UseCaseDetail, UseCaseRef, User } from '@concord/shared';
import { get, list } from '../db.js';
import { changeRequestsFor, useCaseIdsForCR } from './traceability.js';
import { allUseCases, canSee, canSeeMeeting, canTriage, crForViewer, isGroupMember, getUseCaseFor, present, refOf, useCaseRefs } from './useCases.js';
import { documentSummary } from './requirements.js';

/**
 * Everything a use case is linked to, in both directions, as one viewer may see it:
 * the call, interview or agent report it came from (with the transcript lines),
 * the change requests and releases that address it, related use cases (links
 * either way), and the requirements documents that cite it.
 */
export async function useCaseDetail(id: string, viewer?: User): Promise<UseCaseDetail> {
  const raw = await getUseCaseFor(id, viewer);
  const u = await present(raw, viewer);
  const own = !!viewer && viewer.id === raw.authorId;

  let source: UseCaseDetail['trace']['source'];
  if (raw.anonymous) source = { kind: 'anonymised', title: 'Anonymised from a use case described privately' };
  else if (raw.source === 'meeting' && raw.sourceRef) {
    const m = await get<Meeting>('meetings', raw.sourceRef);
    // The call and its transcript are for the working group (and whoever recorded it).
    if (!m || !await canSeeMeeting(m, viewer)) source = { kind: 'meeting', title: 'A working group call' };
    else
      source = {
        kind: 'meeting',
        id: m.id,
        title: m.title,
        date: m.createdAt,
        href: `/o/${raw.ontologyId}/meetings/${m.id}`,
        lines: (raw.sourceLines ?? []).map((i) => m.transcript[i]).filter(Boolean),
      };
  } else if (raw.source === 'agent' && raw.sourceRef) {
    const r = await get<AgentReport>('agentReports', raw.sourceRef);
    if (r) source = { kind: 'agent-report', id: r.id, title: `${r.agentName}: ${r.summary}`, date: r.createdAt };
  } else if (raw.source === 'chat') {
    const s = (await list<InterviewSession>('interviews', raw.ontologyId)).find((x) => x.useCaseId === raw.id);
    source = { kind: 'interview', id: own ? s?.id : undefined, title: 'Requirements interview', date: s?.createdAt ?? raw.createdAt, href: own && s ? `/o/${raw.ontologyId}/interview/${s.id}` : undefined };
  } else source = { kind: 'form', title: 'Submitted directly', date: raw.createdAt };

  const crs = await changeRequestsFor(raw);
  const releaseIds = [...new Set(crs.map((c) => c.releaseId).filter((x): x is string => !!x))];
  const releases = (await Promise.all(releaseIds.map(async (rid) => await get<Release>('releases', rid)))).filter((r): r is Release => !!r);

  const all = await allUseCases(raw.ontologyId);
  const byId = new Map(all.map((x) => [x.id, x]));
  const related: UseCaseDetail['trace']['related'] = [];
  for (const l of u.links ?? []) {
    if (l.type !== 'use-case' || !l.id) continue;
    const t = byId.get(l.id);
    if (t && await canSee(t, viewer)) related.push({ ...refOf(t), relation: l.relation, direction: 'out' });
  }
  for (const other of all) {
    if (other.id === raw.id || !await canSee(other, viewer)) continue;
    const l = other.links?.find((x) => x.type === 'use-case' && x.id === raw.id);
    if (l && !related.some((r) => r.id === other.id)) related.push({ ...refOf(other), relation: l.relation, direction: 'in' });
  }
  // Raw links as this viewer may see them (present filters targets and strips who added them to anonymous ones).
  const other = (u.links ?? []).filter((l) => l.type !== 'use-case');

  const group = await canTriage(raw.ontologyId, viewer) || await isGroupMember(raw.ontologyId, viewer);
  const documents = (await list<RequirementsDocument>('requirementsDocs', raw.ontologyId))
    .filter((d) => d.useCases.some((x) => x.id === raw.id) && (d.status === 'published' || group))
    .map((d) => ({ version: d.version, releaseId: d.releaseId, status: d.status }));

  return {
    ...u,
    trace: {
      source,
      // Change requests are behind sign-in, and so are their titles.
      changeRequests: viewer ? (await Promise.all(crs.map(async (c) => await crForViewer(c, viewer)))).map((c) => ({ id: c.id, number: c.number, title: c.title, status: c.status, releaseId: c.releaseId })) : [],
      releases: releases.map((r) => ({ id: r.id, version: r.version, status: r.status })),
      related: related.sort((a, b) => a.number - b.number),
      other,
      documents,
    },
    can: {
      edit: own || await canTriage(raw.ontologyId, viewer),
      triage: raw.visibility !== 'private' && await canTriage(raw.ontologyId, viewer),
      changeVisibility: own && !raw.anonymous,
      withdraw: own && !raw.withdrawnAt && (raw.anonymous || raw.visibility !== 'private'),
    },
  };
}

/** The use cases a change request addresses, as a viewer may see them. */
export const useCasesForCR = async (cr: ChangeRequest, viewer?: User): Promise<UseCaseRef[]> => useCaseRefs(useCaseIdsForCR(cr), viewer);

/** The use cases a release closes, and its requirements document summary. */
export async function releaseTrace(r: Release, viewer?: User): Promise<Pick<ReleaseDetail, 'useCases' | 'requirements'>> {
  const ids = new Set<string>();
  for (const id of r.changeRequestIds) {
    const cr = await get<ChangeRequest>('changeRequests', id);
    if (cr) useCaseIdsForCR(cr).forEach((x) => ids.add(x));
  }
  const doc = (await list<RequirementsDocument>('requirementsDocs', r.ontologyId)).find((d) => d.version === r.version);
  // The document's own access rule and serving projection: no draft for outsiders, no withdrawn title for anyone.
  const s = doc && await documentSummary(doc, viewer);
  return {
    useCases: await useCaseRefs([...ids], viewer),
    requirements: s ? { id: s.id, version: s.version, status: s.status, generatedAt: s.generatedAt, title: s.title } : undefined,
  };
}

