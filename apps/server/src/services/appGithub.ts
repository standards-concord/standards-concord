import { createHash } from 'node:crypto';
import { workflowYaml } from '@concord/shared';
import type { ConnectedApp, User } from '@concord/shared';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, list, transaction } from '../db.js';
import { baselineRevision, getAppDoc, openForChecks, ownApp, publicAppById, revisionOf, saveApp, stillConnected, type AppDoc, type GithubLink } from './appChecks.js';
import { listCRs } from './changeRequests.js';
import { gh, GithubError, githubAppSettings, installationToken, installUrl, mustSettings, readState, reposTheInstallerCanSee, signState, type GithubAppSettings } from './githubApp.js';
import { getProject } from './ontologies.js';
import { logActivity } from './users.js';

/**
 * Connected apps and the Concord GitHub App: linking an app to the repository it was installed
 * on, starting its workflow when there is something new to test, opening the pull request that
 * adds the workflow, and unlinking when GitHub says the App was removed.
 *
 * The token route (services/appChecks.ts) keeps working alongside, for CI that isn't GitHub
 * Actions and for anyone who prefers it.
 */

export const WORKFLOW_PATH = '.github/workflows/concord.yml';
const WORKFLOW_FILE = 'concord.yml';
const BRANCH = 'concord/app-checks';
/** At most one run started per app in this window, so a burst of edits starts one run. */
const DISPATCH_GAP_MS = 2 * 60 * 1000;
/** After GitHub refuses a run (no workflow yet, App removed), wait this long before asking again. */
const RETRY_MS = 15 * 60 * 1000;
/** How long a claim to start a run holds if the process that made it never finishes asking GitHub. */
const CLAIM_MS = 5 * 60 * 1000;

export const githubAppStatus = () => {
  const s = githubAppSettings();
  return s ? { enabled: true, url: `${s.webUrl}/apps/${s.slug}` } : { enabled: false };
};

/** The workflow for an app connected through GitHub: no secret, it names the app instead. */
export const appWorkflow = (appId: string) => workflowYaml(config.webUrl, { app: appId });

/* ------------------------------------------------------------------------ */
/* Installing                                                               */
/* ------------------------------------------------------------------------ */

/** Where to send the app's owner to install the App, with a signed state that brings them back. */
export async function startInstall(appId: string, actor: User): Promise<{ url: string }> {
  const s = mustSettings();
  const app = await ownApp(appId, actor);
  return { url: installUrl(s, signState(s, { a: app.id, o: app.ontologyId, u: actor.id })) };
}

const appsPage = (ontologyId: string, query: string) => `${config.webUrl}/o/${encodeURIComponent(ontologyId)}/apps?${query}`;

/**
 * GitHub sends the installer back here (the App's callback URL) with the state Concord signed, a
 * one-time code that proves who they are, and the installation. Returns where to send them next.
 */
