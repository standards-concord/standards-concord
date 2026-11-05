import { needsPublicationApproval } from './changeRequests.js';
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
import { transaction, get, HttpError, list, mustGet, put } from '../db.js';
import { releasePageFiles, releaseRequirements, REQUIREMENTS_SNAPSHOT, snapshotFile } from '../public/routes.js';
import { anyHeld, dropHoldClaim, historyApproved, holdReleaseIfDraftHeld } from '../public/holds.js';
import { newId } from '../ids.js';
import { evaluate } from './governance.js';
import { getProject, members, requireRole, rolesFor, updateProject } from './ontologies.js';
import { ontologyStore } from './ontologyStore.js';
import { getUser, logActivity } from './users.js';

const LEVEL_ORDER: ChangeLevel[] = ['patch', 'minor', 'major'];
const maxLevel = (levels: ChangeLevel[]) => levels.reduce<ChangeLevel>((m, l) => (LEVEL_ORDER.indexOf(l) > LEVEL_ORDER.indexOf(m) ? l : m), 'patch');

export const getRelease = async (id: string) => await mustGet<Release>('releases', id);
export const listReleases = async (ontologyId: string) =>
  (await list<Release>('releases', ontologyId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const save = async (r: Release) => await put('releases', r, r.ontologyId);

const versionIRI = (p: OntologyProject, version: string) => `${p.ontologyIRI.replace(/[#/]$/, '')}/${version}`;

async function pendingChanges(ontologyId: string) {
  return (await list<ChangeRequest>('changeRequests', ontologyId))
    .filter((c) => c.status === 'merged' && !c.releaseId)
    .sort((a, b) => a.number - b.number);
}

export async function releaseGovernance(r: Release) {
  const project = await getProject(r.ontologyId);
  return evaluate({
    policy: project.governance,
    level: r.level,
    kind: 'release',
    status: r.status,
    statusSince: r.statusSince,
    reviewStartedAt: r.statusSince,
    authorId: r.createdBy,
    reviews: [],
    votes: await list<Vote>('votes', r.id),
    members: await members(r.ontologyId),
    validationOk: true,
    now: clock.now(),
  });
}

export async function releaseDetail(r: Release): Promise<ReleaseDetail> {
  const crs = (await Promise.all(r.changeRequestIds.map(async (id) => await mustGet<ChangeRequest>('changeRequests', id))));
  return {
    ...r,
    votes: await list<Vote>('votes', r.id),
    governance: await releaseGovernance(r),
    changeRequests: crs.map((c) => ({ id: c.id, number: c.number, title: c.title, classification: c.classification })),
  };
}

/**
 * Release notes are published. A request drafted from use cases appears in
 * them only as an editor approved it (the title and edit list they approved,
 * byte for byte); one merged without that approval, before it existed,
 * appears without its title or edits. Nothing is rewritten.
 */
const published = (c: ChangeRequest, text: string) => (!needsPublicationApproval(c) ? text : (c.privacyCleared?.title ?? 'Changes from use cases'));
const publishedEdits = (c: ChangeRequest) => (!needsPublicationApproval(c) ? (c.kgcl ?? []) : (c.privacyCleared?.kgcl ?? []));

/** Release notes grouped by level, from the merged change requests. */
function draftNotes(project: OntologyProject, crs: ChangeRequest[], level: ChangeLevel, version: string) {
  const by = (l: ChangeLevel) => crs.filter((c) => (c.classification?.level ?? 'minor') === l);
  const section = (title: string, items: ChangeRequest[]) =>
    items.length ? `### ${title}\n\n${items.map((c) => `- #${c.number} ${published(c, c.title)}${publishedEdits(c).length ? `\n${publishedEdits(c).slice(0, 6).map((k) => `  - \`${k}\``).join('\n')}` : ''}`).join('\n')}\n` : '';
  const header =
    level === 'major'
      ? `**Breaking release.** ${version} is not backward compatible with ${project.currentVersion}. Existing data may need migrating; a SPARQL migration script is included as \`migration.rq\`.`
      : `${version} is backward compatible with ${project.currentVersion}.`;
  return [header, section('Breaking changes', by('major')), section('New terms and features', by('minor')), section('Fixes and clarifications', by('patch'))]
    .filter(Boolean)
    .join('\n');
}

/** In one transaction, so two drafts started at once can't both find no draft and each create one. */
export async function draftRelease(project: OntologyProject, actor: User | undefined, notes?: string): Promise<Release> { return transaction(async () => {
  if (actor) await requireRole(project.id, actor, ['steward', 'owner'], 'draft a release');
  const existing = (await listReleases(project.id)).find((r) => r.status === 'draft' || r.status === 'voting');
  const crs = await pendingChanges(project.id);
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
  const allCrs = (await Promise.all(all.map(async (id) => await mustGet<ChangeRequest>('changeRequests', id))));
  r.changeRequestIds = all;
  r.level = maxLevel(allCrs.map((c) => c.classification?.level ?? 'minor'));
  r.version = bumpVersion(project.currentVersion, r.level);
  r.versionIRI = versionIRI(project, r.version);
  r.notes = notes ?? draftNotes(project, allCrs, r.level, r.version);
  // Notes a steward wrote are theirs to publish; drafted ones are rebuilt as the release is published.
  r.notesBy = notes !== undefined && actor ? actor.id : undefined;
  await save(r);
  if (!existing) {
    await logActivity({ ontologyId: project.id, actorId: actor?.id, type: 'release.drafted', message: `drafted release ${r.version} (${r.level})`, link: `/o/${project.id}/releases/${r.id}` });
  }
  return await openVoteIfNeeded(r);
}); }

/** If the policy needs a vote for this level, open it; otherwise the release is ready to publish. */
async function openVoteIfNeeded(r: Release): Promise<Release> { return transaction(async () => {
  const g = await releaseGovernance(r);
  if (r.status === 'draft' && g.rule.vote) {
    r.status = 'voting';
    r.statusSince = clock.iso();
    await save(r);
    await logActivity({ ontologyId: r.ontologyId, type: 'release.vote', message: `vote opened on release ${r.version} (${g.rule.vote.durationDays} days, quorum ${Math.round(g.rule.vote.quorum * 100)}%)`, link: `/o/${r.ontologyId}/releases/${r.id}` });
  }
  return r;
}); }

export async function voteOnRelease(r: Release, actor: User, choice: Vote['choice'], comment?: string) {
  if (r.status !== 'voting') throw new HttpError(409, 'There is no open vote on this release');
  const g = await releaseGovernance(r);
  const roles = await rolesFor(r.ontologyId, actor.id);
  if (!roles.some((role) => g.rule.vote?.voterRoles.includes(role))) throw new HttpError(403, `Only ${g.rule.vote?.voterRoles.join(' / ')} can vote on releases`);
  const vote: Vote = { id: newId('vote'), subjectType: 'release', subjectId: r.id, userId: actor.id, roles, choice, comment, at: clock.iso() };
  await put('votes', vote, r.id);
  await logActivity({ ontologyId: r.ontologyId, actorId: actor.id, type: 'release.voted', message: `voted ${choice} on release ${r.version}`, link: `/o/${r.ontologyId}/releases/${r.id}` });
  return advanceRelease(r);
}

export async function advanceRelease(r: Release): Promise<Release> {
  if (r.status !== 'voting') return r;
  const g = await releaseGovernance(r);
  if (g.outcome === 'rejected') {
    r.status = 'rejected';
    r.statusSince = clock.iso();
    await save(r);
    await logActivity({ ontologyId: r.ontologyId, type: 'release.rejected', message: `release ${r.version} was not approved`, link: `/o/${r.ontologyId}/releases/${r.id}` });
  } else if (g.outcome === 'approved' && (await getProject(r.ontologyId)).governance.releases[r.level].autoMerge) {
    return publishRelease(r, undefined);
  }
  return r;
}

/** Can this release be published now? (approved vote, or no vote needed) */
async function publishable(r: Release) {
  if (r.status === 'draft') return { ok: true, why: '' };
  if (r.status !== 'voting') return { ok: false, why: `Release is ${r.status}` };
  const g = await releaseGovernance(r);
  return g.outcome === 'approved' ? { ok: true, why: '' } : { ok: false, why: g.unmet.join('; ') || g.next };
}

export async function publishRelease(r: Release, actor: User | undefined): Promise<Release> {
  if (actor) await requireRole(r.ontologyId, actor, ['steward', 'owner'], 'publish releases');
  const can = await publishable(r);
  if (!can.ok) throw new HttpError(409, `Not ready to publish: ${can.why}`);
  const project = await getProject(r.ontologyId);
  // What this release captures: if the working draft changes before it's written, nothing is published.
  const capturedHead = ontologyStore.head(project);
  const capturedText = ontologyStore.readWorkingText(project);
  const working = await ontologyStore.working(project);
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
  // Drafted notes are rebuilt now, from what editors approved (a draft made before approval existed
  // never reaches the page); notes a steward wrote are published as they wrote them.
  if (!r.notesBy) r.notes = draftNotes(project, (await Promise.all(r.changeRequestIds.map(async (id) => await mustGet<ChangeRequest>('changeRequests', id)))), r.level, r.version);
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

  const author = actor ?? await getUser(r.createdBy);
  // Published commits carry no names.
  // Made from a working draft still waiting for approval: it waits too, from before its files exist, so the
  // public never sees it unheld. Recorded first because writeRelease's check below has to be synchronous.
  const held = await holdReleaseIfDraftHeld(project, r.version);
  // From the moment the check passes, files may be written: after that a failure must never take the hold back.
  let writing = false;
  try {
    r.commit = await ontologyStore.writeRelease(project, r.version, stamped, files, r.notes, { name: 'Concord' }, () => {
      // Checked with nothing awaited before the write: the release is exactly the draft captured above. If the
      // draft changed meanwhile (a merge, say), publishing would overwrite it and release what nobody approved.
      if (ontologyStore.head(project) !== capturedHead || ontologyStore.readWorkingText(project) !== capturedText)
        throw new HttpError(409, 'The working draft changed while this release was being prepared. Publish it again.');
      writing = true;
    });
  } finally {
    if (held) await dropHoldClaim(project, r.version, writing);
  }
  r.status = 'published';
  r.publishedAt = clock.iso();
  r.statusSince = r.publishedAt;

  // Mark change requests as released.
  for (const id of r.changeRequestIds) {
    const cr = await mustGet<ChangeRequest>('changeRequests', id);
    cr.status = 'released';
    cr.releaseId = r.id;
    cr.statusSince = r.publishedAt;
    cr.timeline.push({ at: r.publishedAt, type: 'released', message: `released in ${r.version}` });
    await put('changeRequests', cr, cr.ontologyId);
  }

  project.currentVersion = r.version;
  project.stage = 'released';
  await updateProject(project);

  // Public ontologies are persisted to GitHub on release, when configured.
  // Pushing sends main and every tag, so its whole history. Nothing leaves Concord while a version is waiting for
  // approval, and an ontology from before approvals is never pushed: its history holds what nobody approved.
  if (project.github && config.github.publishToken && (await anyHeld(project) || !await historyApproved(project))) {
    console.log(`[release] not pushing ${project.slug} to GitHub: ${await anyHeld(project) ? 'a version is waiting for a steward’s approval' : 'its history predates publication approval'}`);
  } else if (project.github && config.github.publishToken) {
    try {
      const remote = `https://x-access-token:${config.github.publishToken}@github.com/${project.github.repo}.git`;
      ontologyStore.push(project, remote);
      r.githubUrl = `https://github.com/${project.github.repo}/releases/tag/v${r.version}`;
    } catch (err) {
      console.warn(`[release] GitHub push failed: ${(err as Error).message.replace(config.github.publishToken, '***')}`);
    }
  }
  await save(r);
  await logActivity({ ontologyId: r.ontologyId, actorId: actor?.id, type: 'release.published', message: `published ${project.title} ${r.version}`, link: `/o/${r.ontologyId}/releases/${r.id}` });
  return r;
}

/** Periodic: close votes; auto-draft releases when the policy asks for it. */
export async function releaseTick(): Promise<number> {
  let changed = 0;
  for (const r of (await list<Release>('releases')).filter((x) => x.status === 'voting')) {
    const before = r.status;
    if ((await advanceRelease(r)).status !== before) changed++;
  }
  for (const p of await list<OntologyProject>('ontologies')) {
    if (!p.governance.automation.autoDraftRelease) continue;
    if (!(await pendingChanges(p.id)).length) continue;
    if ((await listReleases(p.id)).some((r) => r.status === 'draft' || r.status === 'voting')) continue;
    await draftRelease(p, undefined);
    changed++;
  }
  return changed;
}

