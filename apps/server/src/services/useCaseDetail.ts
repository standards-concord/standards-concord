import type { AgentReport, ChangeRequest, InterviewSession, Meeting, Release, ReleaseDetail, RequirementsDocument, UseCaseDetail, UseCaseRef, User } from '@concord/shared';
import { get, list } from '../db.js';
import { changeRequestsFor, useCaseIdsForCR } from './traceability.js';
import { allUseCases, canSee, canTriage, getUseCaseFor, present, refOf, useCaseRefs } from './useCases.js';

/**
 * Everything a use case is linked to, in both directions, as one viewer may see it:
 * the call, interview or agent report it came from (with the transcript lines),
 * the change requests and releases that address it, related use cases (links
 * either way), and the requirements documents that cite it.
 */
export function useCaseDetail(id: string, viewer?: User): UseCaseDetail {
  const raw = getUseCaseFor(id, viewer);
  const u = present(raw, viewer);
  const own = !!viewer && viewer.id === raw.authorId;

  let source: UseCaseDetail['trace']['source'];
  if (raw.anonymous) source = { kind: 'anonymised', title: 'Anonymised from a use case described privately' };
  else if (raw.source === 'meeting' && raw.sourceRef) {
    const m = get<Meeting>('meetings', raw.sourceRef);
    if (m)
      source = {
        kind: 'meeting',
        id: m.id,
        title: m.title,
        date: m.createdAt,
        href: `/o/${raw.ontologyId}/meetings/${m.id}`,
        lines: (raw.sourceLines ?? []).map((i) => m.transcript[i]).filter(Boolean),
      };
  } else if (raw.source === 'agent' && raw.sourceRef) {
    const r = get<AgentReport>('agentReports', raw.sourceRef);
    if (r) source = { kind: 'agent-report', id: r.id, title: `${r.agentName}: ${r.summary}`, date: r.createdAt };
  } else if (raw.source === 'chat') {
    const s = list<InterviewSession>('interviews', raw.ontologyId).find((x) => x.useCaseId === raw.id);
    source = { kind: 'interview', id: own ? s?.id : undefined, title: 'Requirements interview', date: s?.createdAt ?? raw.createdAt, href: own && s ? `/o/${raw.ontologyId}/interview/${s.id}` : undefined };
  } else source = { kind: 'form', title: 'Submitted directly', date: raw.createdAt };

  const crs = changeRequestsFor(raw);
  const releaseIds = [...new Set(crs.map((c) => c.releaseId).filter((x): x is string => !!x))];
  const releases = releaseIds.map((rid) => get<Release>('releases', rid)).filter((r): r is Release => !!r);

  const all = allUseCases(raw.ontologyId);
  const byId = new Map(all.map((x) => [x.id, x]));
  const related: UseCaseDetail['trace']['related'] = [];
  for (const l of raw.links ?? []) {
    if (l.type !== 'use-case' || !l.id) continue;
    const t = byId.get(l.id);
    if (t && canSee(t, viewer)) related.push({ ...refOf(t), relation: l.relation, direction: 'out' });
  }
  for (const other of all) {
    if (other.id === raw.id || !canSee(other, viewer)) continue;
    const l = other.links?.find((x) => x.type === 'use-case' && x.id === raw.id);
    if (l && !related.some((r) => r.id === other.id)) related.push({ ...refOf(other), relation: l.relation, direction: 'in' });
  }
  const other = (raw.links ?? []).filter((l) => l.type !== 'use-case');

  const documents = list<RequirementsDocument>('requirementsDocs', raw.ontologyId)
    .filter((d) => d.useCases.some((x) => x.id === raw.id))
    .map((d) => ({ version: d.version, releaseId: d.releaseId, status: d.status }));

  return {
    ...u,
    trace: {
      source,
      changeRequests: crs.map((c) => ({ id: c.id, number: c.number, title: c.title, status: c.status, releaseId: c.releaseId })),
      releases: releases.map((r) => ({ id: r.id, version: r.version, status: r.status })),
      related: related.sort((a, b) => a.number - b.number),
      other,
      documents,
    },
    can: {
      edit: own || canTriage(raw.ontologyId, viewer),
      triage: raw.visibility !== 'private' && canTriage(raw.ontologyId, viewer),
      changeVisibility: own && !raw.anonymous,
    },
  };
}

/** The use cases a change request addresses, as a viewer may see them. */
export const useCasesForCR = (cr: ChangeRequest, viewer?: User): UseCaseRef[] => useCaseRefs(useCaseIdsForCR(cr), viewer);

/** The use cases a release closes, and its requirements document summary. */
export function releaseTrace(r: Release, viewer?: User): Pick<ReleaseDetail, 'useCases' | 'requirements'> {
  const ids = new Set<string>();
  for (const id of r.changeRequestIds) {
    const cr = get<ChangeRequest>('changeRequests', id);
    if (cr) useCaseIdsForCR(cr).forEach((x) => ids.add(x));
  }
  const doc = list<RequirementsDocument>('requirementsDocs', r.ontologyId).find((d) => d.version === r.version);
  return {
    useCases: useCaseRefs([...ids], viewer),
    requirements: doc ? { id: doc.id, version: doc.version, status: doc.status, generatedAt: doc.generatedAt, title: doc.title } : undefined,
  };
}