export async function finishInstall(query: Record<string, unknown>, actor: User | undefined): Promise<string> {
  const s = mustSettings();
  // "Redirect on update": someone changed the installation on GitHub. Nothing to link.
  if (query.state === undefined) return `${config.webUrl}/`;
  const state = readState(s, query.state);
  if (!state) throw new HttpError(400, 'This link to finish connecting has expired or wasn’t made by Concord. Start again from the App checks page.');
  const fail = (message: string) => appsPage(state.o, `github_error=${encodeURIComponent(message)}`);
  if (!actor) return fail('Sign in to Concord in this browser first, then connect through GitHub again.');
  if (actor.id !== state.u) return fail('You were signed in as someone else when you started connecting. Start again from the App checks page.');
  const installationId = typeof query.installation_id === 'string' && /^\d{1,20}$/.test(query.installation_id) ? query.installation_id : undefined;
  const code = typeof query.code === 'string' && query.code.length < 256 ? query.code : undefined;
  if (!installationId) return fail('GitHub didn’t say which installation to link. Try again.');
  if (!code) return fail('GitHub didn’t confirm who installed the app. In the App’s settings, “Request user authorization (OAuth) during installation” must be on.');
  try {
    const repos = await reposTheInstallerCanSee(s, code, installationId);
    const app = await getAppDoc(state.a);
    const wanted = app.repo?.toLowerCase();
    const repo = wanted ? repos.find((r) => r.fullName.toLowerCase() === wanted) : repos.length === 1 ? repos[0] : undefined;
    if (!repo) {
      return fail(
        wanted
          ? `The installation doesn’t include ${app.repo}. On GitHub, add that repository to the Concord app, then connect again.`
          : repos.length
            ? 'The installation covers several repositories. Set this app’s repository on Concord (or install on just the one), then connect again.'
            : 'The installation doesn’t include any repository you can see.',
      );
    }
    // Linking lets Concord start workflows and open pull requests there with the App's access,
    // so it takes someone who could do that themselves.
    if (!repo.canWrite) return fail(`You can see ${repo.fullName} on GitHub but can’t push to it, so you can’t connect it. Ask someone with write access to the repository to connect the app.`);
    const linked = await transaction(async () => {
      const doc = await ownApp(state.a, actor);
      const same = doc.github?.installationId === installationId && doc.github.repoId === repo.id;
      // Linked somewhere else now: what was known about the old link, and the old runs' tokens, go.
      if (!same) doc.runTokens = undefined;
      const link: GithubLink = { ...(same ? doc.github : {}), installationId, repoId: repo.id, repo: repo.fullName, linkedAt: clock.iso(), suspended: undefined, fingerprint: undefined, retryAt: undefined };
      if (doc.repoId !== repo.id) doc.repoId = undefined;
      doc.github = link;
      doc.repo = repo.fullName;
      await saveApp(doc);
      return doc;
    });
    await logActivity({ ontologyId: linked.ontologyId, actorId: actor.id, type: 'app.github', message: `connected the app ${linked.name} through GitHub (${repo.fullName})`, link: `/o/${linked.ontologyId}/apps` });
    return appsPage(state.o, `github=connected&app=${encodeURIComponent(linked.id)}`);
  } catch (err) {
    if (err instanceof HttpError) return fail(err.message);
    throw err;
  }
}

/** Stop using GitHub for this app. Its token keeps working; uninstalling on GitHub is up to its owner. */
export async function unlinkGithub(appId: string, actor: User): Promise<ConnectedApp> {
  const doc = await transaction(async () => {
    const doc = await ownApp(appId, actor);
    doc.github = undefined;
    doc.runTokens = undefined;
    await saveApp(doc);
    return doc;
  });
  await logActivity({ ontologyId: doc.ontologyId, actorId: actor.id, type: 'app.github', message: `stopped connecting ${doc.name} through GitHub`, link: `/o/${doc.ontologyId}/apps` });
  return publicAppById(appId);
}

/* ------------------------------------------------------------------------ */
/* Webhooks                                                                 */
/* ------------------------------------------------------------------------ */

async function changeLinked(match: (link: GithubLink) => boolean, change: (doc: AppDoc) => void): Promise<AppDoc[]> {
  return transaction(async () => {
    const changed: AppDoc[] = [];
    for (const doc of await list<AppDoc>('apps')) {
      if (!doc.github || !match(doc.github)) continue;
      change(doc);
      await saveApp(doc);
      changed.push(doc);
    }
    return changed;
  });
}

const unlink = (doc: AppDoc) => {
  doc.github = undefined;
  doc.runTokens = undefined;
};

