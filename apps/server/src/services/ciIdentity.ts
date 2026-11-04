import { createPublicKey, verify } from 'node:crypto';
import { HttpError } from '../db.js';

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

/** Tokens already used, until they expire: each proves one report, once. */
const used = new Map<string, number>();

const part = (s: string) => {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'The run identity token is malformed');
  }
};

export interface VerifiedRun {
  repository: string;
  runId?: string;
  sha?: string;
}

/** Check a GitHub Actions OIDC token for this audience; throws 400 with the reason if it doesn't hold. */
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
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp < now - 60) throw new HttpError(400, 'The run identity token has expired');
  if (Number(claims.nbf ?? claims.iat ?? 0) > now + 60) throw new HttpError(400, 'The run identity token isn’t valid yet');
  if (typeof claims.repository !== 'string' || !claims.repository) throw new HttpError(400, 'The run identity token doesn’t name a repository');

  for (const [id, until] of used) if (until < now - 60) used.delete(id);
  const jti = typeof claims.jti === 'string' && claims.jti ? claims.jti : `${h}.${p}`;
  if (used.has(jti)) throw new HttpError(400, 'This run identity token was already used; each run asks GitHub for its own');
  used.set(jti, exp);

  return { repository: claims.repository, runId: claims.run_id === undefined ? undefined : String(claims.run_id), sha: typeof claims.sha === 'string' ? claims.sha : undefined };
}

/** The audience an app's CI asks GitHub for: tied to the one app, so the token proves a run for it. */
export const runAudience = (appId: string) => `concord-app-check:${appId}`;
