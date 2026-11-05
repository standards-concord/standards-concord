import type { ChangeRequest, Release, UseCase, UseCaseStatus } from '@concord/shared';
import { useCaseLabel } from '@concord/shared';
import { clock } from '../clock.js';
import { transaction, get, list, put } from '../db.js';
import { logActivity } from './users.js';

/**
 * Links between use cases and the change requests and releases that address them.
 *
 * A use case's status follows its change requests automatically:
 * accepted -> in-progress (a change is proposed) -> addressed (merged into the working draft)
 * -> closed (released; the resolution records the version). If every change is
 * rejected or withdrawn it goes back to accepted; if only some are, it is never
 * closed automatically, because the dropped ones may have been needed too. Statuses an editor set by hand
 * (deferred, out of scope, archived, or closed without a change) are left alone.
 *
 * This module only depends on the database so the change request and release
 * services can call it without import cycles.
 */

const ACTIVE: ChangeRequest['status'][] = ['draft', 'triage', 'review', 'voting', 'approved', 'needs-work'];
const MANUAL: UseCaseStatus[] = ['draft', 'deferred', 'out-of-scope', 'archived'];

/** The use cases a change request addresses. */
export function useCaseIdsForCR(cr: ChangeRequest): string[] {
  const ids = new Set(cr.useCaseIds ?? []);
  if (cr.origin.type === 'synthesis') cr.origin.useCaseIds.forEach((id) => ids.add(id));
  if (cr.origin.type === 'chat' && cr.origin.useCaseId) ids.add(cr.origin.useCaseId);
  return [...ids];
}

/** Change requests linked to a use case, from either side of the link. */
export async function changeRequestsFor(u: UseCase, overrides: ChangeRequest[] = []): Promise<ChangeRequest[]> {
  const byId = new Map((await list<ChangeRequest>('changeRequests', u.ontologyId)).map((c) => [c.id, c]));
  for (const o of overrides) byId.set(o.id, o);
  const linked = new Set(u.changeRequestIds ?? []);
  return [...byId.values()].filter((c) => linked.has(c.id) || useCaseIdsForCR(c).includes(u.id)).sort((a, b) => a.number - b.number);
}

/** Compare dotted versions (1.10.0 > 1.9.0). */
const cmpVersion = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

/**
 * The release that completed a set of change requests: the latest published
 * release among those that shipped them (by version, then publication time),
 * not the one attached to the highest-numbered change request.
 */
export async function completingRelease(crs: ChangeRequest[]): Promise<Release | undefined> {
  const releases = (await Promise.all(crs.map(async (c) => (c.releaseId ? await get<Release>('releases', c.releaseId) : undefined))));
  if (releases.some((r) => !r || r.status !== 'published')) return undefined;
  return (releases as Release[]).sort((a, b) => cmpVersion(a.version, b.version) || (a.publishedAt ?? '').localeCompare(b.publishedAt ?? '')).at(-1);
}

/** Work out the status a use case should have from its change requests. Returns undefined if unchanged. */
export async function derivedStatus(u: UseCase, overrides: ChangeRequest[] = []): Promise<Pick<UseCase, 'status' | 'resolution'> | undefined> {
  if (MANUAL.includes(u.status) || u.status === 'triage') return undefined;
  // Closed by hand (e.g. already covered by existing terms): keep it.
  if (u.status === 'closed' && u.resolution && !u.resolution.releaseId) return undefined;
  const crs = await changeRequestsFor(u, overrides);
  if (!crs.length) return undefined;
  const live = crs.filter((c) => c.status !== 'rejected' && c.status !== 'withdrawn');
  let status: UseCaseStatus;
  let resolution = u.resolution;
  // A rejected or withdrawn change request may have been needed too, so shipping the others
  // doesn't prove the use case is covered: it stays addressed until an editor closes it.
  const dropped = crs.length > live.length;
  if (!live.length) status = 'accepted';
  else if (live.every((c) => c.status === 'released')) {
    const rel = dropped ? undefined : await completingRelease(live);
    if (rel) {
      status = 'closed';
      // Keep the original transition (and its timestamp) when nothing has really changed.
      resolution =
        u.status === 'closed' && u.resolution?.releaseId === rel.id
          ? u.resolution
          : { status: 'closed', at: rel.publishedAt ?? clock.iso(), releaseId: rel.id, version: rel.version, note: `Covered by ${live.map((c) => `#${c.number}`).join(', ')}` };
    } else status = 'addressed';
  } else if (live.every((c) => c.status === 'released' || c.status === 'merged')) status = 'addressed';
  else if (live.some((c) => ACTIVE.includes(c.status))) status = 'in-progress';
  else status = u.status;
  if (status === u.status && resolution === u.resolution) return undefined;
  return { status, resolution: status === 'closed' ? resolution : u.resolution?.releaseId ? undefined : u.resolution };
}

/** Apply derivedStatus and persist. Returns true if the use case changed. */
export async function syncUseCase(u: UseCase, overrides: ChangeRequest[] = []): Promise<boolean> { return transaction(async () => {
  const next = await derivedStatus(u, overrides);
  if (!next) return false;
  // Never write over a withdrawal made since this copy was read.
  if ((await get<UseCase>('useCases', u.id))?.withdrawnAt && !u.withdrawnAt) return false;
  const before = u.status;
  u.status = next.status;
  u.resolution = next.resolution;
  u.updatedAt = clock.iso();
  await put('useCases', u, u.ontologyId);
  if (next.status === 'closed' && before !== 'closed' && u.visibility !== 'private') {
    await logActivity({
      ontologyId: u.ontologyId,
      type: 'usecase.closed',
      message: `closed ${useCaseLabel(u)} ${u.sections.name ?? ''}${u.resolution?.version ? ` (covered in ${u.resolution.version})` : ''}`.trim(),
      link: `/o/${u.ontologyId}/use-cases/${u.id}`,
    });
  }
  return true;
}); }

/** Call whenever a change request's status changes (pass the in-memory copy, which may not be saved yet). */
export async function syncUseCasesForCR(cr: ChangeRequest) { return transaction(async () => {
  for (const id of useCaseIdsForCR(cr)) {
    const u = await get<UseCase>('useCases', id);
    if (u) await syncUseCase(u, [cr]);
  }
}); }