/** What GitHub tells the App: an installation removed or suspended, or a repository taken out of it. */
export async function onWebhook(event: string, payload: Record<string, unknown>): Promise<{ handled: boolean; apps: number }> {
  const installationId = String((payload.installation as { id?: unknown } | undefined)?.id ?? '');
  if (!installationId) return { handled: false, apps: 0 };
  const sameInstallation = (l: GithubLink) => l.installationId === installationId;
  let changed: AppDoc[] = [];
  let note: string | undefined;
  if (event === 'installation' && payload.action === 'deleted') {
    changed = await changeLinked(sameInstallation, unlink);
    note = 'was disconnected from GitHub because the Concord app was uninstalled there';
  } else if (event === 'installation' && (payload.action === 'suspend' || payload.action === 'unsuspend')) {
    const suspended = payload.action === 'suspend';
    changed = await changeLinked(sameInstallation, (d) => {
      d.github!.suspended = suspended || undefined;
      if (!suspended) d.github!.retryAt = undefined;
    });
  } else if (event === 'pull_request' && payload.action === 'closed') {
    // Concord's workflow pull request was merged: the workflow is there now, so start a run straight
    // away. Once per merge: a redelivered (or duplicated) webhook finds it already recorded.
    const pr = payload.pull_request as { merged?: boolean; number?: unknown; merge_commit_sha?: unknown; merged_at?: unknown; head?: { ref?: string } } | undefined;
    const repoId = String((payload.repository as { id?: unknown } | undefined)?.id ?? '');
    if (!pr?.merged || pr.head?.ref !== BRANCH) return { handled: false, apps: 0 };
    const merge = `${String(pr.number ?? '')}@${String(pr.merge_commit_sha ?? pr.merged_at ?? '')}`;
    changed = await changeLinked((l) => sameInstallation(l) && l.repoId === repoId && l.workflowMerged !== merge, (d) => {
      d.github!.workflowMerged = merge;
      d.github!.fingerprint = d.github!.retryAt = d.github!.dispatchAt = undefined;
    });
    for (const doc of changed) await dispatchIfNeeded(doc.id).catch((err) => console.warn(`[github-app] ${doc.id}:`, (err as Error).message));
  } else if (event === 'installation_repositories' && payload.action === 'removed') {
    const removed = new Set(((payload.repositories_removed as { id?: unknown }[] | undefined) ?? []).map((r) => String(r.id)));
    changed = await changeLinked((l) => sameInstallation(l) && removed.has(l.repoId), unlink);
    note = 'was disconnected from GitHub because its repository was removed from the Concord app there';
  } else return { handled: false, apps: 0 };
  if (note) for (const doc of changed) await logActivity({ ontologyId: doc.ontologyId, actorId: doc.ownerId, type: 'app.github', message: `${doc.name} ${note}`, link: `/o/${doc.ontologyId}/apps` });
  return { handled: true, apps: changed.length };
}

/* ------------------------------------------------------------------------ */
/* Starting runs                                                            */
/* ------------------------------------------------------------------------ */

/** What there is to test now: the working draft and each open change, by revision. */
async function fingerprint(ontologyId: string): Promise<string> {
  const project = await getProject(ontologyId);
  const open = (await listCRs(ontologyId)).filter(openForChecks);
  const revs = await Promise.all(open.map(async (cr) => `${cr.id}=${await revisionOf(cr, project)}`));
  return createHash('sha256').update([await baselineRevision(project), ...revs.sort()].join('\n')).digest('hex').slice(0, 24);
}

interface RepoInfo {
  full_name: string;
  default_branch: string;
}

const repoInfo = (s: GithubAppSettings, link: GithubLink, token: string) => gh<RepoInfo>(s, `/repositories/${encodeURIComponent(link.repoId)}`, { token });
const repoPath = (fullName: string) => fullName.split('/').map(encodeURIComponent).join('/');

/** Is the app's owner still a member? Its runs couldn't sign in otherwise, so none are started. */
const ownerStillHere = (doc: AppDoc) =>
  stillConnected(doc).then(
    () => true,
    () => false,
  );

/**
 * Start the app's workflow if there is something it hasn't been started for yet. A claim is
 * recorded before GitHub is asked, so two server processes (or a sweep and a request) can't both
 * start a run for the same thing. Only a run GitHub accepted counts as done; a refusal is retried
 * after a pause, and a claim whose process never finished runs out after a few minutes.
 */
