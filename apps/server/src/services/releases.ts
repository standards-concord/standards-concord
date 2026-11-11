import { needsPublicationApproval } from './changeRequests.js';
import {
  bumpVersion,
  exampleFiles,
  diffOntologies,
  FORMAT_INFO,
  migrationSparql,
  serialize,
  stampRelease,
} from '@concord/core';
import type { ChangeLevel, OutputFormat } from '@concord/core/types';
import type { ChangeRequest, GovernanceEvaluation, OntologyProject, Release, ReleaseApprovalSource, ReleaseDetail, User, Vote } from '@concord/shared';
import { canCastVote } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, list, mustGet, put, transaction } from '../db.js';
import { releasePageFiles, releaseRequirements, REQUIREMENTS_SNAPSHOT, snapshotFile } from '../public/routes.js';
import { liveExamples } from '../public/examples.js';
import { anyHeld, historyApproved, holdReleaseIfDraftHeld } from '../public/holds.js';
import { newId } from '../ids.js';
import { markReleased, withOntologyLocks } from './changeRequests.js';
import { assertStillHeld, withWorkingDraftLock } from './repoLock.js';
import { evaluate } from './governance.js';
import { getProject, members, requireRole, rolesFor, updateProject } from './ontologies.js';
import { enqueueGitHubPublish, runGitHubPublish, runGitHubPublishes } from './githubOutbox.js';
import { ontologyStore } from './ontologyStore.js';
import { draftForRelease, markPublished, prepareForRelease, renderMarkdown, stillPublishable, withdrawnSince } from './requirements.js';
import { crForViewer, crWithheld, withConsentLock } from './useCases.js';
import { someAsync } from '../asyncList.js';
import { syncUseCasesForCR } from './traceability.js';
import { logActivity } from './users.js';

const LEVEL_ORDER: ChangeLevel[] = ['patch', 'minor', 'major'];
const maxLevel = (levels: ChangeLevel[]) => levels.reduce<ChangeLevel>((m, l) => (LEVEL_ORDER.indexOf(l) > LEVEL_ORDER.indexOf(m) ? l : m), 'patch');

export const getRelease = async (id: string) => await mustGet<Release>('releases', id);
export const listReleases = async (ontologyId: string) =>
  (await list<Release>('releases', ontologyId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
/**
 * Writes a release if it is still at the revision it was read at, bumping the
 * revision: a compare-and-swap, so a writer holding a copy read before someone
 * else's write (a publication, a vote closing) can never write over it.
 */
const save = async (r: Release) =>
  await transaction(async () => {
    const stored = await mustGet<Release>('releases', r.id);
    if ((stored.rev ?? 0) !== (r.rev ?? 0)) throw new HttpError(409, `Release ${r.version} was changed by someone else meanwhile. Reload it and try again.`);
    r.rev = (stored.rev ?? 0) + 1;
    return await put('releases', r, r.ontologyId);
  });
/** Saves a new release (no stored copy to compare with yet). */
const create = async (r: Release) =>
  await transaction(async () => {
    if ((await list<Release>('releases', r.ontologyId)).some((x) => x.id === r.id)) throw new HttpError(409, 'Release already exists');
    r.rev = 1;
    return await put('releases', r, r.ontologyId);
  });

const versionIRI = (p: OntologyProject, version: string) => `${p.ontologyIRI.replace(/[#/]$/, '')}/${version}`;

async function pendingChanges(ontologyId: string) {
  return (await list<ChangeRequest>('changeRequests', ontologyId))
    .filter((c) => c.status === 'merged' && !c.releaseId)
    .sort((a, b) => a.number - b.number);
}

/** Evaluate a release against today's policy. `until` leaves out votes cast after that time (a decision already made). */
export async function releaseGovernance(r: Release, until?: string) {
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
    votes: (await list<Vote>('votes', r.id)).filter((v) => !until || v.at <= until),
    members: await members(r.ontologyId),
    validationOk: true,
    now: clock.now(),
  });
}

/** A decided release shows the evaluation recorded at the time; only open releases are evaluated live. */
export async function releaseApproval(r: Release): Promise<{ governance: GovernanceEvaluation; approvalSource: ReleaseApprovalSource }> {
  const decided = r.status === 'published' || r.status === 'rejected';
  if (!decided) return { governance: await releaseGovernance(r), approvalSource: 'live' };
  if (r.approval) return { governance: r.approval, approvalSource: 'recorded' };
  // No record: re-evaluate with today's policy, but only with the votes cast before the decision.
  const decidedAt = r.status === 'published' ? (r.publishedAt ?? r.statusSince) : r.statusSince;
  const governance = await releaseGovernance(r, decidedAt);
  // Releases are only drafted from merged changes, so a published release with none is the set-up release.
  if (r.status === 'published' && !r.changeRequestIds.length) return { governance, approvalSource: 'bootstrap' };
  return { governance, approvalSource: 'current-policy' };
}

