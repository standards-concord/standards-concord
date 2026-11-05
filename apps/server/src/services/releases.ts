import {
  bumpVersion,
  diffOntologies,
  FORMAT_INFO,
  migrationSparql,
  serialize,
  stampRelease,
} from '@concord/core';
import type { ChangeLevel, OutputFormat } from '@concord/core/types';
import type { ChangeRequest, OntologyProject, Release, ReleaseDetail, User, Vote } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { HttpError, list, mustGet, put, transaction } from '../db.js';
import { releasePageFiles, releaseRequirements, REQUIREMENTS_SNAPSHOT, snapshotFile } from '../public/routes.js';
import { newId } from '../ids.js';
import { markReleased } from './changeRequests.js';
import { assertStillHeld, withWorkingDraftLock } from './repoLock.js';
import { evaluate } from './governance.js';
import { getProject, members, requireRole, rolesFor, updateProject } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { getUser, logActivity } from './users.js';

const LEVEL_ORDER: ChangeLevel[] = ['patch', 'minor', 'major'];
const maxLevel = (levels: ChangeLevel[]) => levels.reduce<ChangeLevel>((m, l) => (LEVEL_ORDER.indexOf(l) > LEVEL_ORDER.indexOf(m) ? l : m), 'patch');

export const getRelease = (id: string) => mustGet<Release>('releases', id);
export const listReleases = (ontologyId: string) =>
  list<Release>('releases', ontologyId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
/**
 * Writes a release if it is still at the revision it was read at, bumping the
 * revision: a compare-and-swap, so a writer holding a copy read before someone
 * else's write (a publication, a vote closing) can never write over it.
 */
const save = (r: Release) =>
  transaction(() => {
    const stored = mustGet<Release>('releases', r.id);
    if ((stored.rev ?? 0) !== (r.rev ?? 0)) throw new HttpError(409, `Release ${r.version} was changed by someone else meanwhile. Reload it and try again.`);
    r.rev = (stored.rev ?? 0) + 1;
    return put('releases', r, r.ontologyId);
  });
/** Saves a new release (no stored copy to compare with yet). */
const create = (r: Release) =>
  transaction(() => {
    if (list<Release>('releases', r.ontologyId).some((x) => x.id === r.id)) throw new HttpError(409, 'Release already exists');
    r.rev = 1;
    return put('releases', r, r.ontologyId);
  });

const versionIRI = (p: OntologyProject, version: string) => `${p.ontologyIRI.replace(/[#/]$/, '')}/${version}`;

function pendingChanges(ontologyId: string) {
  return list<ChangeRequest>('changeRequests', ontologyId)
    .filter((c) => c.status === 'merged' && !c.releaseId)
    .sort((a, b) => a.number - b.number);
}

export function releaseGovernance(r: Release) {
  const project = getProject(r.ontologyId);
  return evaluate({
    policy: project.governance,
    level: r.level,
    kind: 'release',
    status: r.status,
    statusSince: r.statusSince,
    reviewStartedAt: r.statusSince,
    authorId: r.createdBy,
    reviews: [],
    votes: list<Vote>('votes', r.id),
    members: members(r.ontologyId),
    validationOk: true,
    now: clock.now(),
  });
}

export function releaseDetail(r: Release): ReleaseDetail {
  const crs = r.changeRequestIds.map((id) => mustGet<ChangeRequest>('changeRequests', id));
  return {
    ...r,
    votes: list<Vote>('votes', r.id),
    governance: releaseGovernance(r),
    changeRequests: crs.map((c) => ({ id: c.id, number: c.number, title: c.title, classification: c.classification })),
  };
}

/** Release notes grouped by level, from the merged change requests. */
function draftNotes(project: OntologyProject, crs: ChangeRequest[], level: ChangeLevel, version: string) {
  const by = (l: ChangeLevel) => crs.filter((c) => (c.classification?.level ?? 'minor') === l);
  const section = (title: string, items: ChangeRequest[]) =>
    items.length ? `### ${title}\n\n${items.map((c) => `- #${c.number} ${c.title}${c.kgcl?.length ? `\n${c.kgcl.slice(0, 6).map((k) => `  - \`${k}\``).join('\n')}` : ''}`).join('\n')}\n` : '';
  const header =
    level === 'major'
      ? `**Breaking release.** ${version} is not backward compatible with ${project.currentVersion}. Existing data may need migrating; a SPARQL migration script is included as \`migration.rq\`.`
      : `${version} is backward compatible with ${project.currentVersion}.`;
  return [header, section('Breaking changes', by('major')), section('New terms and features', by('minor')), section('Fixes and clarifications', by('patch'))]
    .filter(Boolean)
    .join('\n');
}

export async function draftRelease(project: OntologyProject, actor: User | undefined, notes?: string): Promise<Release> {
  if (actor) requireRole(project.id, actor, ['steward', 'owner'], 'draft a release');
  const existing = listReleases(project.id).find((r) => r.status === 'draft' || r.status === 'voting');
  const crs = pendingChanges(project.id);
  if (!crs.length && !existing) throw new HttpError(409, 'There are no merged changes waiting to be released');
  const level = maxLevel(crs.map((c) => c.classification?.level ?? 'minor'));
  const version = bumpVersion(project.currentVersion, level);
  const now = clock.iso();
  const r: Release = existing ?? {
    id: newId('rel'),
    ontologyId: project.id,
    version,
    level,
    status: 'draft',
    changeRequestIds: [],
    notes: '',
    versionIRI: versionIRI(project, version),
    createdBy: actor?.id ?? 'system',
    createdAt: now,
    statusSince: now,
  };
  if (existing && existing.status === 'voting' && crs.some((c) => !existing.changeRequestIds.includes(c.id)))
    throw new HttpError(409, `Release ${existing.version} is being voted on; publish or reject it first`);
  // A draft always reflects everything merged so far.
  const all = [...new Set([...r.changeRequestIds, ...crs.map((c) => c.id)])];
  const allCrs = all.map((id) => mustGet<ChangeRequest>('changeRequests', id));
  r.changeRequestIds = all;
  r.level = maxLevel(allCrs.map((c) => c.classification?.level ?? 'minor'));
  r.version = bumpVersion(project.currentVersion, r.level);
  r.versionIRI = versionIRI(project, r.version);
  r.notes = notes ?? draftNotes(project, allCrs, r.level, r.version);
  if (existing) save(r);
  else create(r);
  if (!existing) {
    logActivity({ ontologyId: project.id, actorId: actor?.id, type: 'release.drafted', message: `drafted release ${r.version} (${r.level})`, link: `/o/${project.id}/releases/${r.id}` });
  }
  return openVoteIfNeeded(r);
}

/** If the policy needs a vote for this level, open it; otherwise the release is ready to publish. */
function openVoteIfNeeded(r: Release): Release {
  const g = releaseGovernance(r);
  if (r.status === 'draft' && g.rule.vote) {
    r.status = 'voting';
    r.statusSince = clock.iso();
    save(r);
    logActivity({ ontologyId: r.ontologyId, type: 'release.vote', message: `vote opened on release ${r.version} (${g.rule.vote.durationDays} days, quorum ${Math.round(g.rule.vote.quorum * 100)}%)`, link: `/o/${r.ontologyId}/releases/${r.id}` });
  }
  return r;
}

export async function voteOnRelease(stale: Release, actor: User, choice: Vote['choice'], comment?: string) {
  const roles = rolesFor(stale.ontologyId, actor.id);
  // The vote only counts on the release as it is stored now, checked in the same transaction it is written in:
  // a vote begun before the release was published (or closed) is refused, not recorded against it.
  const r = transaction(() => {
    const now = mustGet<Release>('releases', stale.id);
    if (now.status !== 'voting') throw new HttpError(409, 'There is no open vote on this release');
    const g = releaseGovernance(now);
    if (!roles.some((role) => g.rule.vote?.voterRoles.includes(role))) throw new HttpError(403, `Only ${g.rule.vote?.voterRoles.join(' / ')} can vote on releases`);
    put('votes', { id: newId('vote'), subjectType: 'release', subjectId: now.id, userId: actor.id, roles, choice, comment, at: clock.iso() } satisfies Vote, now.id);
    return now;
  });
  logActivity({ ontologyId: r.ontologyId, actorId: actor.id, type: 'release.voted', message: `voted ${choice} on release ${r.version}`, link: `/o/${r.ontologyId}/releases/${r.id}` });
  return Object.assign(stale, await advanceRelease(r));
}

export async function advanceRelease(stale: Release): Promise<Release> {
  // Decided and written in one transaction, from the stored release and its votes as they are now.
  const r = transaction(() => {
    const now = mustGet<Release>('releases', stale.id);
    if (now.status !== 'voting' || releaseGovernance(now).outcome !== 'rejected') return now;
    now.status = 'rejected';
    now.statusSince = clock.iso();
    save(now);
    logActivity({ ontologyId: now.ontologyId, type: 'release.rejected', message: `release ${now.version} was not approved`, link: `/o/${now.ontologyId}/releases/${now.id}` });
    return now;
  });
  if (r.status === 'voting' && releaseGovernance(r).outcome === 'approved' && getProject(r.ontologyId).governance.releases[r.level].autoMerge) return publishRelease(r, undefined);
  return Object.assign(stale, r);
}

/** What a published release is made from: if any of it changes while publishing, the files would no longer match. */
const releaseSnapshot = (r: Release) => JSON.stringify([r.status, r.version, r.level, r.notes, r.versionIRI, r.changeRequestIds]);

/** Can this release be published now? (approved vote, or no vote needed) */
function publishable(r: Release) {
  if (r.status === 'draft') return { ok: true, why: '' };
  if (r.status !== 'voting') return { ok: false, why: `Release is ${r.status}` };
  const g = releaseGovernance(r);
  return g.outcome === 'approved' ? { ok: true, why: '' } : { ok: false, why: g.unmet.join('; ') || g.next };
}

export async function publishRelease(r: Release, actor: User | undefined): Promise<Release> {
  if (actor) requireRole(r.ontologyId, actor, ['steward', 'owner'], 'publish releases');
  // Holding the working-draft lock from reading the draft to committing the
  // release, so no merge can land in between (and be erased by the release).
  return withWorkingDraftLock(getProject(r.ontologyId), () => publishNow(r, actor));
}

async function publishNow(stale: Release, actor: User | undefined): Promise<Release> {
  // A fresh read under the lock: another publisher may have published it while this one waited.
  const r = mustGet<Release>('releases', stale.id);
  const can = publishable(r);
  if (!can.ok) throw new HttpError(409, `Not ready to publish: ${can.why}`);
  const snapshot = releaseSnapshot(r);
  const project = getProject(r.ontologyId);
  const { graph: working, head: base } = await ontologyStore.workingAt(project);
  const priorVersion = project.currentVersion !== '0.0.0' ? project.currentVersion : undefined;
  const stamped = stampRelease(working, {
    version: r.version,
    priorVersionIRI: priorVersion ? versionIRI(project, priorVersion) : undefined,
    level: r.level,
    date: clock.iso().slice(0, 10),
    backwardCompatible: r.level !== 'major',
  });

  const files: Record<string, string> = {};
  for (const format of Object.keys(FORMAT_INFO) as OutputFormat[]) {
    if (format === 'turtle') continue;
    try {
      files[`ontology.${FORMAT_INFO[format].extension}`] = await serialize(stamped, format, { name: project.slug });
    } catch (err) {
      console.warn(`[release] could not serialise ${format}: ${(err as Error).message}`);
    }
  }
  if (r.level === 'major' && priorVersion) {
    try {
      const prior = await ontologyStore.at(project, priorVersion);
      files['migration.rq'] = migrationSparql(prior, stamped, diffOntologies(prior, stamped));
    } catch (err) {
      console.warn(`[release] migration script: ${(err as Error).message}`);
    }
  }
  files['RELEASE_NOTES.md'] = `# ${project.title} ${r.version}\n\nVersion IRI: <${r.versionIRI}>\n\n${r.notes}\n`;
  // The use case snapshot always goes in, so the release never shows live data;
  // a rendering failure only costs the stored page (served pages render on request).
  const requirements = releaseRequirements(project, r.version);
  files[REQUIREMENTS_SNAPSHOT] = snapshotFile(requirements);
  try {
    Object.assign(files, await releasePageFiles(project, { ...r, publishedAt: clock.iso() }, stamped, requirements));
  } catch (err) {
    console.warn(`[release] public page: ${(err as Error).message}`);
  }

  const author = actor ?? getUser(r.createdBy);
  assertStillHeld(project);
  const publishedAt = clock.iso();
  // The release commit, the release's record, its requests' statuses and the
  // ontology's current version are written in one transaction, only if the
  // draft is still the one released and the release is still unpublished
  // (see ontologyStore.advanceTo). The tag follows from the database.
  await ontologyStore.writeRelease(project, r.version, stamped, files, r.notes, { name: author?.name ?? 'Concord' }, base, (commit) => {
    // Still exactly the release these files were made from, and still approved (a vote may have changed meanwhile).
    const latest = mustGet<Release>('releases', r.id);
    if (latest.status === 'published') throw new HttpError(409, `${r.version} has already been published`);
    if (releaseSnapshot(latest) !== snapshot) throw new HttpError(409, 'The release changed while it was being published, so it was not published. Try again.');
    const now = publishable(latest);
    if (!now.ok) throw new HttpError(409, `No longer ready to publish: ${now.why}`);
    Object.assign(r, latest, { commit, status: 'published', publishedAt, statusSince: publishedAt });
    save(r);
    for (const id of r.changeRequestIds) markReleased(id, r.id, r.version, publishedAt);
    const p = getProject(r.ontologyId);
    p.currentVersion = r.version;
    p.stage = 'released';
    updateProject(p);
  });
  Object.assign(project, getProject(r.ontologyId));

  // Public ontologies are persisted to GitHub on release, when configured.
  if (project.github && config.github.publishToken) {
    try {
      const remote = `https://x-access-token:${config.github.publishToken}@github.com/${project.github.repo}.git`;
      ontologyStore.push(project, remote);
      const githubUrl = `https://github.com/${project.github.repo}/releases/tag/v${r.version}`;
      // Only the link is added, to the release as stored now.
      Object.assign(r, transaction(() => save({ ...mustGet<Release>('releases', r.id), githubUrl })));
    } catch (err) {
      console.warn(`[release] GitHub push failed: ${(err as Error).message.replace(config.github.publishToken, '***')}`);
    }
  }
  logActivity({ ontologyId: r.ontologyId, actorId: actor?.id, type: 'release.published', message: `published ${project.title} ${r.version}`, link: `/o/${r.ontologyId}/releases/${r.id}` });
  return Object.assign(stale, r);
}

/** Periodic: close votes; auto-draft releases when the policy asks for it. */
export async function releaseTick(): Promise<number> {
  let changed = 0;
  for (const r of list<Release>('releases').filter((x) => x.status === 'voting')) {
    const before = r.status;
    if ((await advanceRelease(r)).status !== before) changed++;
  }
  for (const p of list<OntologyProject>('ontologies')) {
    if (!p.governance.automation.autoDraftRelease) continue;
    if (!pendingChanges(p.id).length) continue;
    if (listReleases(p.id).some((r) => r.status === 'draft' || r.status === 'voting')) continue;
    await draftRelease(p, undefined);
    changed++;
  }
  return changed;
}