export async function dispatchIfNeeded(appId: string, now = Date.now()): Promise<'started' | 'skipped' | 'failed'> {
  const s = githubAppSettings();
  if (!s) return 'skipped';
  const first = await get<AppDoc>('apps', appId);
  if (!first?.github || first.github.suspended || !(await ownerStillHere(first))) return 'skipped';
  const fp = await fingerprint(first.ontologyId);
  const link = await transaction(async () => {
    const doc = await get<AppDoc>('apps', appId);
    const l = doc?.github;
    if (!doc || !l || l.suspended || l.fingerprint === fp) return undefined;
    if (l.pending && now < l.pending.until) return undefined;
    if ((l.dispatchAt && now - l.dispatchAt < DISPATCH_GAP_MS) || (l.retryAt && now < l.retryAt)) return undefined;
    if (!(await ownerStillHere(doc))) return undefined;
    l.pending = { fingerprint: fp, until: now + CLAIM_MS };
    l.dispatchAt = now;
    await saveApp(doc);
    return { ...l };
  });
  if (!link) return 'skipped';
  let ok = true;
  let message: string | undefined;
  let renamed: string | undefined;
  try {
    const token = await installationToken(s, link.installationId, link.repoId, { actions: 'write' });
    const repo = await repoInfo(s, link, token);
    if (repo.full_name !== link.repo) renamed = repo.full_name;
    try {
      await gh(s, `/repos/${repoPath(repo.full_name)}/actions/workflows/${WORKFLOW_FILE}/dispatches`, { token, method: 'POST', body: { ref: repo.default_branch } });
    } catch (err) {
      if (err instanceof GithubError && err.githubStatus === 404) throw new GithubError(404, `There’s no ${WORKFLOW_PATH} on ${repo.default_branch} yet. Merge the pull request that adds it, or add the file yourself.`);
      throw err;
    }
  } catch (err) {
    ok = false;
    message = err instanceof GithubError && (err.githubStatus === 401 || err.githubStatus === 403 || err.githubStatus === 404) && /installation|access_tokens/i.test(err.message) ? 'GitHub refused: is the Concord app still installed on this repository?' : (err as Error).message;
  }
  await transaction(async () => {
    const doc = await get<AppDoc>('apps', appId);
    if (!doc?.github || doc.github.installationId !== link.installationId || doc.github.repoId !== link.repoId) return;
    doc.github.lastDispatch = { at: clock.iso(), ok, ...(message && { message }) };
    if (doc.github.pending?.fingerprint === fp) doc.github.pending = undefined;
    if (ok) {
      doc.github.fingerprint = fp;
      doc.github.retryAt = undefined;
    } else if (doc.github.workflowMerged === link.workflowMerged) doc.github.retryAt = now + RETRY_MS;
    // (Refused, but the workflow pull request was merged meanwhile: the next sweep tries again at once.)
    if (renamed) doc.github.repo = doc.repo = renamed;
    await saveApp(doc);
  });
  if (!ok) console.warn(`[github-app] couldn't start a run for app ${appId}: ${message}`);
  return ok ? 'started' : 'failed';
}

/** The app's owner asks for a run now (after adding the workflow by hand, say): no waiting on a gap or a retry. */
export async function runNow(appId: string, actor: User): Promise<ConnectedApp> {
  mustSettings();
  await transaction(async () => {
    const doc = await ownApp(appId, actor);
    if (!doc.github) throw new HttpError(409, 'Connect this app through GitHub first');
    if (doc.github.suspended) throw new HttpError(409, 'The Concord app is suspended on this repository; unsuspend it on GitHub first');
    doc.github.fingerprint = doc.github.retryAt = doc.github.dispatchAt = undefined;
    await saveApp(doc);
  });
  await dispatchIfNeeded(appId);
  return publicAppById(appId);
}

/** Something to test may have changed on this ontology: start runs for its apps connected through GitHub. */
export async function nudgeRuns(ontologyId: string): Promise<void> {
  if (!githubAppSettings()) return;
  for (const doc of await list<AppDoc>('apps', ontologyId)) {
    if (!doc.github) continue;
    await dispatchIfNeeded(doc.id).catch((err) => console.warn(`[github-app] ${doc.id}:`, (err as Error).message));
  }
}

/** Fire and forget, for code paths that mustn't wait on GitHub (or fail because of it). */
export const nudgeRunsSoon = (ontologyId: string) => void nudgeRuns(ontologyId).catch((err) => console.warn('[github-app]', (err as Error).message));

/** The periodic sweep: catches what a request didn't (a gap still running, a retry due, another process). */
export async function sweepRuns(): Promise<void> {
  if (!githubAppSettings()) return;
  for (const doc of await list<AppDoc>('apps')) {
    if (!doc.github) continue;
    await dispatchIfNeeded(doc.id).catch((err) => console.warn(`[github-app] ${doc.id}:`, (err as Error).message));
  }
}