/**
 * A release as a viewer may see it. Its notes list its change requests by title, so when one of
 * them is withheld from the viewer (a use case it came from is no longer shared with them), the
 * notes they see are written again from the requests as they may see them. Stored notes are kept.
 */
/** Which of a release's change requests are withheld from the public right now (a key to compare). */
async function withheldNow(r: Release) {
  const out: string[] = [];
  for (const id of r.changeRequestIds) {
    const c = await get<ChangeRequest>('changeRequests', id);
    if (c && (await crWithheld(c, undefined))) out.push(id);
  }
  return out.join(' ');
}

export async function releaseForViewer(r: Release, viewer?: User): Promise<Release> {
  const crs = (await Promise.all(r.changeRequestIds.map((id) => get<ChangeRequest>('changeRequests', id)))).filter((c): c is ChangeRequest => !!c);
  if (!await someAsync(crs, (c) => crWithheld(c, viewer))) return r;
  return { ...r, notes: draftNotes(await getProject(r.ontologyId), await Promise.all(crs.map((c) => crForViewer(c, viewer))), r.level, r.version, 'the previous release') };
}

export async function releaseDetail(r: Release, viewer?: User): Promise<ReleaseDetail> {
  const crs = (await Promise.all(r.changeRequestIds.map(async (id) => await crForViewer(await mustGet<ChangeRequest>('changeRequests', id), viewer))));
  return {
    ...await releaseForViewer(r, viewer),
    votes: await list<Vote>('votes', r.id),
    ...(await releaseApproval(r)),
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
function draftNotes(project: OntologyProject, crs: ChangeRequest[], level: ChangeLevel, version: string, prior: string = project.currentVersion) {
  const by = (l: ChangeLevel) => crs.filter((c) => (c.classification?.level ?? 'minor') === l);
  const section = (title: string, items: ChangeRequest[]) =>
    items.length ? `### ${title}\n\n${items.map((c) => `- #${c.number} ${published(c, c.title)}${publishedEdits(c).length ? `\n${publishedEdits(c).slice(0, 6).map((k) => `  - \`${k}\``).join('\n')}` : ''}`).join('\n')}\n` : '';
  const header =
    level === 'major'
      ? `**Breaking release.** ${version} is not backward compatible with ${prior}. Existing data may need migrating; a SPARQL migration script is included as \`migration.rq\`.`
      : `${version} is backward compatible with ${prior}.`;
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
  if (existing) await save(r);
  else await create(r);
  if (!existing) {
    await logActivity({ ontologyId: project.id, actorId: actor?.id, type: 'release.drafted', message: `drafted release ${r.version} (${r.level})`, link: `/o/${project.id}/releases/${r.id}` });
  }
  // Keep the release's use cases and requirements document in step (in the background).
  draftForRelease(r);
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

export async function voteOnRelease(stale: Release, actor: User, choice: Vote['choice'], comment?: string) {
  const roles = await rolesFor(stale.ontologyId, actor.id);
  // The vote only counts on the release as it is stored now, checked in the same transaction it is written in:
  // a vote begun before the release was published (or closed) is refused, not recorded against it.
  const r = await transaction(async () => {
    const now = await mustGet<Release>('releases', stale.id);
    if (now.status !== 'voting') throw new HttpError(409, 'There is no open vote on this release');
    const g = await releaseGovernance(now);
    if (!g.rule.vote || !canCastVote(roles, g.rule.vote.voterRoles)) throw new HttpError(403, `Only ${g.rule.vote?.voterRoles.join(' / ')} can vote on releases`);
    await put('votes', { id: newId('vote'), subjectType: 'release', subjectId: now.id, userId: actor.id, roles, choice, comment, at: clock.iso() } satisfies Vote, now.id);
    return now;
  });
  await logActivity({ ontologyId: r.ontologyId, actorId: actor.id, type: 'release.voted', message: `voted ${choice} on release ${r.version}`, link: `/o/${r.ontologyId}/releases/${r.id}` });
  return Object.assign(stale, await advanceRelease(r));
}

export async function advanceRelease(stale: Release): Promise<Release> {
  // Decided and written in one transaction, from the stored release and its votes as they are now.
  const r = await transaction(async () => {
    const now = await mustGet<Release>('releases', stale.id);
    if (now.status !== 'voting') return now;
    const g = await releaseGovernance(now);
    if (g.outcome !== 'rejected') return now;
    // Recorded with the rejection: the decision exactly as it was made, in this transaction.
    now.approval = g;
    now.status = 'rejected';
    now.statusSince = clock.iso();
    await save(now);
    await logActivity({ ontologyId: now.ontologyId, type: 'release.rejected', message: `release ${now.version} was not approved`, link: `/o/${now.ontologyId}/releases/${now.id}` });
    return now;
  });
  if (r.status === 'voting' && (await releaseGovernance(r)).outcome === 'approved' && (await getProject(r.ontologyId)).governance.releases[r.level].autoMerge) return publishRelease(r, undefined);
  return Object.assign(stale, r);
}

/** What a published release is made from: if any of it changes while publishing, the files would no longer match. */
const releaseSnapshot = (r: Release) => JSON.stringify([r.status, r.version, r.level, r.notes, r.versionIRI, r.changeRequestIds]);

/**
 * Can this release be published now? (approved vote, or no vote needed). The evaluation that decides it is
 * read in one transaction (policy, votes and members from the same moment) and returned, so the approval
 * recorded on the release is exactly the one that allowed it, never a later re-read.
 */
async function publishable(r: Release): Promise<{ ok: boolean; why: string; approval: GovernanceEvaluation }> {
  const approval = await transaction(() => releaseGovernance(r));
  if (r.status === 'draft') return { ok: true, why: '', approval };
  if (r.status !== 'voting') return { ok: false, why: `Release is ${r.status}`, approval };
  return approval.outcome === 'approved' ? { ok: true, why: '', approval } : { ok: false, why: approval.unmet.join('; ') || approval.next, approval };
}

export async function publishRelease(r: Release, actor: User | undefined): Promise<Release> {
  if (actor) await requireRole(r.ontologyId, actor, ['steward', 'owner'], 'publish releases');
  // Holding the working-draft lock from reading the draft to committing the
  // release, so no merge can land in between (and be erased by the release).
  // The consent lock is taken first (withOntologyLocks): no use case can be withdrawn while it is published.
  return withOntologyLocks(r.ontologyId, () => publishNow(r, actor));
}

async function publishNow(stale: Release, actor: User | undefined): Promise<Release> {
  // A fresh read under the lock: another publisher may have published it while this one waited.
  const r = await mustGet<Release>('releases', stale.id);
  const can = await publishable(r);
  if (!can.ok) throw new HttpError(409, `Not ready to publish: ${can.why}`);
  const snapshot = releaseSnapshot(r);
  const project = await getProject(r.ontologyId);
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
  // Drafted notes are rebuilt now, from what editors approved (a draft made before approval existed
  // never reaches the page); notes a steward wrote are published as they wrote them.
  if (!r.notesBy) r.notes = draftNotes(project, (await Promise.all(r.changeRequestIds.map(async (id) => await mustGet<ChangeRequest>('changeRequests', id)))), r.level, r.version);
  // What goes into the public files is what anyone may see: nothing from a use case withdrawn since. The
  // consent lock is held for all of this (publishRelease), so nothing can be withdrawn before the commit.
  // Read together, under the writer lock, so a withdrawal can't land between the notes and the baseline they are
  // checked against when the release commits.
  const [publicNotes, withheldInNotes] = await transaction(async () => [(await releaseForViewer(r, undefined)).notes, await withheldNow(r)] as const);
  files['RELEASE_NOTES.md'] = `# ${project.title} ${r.version}\n\nVersion IRI: <${r.versionIRI}>\n\n${publicNotes}\n`;
  const doc = await prepareForRelease(project, r);
  if (doc) files['USE_CASES.md'] = renderMarkdown(doc);
  // The use case snapshot always goes in, so the release never shows live data;
  // a rendering failure only costs the stored page (served pages render on request).
  const requirements = await releaseRequirements(project, r.version);
  files[REQUIREMENTS_SNAPSHOT] = snapshotFile(requirements);
  const examples = await liveExamples(project, stamped);
  Object.assign(files, exampleFiles(examples, stamped.ontologyIRI));
  // Every use case the snapshot shows or cites, checked again where the release commits.
  const represented = [...new Set([...requirements.useCases.map((u) => u.id), ...examples.map((e) => e.source), ...(requirements.document?.requirements ?? []).flatMap((q) => q.useCaseIds), ...(requirements.document?.sections ?? []).flatMap((x) => x.useCaseIds ?? [])])];
  try {
    Object.assign(files, await releasePageFiles(project, { ...r, notes: publicNotes, publishedAt: clock.iso() }, stamped, requirements, examples));
  } catch (err) {
    console.warn(`[release] public page: ${(err as Error).message}`);
  }

  await assertStillHeld(project);
  const publishedAt = clock.iso();
  const publishedNotes = r.notes;
  // The release commit, the release's record, its requests' statuses and the
  // ontology's current version are written in one transaction, only if the
  // draft is still the one released (so nothing merged meanwhile is
  // overwritten) and the release is still unpublished (see
  // ontologyStore.advanceTo). The tag follows from the database. Published
  // commits carry no names.
  await ontologyStore.writeRelease(project, r.version, stamped, files, publicNotes, { name: 'Concord' }, base, async (commit) => {
    // Still exactly the release these files were made from, and still approved (a vote may have changed meanwhile).
    const latest = await mustGet<Release>('releases', r.id);
    if (latest.status === 'published') throw new HttpError(409, `${r.version} has already been published`);
    if (releaseSnapshot(latest) !== snapshot) throw new HttpError(409, 'The release changed while it was being published, so it was not published. Try again.');
    // This check, in the transaction that publishes, is the approval recorded on the release.
    const now = await publishable(latest);
    if (!now.ok) throw new HttpError(409, `No longer ready to publish: ${now.why}`);
    // Consent once more, where no withdrawal can land in between (it commits in a transaction too): the consent
    // lock is a lease across instances, and one that lapsed must not publish from a withdrawn use case.
    if ((await withheldNow(latest)) !== withheldInNotes || (doc && !(await stillPublishable(doc))) || (await withdrawnSince(project.id, represented)).size)
      throw new HttpError(409, 'A use case stopped being public while the release was being published, so it was not published. Try again.');
    // Made from a working draft still waiting for approval: it waits too. The draft is the one this
    // release was made from (advanceTo checks), so whether it's held now is whether this release is.
    await holdReleaseIfDraftHeld(project, r.version);
    Object.assign(r, latest, { approval: now.approval, notes: publishedNotes, commit, status: 'published', publishedAt, statusSince: publishedAt });
    await save(r);
    // Also closes the use cases each change addressed (markReleased syncs them).
    for (const id of r.changeRequestIds) await markReleased(id, r.id, r.version, publishedAt);
    const p = await getProject(r.ontologyId);
    p.currentVersion = r.version;
    p.stage = 'released';
    await updateProject(p);
    // With the database store, publishing to GitHub is a job recorded with the release (see githubOutbox.ts).
    if (ontologyStore.kind === 'db') await enqueueGitHubPublish(p, r);
  });
  Object.assign(project, await getProject(r.ontologyId));
  // The requirements document is published with the version (it may need the model, so not in the transaction).
  if (doc) await markPublished(doc, r);

  await publishToGitHub(project, r);
  await logActivity({ ontologyId: r.ontologyId, actorId: actor?.id, type: 'release.published', message: `published ${project.title} ${r.version}`, link: `/o/${r.ontologyId}/releases/${r.id}` });
  return Object.assign(stale, r);
}

/**
 * Public ontologies are persisted to GitHub on release, when configured.
 * Publishing sends main and every tag, so its whole history. Nothing leaves Concord while a version is waiting for
 * approval, and an ontology from before approvals is never published: its history holds what nobody approved.
 */
async function publishToGitHub(project: OntologyProject, r: Release): Promise<void> {
  if (ontologyStore.kind === 'db') {
    // The job (recorded with the release) checks the same things before every upload, and links the release once done.
    await runGitHubPublish(project.id);
    Object.assign(r, await mustGet<Release>('releases', r.id));
    return;
  }
  const token = config.github.publishToken;
  if (!project.github || !token) return;
  if ((await anyHeld(project)) || !(await historyApproved(project))) {
    console.log(`[release] not pushing ${project.slug} to GitHub: ${(await anyHeld(project)) ? 'a version is waiting for a steward’s approval' : 'its history predates publication approval'}`);
    return;
  }
  try {
    await ontologyStore.publish(project, { repo: project.github.repo, token });
    const githubUrl = `https://github.com/${project.github.repo}/releases/tag/v${r.version}`;
    // Only the link is added, to the release as stored now.
    Object.assign(r, await transaction(async () => await save({ ...(await mustGet<Release>('releases', r.id)), githubUrl })));
  } catch (err) {
    console.warn(`[release] GitHub push failed: ${(err as Error).message.replaceAll(token, '***')}`);
  }
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
  // Publishes to GitHub that paused (write limits) or are waiting to start (database store).
  await runGitHubPublishes();
  return changed;
}

