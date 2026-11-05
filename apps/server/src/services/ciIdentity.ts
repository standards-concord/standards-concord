import { createPublicKey, verify } from 'node:crypto';
import { HttpError, insertOnce, removeWhereAtMost } from '../db.js';

/**
 * Proof that a CI run really ran in a given GitHub repository: the OpenID Connect token GitHub
 * Actions issues to a job that asks for one (`permissions: id-token: write`). It is signed by
 * GitHub, names the repository, run and commit, is valid for minutes, and carries the audience
 * the job asked for, so a token minted for something else can't be passed off here.
 *
 * App checks use it so that a leaked app token alone can't make autopilot say yes: results
 * only count for autopilot when they come from a run GitHub vouches for (or from the app's
 * owner, signed in).
 */

/** Read when used, so tests (and other GitHub hosts) can point it elsewhere. */
const issuer = () => (process.env.GITHUB_OIDC_ISSUER ?? 'https://token.actions.githubusercontent.com').replace(/\/$/, '');

type Jwk = { kty?: string; kid?: string; n?: string; e?: string; [k: string]: unknown };
const keySets = new Map<string, { at: number; keys: Jwk[] }>();

async function keysFor(iss: string, refresh: boolean): Promise<Jwk[]> {
  const cached = keySets.get(iss);
  if (cached && !refresh && Date.now() - cached.at < 60 * 60 * 1000) return cached.keys;
  let res: Response;
  try {
    res = await fetch(`${iss}/.well-known/jwks`, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new HttpError(503, `Couldn't fetch GitHub's signing keys to check the run: ${(err as Error).message}`);
  }
  if (!res.ok) throw new HttpError(503, `Couldn't fetch GitHub's signing keys to check the run (HTTP ${res.status})`);
  const keys = (((await res.json()) as { keys?: Jwk[] }).keys ?? []).filter((k) => k.kty === 'RSA');
  keySets.set(iss, { at: Date.now(), keys });
  return keys;
}

const part = (s: string) => {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'The run identity token is malformed');
  }
};

/**
 * Events a run may come from. Runs that the repository's own people start: on a schedule, by
 * hand, on a push, or by a repository dispatch. Not pull requests (which run code the PR
 * proposes, and whose commit is a merge commit nobody has reviewed), nor pull_request_target.
 */
const EVENTS = ['schedule', 'workflow_dispatch', 'push', 'repository_dispatch'];

/** Longest a token may be valid for. GitHub's last minutes, not hours. */
const MAX_LIFETIME = 60 * 60;

export interface VerifiedRun {
  repository: string;
  repositoryId: string;
  sha: string;
  event: string;
  workflowRef: string;
  runId?: string;
  /** Issuer, token id and expiry, as recorded when the token is used (see consumeRunProof). */
  iss: string;
  jti: string;
  exp: number;
}

const num = (v: unknown, what: string, required: boolean) => {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `The run identity token’s ${what} claim must be a number`);
  return v;
};

/**
 * Check a GitHub Actions OIDC token for this audience; throws 400 with the reason if it doesn't
 * hold. This only checks it: consumeRunProof uses it up, in the transaction that records the report.
 */
export async function verifyGithubRun(token: unknown, audience: string): Promise<VerifiedRun> {
  if (typeof token !== 'string' || token.length > 8192) throw new HttpError(400, 'The run identity token is malformed');
  const [h, p, s, extra] = token.split('.');
  if (!h || !p || !s || extra !== undefined) throw new HttpError(400, 'The run identity token is malformed');
  const header = part(h);
  if (header.alg !== 'RS256') throw new HttpError(400, 'The run identity token must be signed with RS256');
  const iss = issuer();
  const find = (keys: Jwk[]) => keys.find((k) => k.kid === header.kid);
  const jwk = find(await keysFor(iss, false)) ?? find(await keysFor(iss, true));
  if (!jwk) throw new HttpError(400, 'The run identity token is signed with a key GitHub doesn’t publish');
  const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk as never, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!ok) throw new HttpError(400, 'The run identity token’s signature doesn’t check out');

  const claims = part(p);
  if (claims.iss !== iss) throw new HttpError(400, 'The run identity token wasn’t issued by GitHub Actions');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) throw new HttpError(400, `The run identity token is for another audience; ask GitHub for one with audience ${audience}`);
  // Real time, not the demo's simulated clock: GitHub's clock is the one that counts.
  const now = Date.now() / 1000;
  const exp = num(claims.exp, 'exp', true)!;
  const iat = num(claims.iat, 'iat', true)!;
  const nbf = num(claims.nbf, 'nbf', false);
  if (exp < now - 60) throw new HttpError(400, 'The run identity token has expired');
  if (iat > now + 60 || (nbf !== undefined && nbf > now + 60)) throw new HttpError(400, 'The run identity token isn’t valid yet');
  if (exp <= iat || exp - iat > MAX_LIFETIME) throw new HttpError(400, 'The run identity token is valid for longer than GitHub issues them');

  const str = (k: string) => (typeof claims[k] === 'string' && claims[k] ? (claims[k] as string) : undefined);
  const repository = str('repository');
  if (!repository) throw new HttpError(400, 'The run identity token doesn’t name a repository');
  const repositoryId = typeof claims.repository_id === 'number' ? String(claims.repository_id) : str('repository_id');
  if (!repositoryId) throw new HttpError(400, 'The run identity token doesn’t give the repository’s id');
  const sha = str('sha');
  if (!sha) throw new HttpError(400, 'The run identity token doesn’t say which commit ran');
  const event = str('event_name') ?? '';
  if (!EVENTS.includes(event)) throw new HttpError(400, `Runs triggered by ${event || 'an unknown event'} aren’t accepted; use a schedule, a manual run, a push or a repository dispatch`);
  // The workflow that ran must live in the same repository (not a reusable workflow elsewhere).
  const workflowRef = str('job_workflow_ref') ?? str('workflow_ref') ?? '';
  if (!workflowRef.toLowerCase().startsWith(`${repository.toLowerCase()}/`)) throw new HttpError(400, 'The run’s workflow isn’t in the app’s repository');
  const jti = str('jti');
  if (!jti) throw new HttpError(400, 'The run identity token has no id');

  return { repository, repositoryId, sha, event, workflowRef, runId: claims.run_id === undefined ? undefined : String(claims.run_id), iss, jti, exp };
}

/**
 * Use a checked token up. Call it inside the transaction that records what the token proves, so
 * the two are kept or lost together: the database refuses a second insert of the same (issuer,
 * id), in any process, and a transaction that fails takes the insert back with it. `mayReuse`
 * says this is the same report retried with the same token.
 */
export async function consumeRunProof(proof: VerifiedRun, mayReuse: boolean) {
  await removeWhereAtMost('oidcTokens', 'exp', Date.now() / 1000 - 120);
  if (!(await insertOnce('oidcTokens', { id: `${proof.iss}#${proof.jti}`, iss: proof.iss, jti: proof.jti, exp: proof.exp })) && !mayReuse)
    throw new HttpError(400, 'This run identity token was already used; each run asks GitHub for its own');
}

/** The audience an app's CI asks GitHub for: tied to the one app, so the token proves a run for it. */
export const runAudience = (appId: string) => `concord-app-check:${appId}`;