/* ------------------------------------------------------------------------ */
/* The workflow pull request                                                */
/* ------------------------------------------------------------------------ */

const asText = (b64: string) => Buffer.from(b64.replace(/\n/g, ''), 'base64').toString('utf8');

/**
 * Open (or update) the pull request that adds the Concord workflow to the app's repository, on
 * its own branch. If the default branch already has exactly this workflow, there is nothing to do.
 */
export async function openWorkflowPr(appId: string, actor: User): Promise<{ app: ConnectedApp; alreadyThere?: boolean }> {
  const s = mustSettings();
  const doc = await ownApp(appId, actor);
  const link = doc.github;
  if (!link) throw new HttpError(409, 'Connect this app through GitHub first');
  if (link.suspended) throw new HttpError(409, 'The Concord app is suspended on this repository; unsuspend it on GitHub first');
  const yaml = appWorkflow(doc.id);
  const token = await installationToken(s, link.installationId, link.repoId, { contents: 'write', pull_requests: 'write', workflows: 'write' });
  const repo = await repoInfo(s, link, token);
  const r = repoPath(repo.full_name);
  const fileAt = async (ref: string) => {
    try {
      const f = await gh<{ sha: string; content?: string }>(s, `/repos/${r}/contents/${WORKFLOW_PATH}?ref=${encodeURIComponent(ref)}`, { token });
      return { sha: f.sha, text: f.content ? asText(f.content) : undefined };
    } catch (err) {
      if (err instanceof GithubError && err.githubStatus === 404) return undefined;
      throw err;
    }
  };
  if ((await fileAt(repo.default_branch))?.text === yaml) return { app: await publicAppById(appId), alreadyThere: true };

  const head = await gh<{ object: { sha: string } }>(s, `/repos/${r}/git/ref/heads/${repo.default_branch.split('/').map(encodeURIComponent).join('/')}`, { token });
  try {
    await gh(s, `/repos/${r}/git/refs`, { token, method: 'POST', body: { ref: `refs/heads/${BRANCH}`, sha: head.object.sha } });
  } catch (err) {
    // The branch is there from an earlier pull request: the file is updated on it.
    if (!(err instanceof GithubError && err.githubStatus === 422)) throw err;
  }
  const onBranch = await fileAt(BRANCH);
  if (onBranch?.text !== yaml) {
    await gh(s, `/repos/${r}/contents/${WORKFLOW_PATH}`, {
      token,
      method: 'PUT',
      body: { message: 'Add the Concord ontology checks workflow', content: Buffer.from(yaml).toString('base64'), branch: BRANCH, ...(onBranch && { sha: onBranch.sha }) },
    });
  }
  const owner = repo.full_name.split('/')[0];
  const open = await gh<{ number: number; html_url: string }[]>(s, `/repos/${r}/pulls?state=open&head=${encodeURIComponent(`${owner}:${BRANCH}`)}`, { token });
  const pr =
    open[0] ??
    (await gh<{ number: number; html_url: string }>(s, `/repos/${r}/pulls`, {
      token,
      method: 'POST',
      body: {
        title: 'Test this app against proposed ontology changes',
        head: BRANCH,
        base: repo.default_branch,
        body: [
          `This adds the workflow that tests **${doc.name}** against every change proposed to the ontology on [Concord](${config.webUrl}/o/${doc.ontologyId}/apps).`,
          '',
          'Concord starts it whenever there is something new to test; the daily schedule is a backstop. It needs no secret: the run signs in with GitHub’s own token for this repository (`id-token: write`).',
          '',
          'Change `npm ci` and `npm test` to however this app installs and tests itself.',
        ].join('\n'),
      },
    }));
  await transaction(async () => {
    const now = await get<AppDoc>('apps', appId);
    if (!now?.github || now.github.repoId !== link.repoId) return;
    now.github.workflowPr = { number: pr.number, url: pr.html_url };
    if (repo.full_name !== now.github.repo) now.github.repo = now.repo = repo.full_name;
    await saveApp(now);
  });
  return { app: await publicAppById(appId) };
}
