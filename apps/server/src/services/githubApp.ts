import { createHmac, createPrivateKey, randomBytes, sign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { HttpError } from '../db.js';

/**
 * Concord's GitHub App: the client side. Someone who connects their app through it installs the
 * App on their app's repository; Concord then starts the repository's Concord workflow whenever
 * there is something new to test, and can open the pull request that adds the workflow. The run
 * itself signs in with GitHub's own OIDC token, so there is no Concord token to store.
 *
 * Turned on by these variables (all of them, or the App is off and only the token route shows):
 *
 *   GITHUB_APP_ID              the App's number
 *   GITHUB_APP_SLUG            its URL name (github.com/apps/<slug>)
 *   GITHUB_APP_PRIVATE_KEY     the PEM GitHub generates for it, raw (newlines or \n) or base64
 *   GITHUB_APP_WEBHOOK_SECRET  the secret its webhook deliveries are signed with
 *   GITHUB_APP_CLIENT_ID       for the installer's one-time sign-in during installation
 *   GITHUB_APP_CLIENT_SECRET
 *
 * GITHUB_APP_API_URL and GITHUB_APP_WEB_URL point it at another GitHub (or the tests' stand-in).
 * Read when used, like the OIDC issuer, so tests can set them.
 */
export interface GithubAppSettings {
  appId: string;
  slug: string;
  privateKey: KeyObject;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
  webUrl: string;
}

let keyCache: { raw: string; key: KeyObject } | undefined;

/** The PEM as GitHub gives it, with its newlines escaped (as some env files need), or base64 of it. */
function readKey(raw: string): KeyObject {
  if (keyCache?.raw === raw) return keyCache.key;
  const text = raw.includes('-----BEGIN') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64').toString('utf8');
  const key = createPrivateKey(text);
  keyCache = { raw, key };
  return key;
}

export function githubAppSettings(): GithubAppSettings | undefined {
  const e = process.env;
  const need = [e.GITHUB_APP_ID, e.GITHUB_APP_SLUG, e.GITHUB_APP_PRIVATE_KEY, e.GITHUB_APP_WEBHOOK_SECRET, e.GITHUB_APP_CLIENT_ID, e.GITHUB_APP_CLIENT_SECRET];
  if (need.some((v) => !v?.trim())) return undefined;
  let privateKey: KeyObject;
  try {
    privateKey = readKey(e.GITHUB_APP_PRIVATE_KEY!.trim());
  } catch (err) {
    console.warn(`[github-app] GITHUB_APP_PRIVATE_KEY isn't a private key Concord can read (${(err as Error).message}); the GitHub App is off`);
    return undefined;
  }
  return {
    appId: e.GITHUB_APP_ID!.trim(),
    slug: e.GITHUB_APP_SLUG!.trim(),
    privateKey,
    webhookSecret: e.GITHUB_APP_WEBHOOK_SECRET!,
    clientId: e.GITHUB_APP_CLIENT_ID!.trim(),
    clientSecret: e.GITHUB_APP_CLIENT_SECRET!,
    apiUrl: (e.GITHUB_APP_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    webUrl: (e.GITHUB_APP_WEB_URL || 'https://github.com').replace(/\/$/, ''),
  };
}

export function mustSettings(): GithubAppSettings {
  const s = githubAppSettings();
  if (!s) throw new HttpError(404, 'This Concord isn’t set up to connect apps through GitHub; use the app token instead');
  return s;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** The App's own credential: a JWT it signs, valid for nine minutes (GitHub allows ten). */
export function appJwt(s: GithubAppSettings): string {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: s.appId }))}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), s.privateKey).toString('base64url')}`;
}

export class GithubError extends HttpError {
  constructor(
    public readonly githubStatus: number,
    message: string,
  ) {
    super(502, message);
  }
}

/** One GitHub API call. Throws GithubError with GitHub's own message when it says no. */
export async function gh<T = unknown>(s: GithubAppSettings, path: string, opts: { token: string; method?: string; body?: unknown; basic?: boolean }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${s.apiUrl}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Concord',
        Authorization: opts.basic ? `Basic ${Buffer.from(opts.token).toString('base64')}` : `Bearer ${opts.token}`,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new GithubError(0, `Couldn’t reach GitHub: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {}
    throw new GithubError(res.status, `GitHub said ${res.status}: ${message}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

export type RepoPermissions = Partial<Record<'actions' | 'contents' | 'pull_requests' | 'workflows' | 'checks' | 'metadata', 'read' | 'write'>>;

/**
 * A token for one installation, narrowed to one repository and the permissions one step needs.
 * Never stored: GitHub's tokens last an hour, and each step asks for its own.
 */
export async function installationToken(s: GithubAppSettings, installationId: string, repoId: string, permissions: RepoPermissions): Promise<string> {
  const out = await gh<{ token: string }>(s, `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    token: appJwt(s),
    method: 'POST',
    body: { repository_ids: [Number(repoId)], permissions },
  });
  return out.token;
}

/* ------------------------------------------------------------------------ */
/* Installing: the signed state, and proving who installed                  */
/* ------------------------------------------------------------------------ */

/** How long someone has to finish installing on GitHub. */
const STATE_MINUTES = 15;

const stateMac = (s: GithubAppSettings, body: string) => createHmac('sha256', s.clientSecret).update(`concord-github-app-state\n${body}`).digest('base64url');

export interface InstallState {
  /** Concord app id. */
  a: string;
  /** Ontology id, so even a failure can go back to the right page. */
  o: string;
  /** The signed-in person who started it. */
  u: string;
  /** Expiry, in seconds. */
  e: number;
}

export function signState(s: GithubAppSettings, state: Omit<InstallState, 'e'>): string {
  const body = b64url(JSON.stringify({ ...state, e: Math.floor(Date.now() / 1000) + STATE_MINUTES * 60, n: randomBytes(9).toString('base64url') }));
  return `${body}.${stateMac(s, body)}`;
}

/** The state GitHub hands back, if Concord signed it and it hasn't expired; otherwise undefined. */
export function readState(s: GithubAppSettings, state: unknown): InstallState | undefined {
  if (typeof state !== 'string' || state.length > 1024) return undefined;
  const [body, mac, extra] = state.split('.');
  if (!body || !mac || extra !== undefined) return undefined;
  const want = Buffer.from(stateMac(s, body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as InstallState;
    if (typeof v.a !== 'string' || typeof v.o !== 'string' || typeof v.u !== 'string' || typeof v.e !== 'number') return undefined;
    return v.e >= Date.now() / 1000 ? v : undefined;
  } catch {
    return undefined;
  }
}

export const installUrl = (s: GithubAppSettings, state: string) => `${s.webUrl}/apps/${encodeURIComponent(s.slug)}/installations/new?state=${encodeURIComponent(state)}`;

export interface InstalledRepo {
  id: string;
  fullName: string;
}

/**
 * The repositories in an installation that the person who just installed can see, proven with
 * their one-time sign-in code: an installation id in the redirect is just a number anyone could
 * type, so this is what stops someone linking a repository they don't control. The person's
 * token is used for this one question and revoked straight after.
 */
export async function reposTheInstallerCanSee(s: GithubAppSettings, code: string, installationId: string): Promise<InstalledRepo[]> {
  let res: Response;
  try {
    res = await fetch(`${s.webUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Concord' },
      body: JSON.stringify({ client_id: s.clientId, client_secret: s.clientSecret, code }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new GithubError(0, `Couldn’t reach GitHub: ${(err as Error).message}`);
  }
  const out = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !out.access_token) throw new HttpError(400, `GitHub didn’t confirm who installed the app (${out.error_description ?? out.error ?? `HTTP ${res.status}`}). Try connecting again.`);
  const userToken = out.access_token;
  try {
    const repos: InstalledRepo[] = [];
    for (let page = 1; page <= 10; page++) {
      let got: { repositories?: { id: number; full_name: string }[] };
      try {
        got = await gh(s, `/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=100&page=${page}`, { token: userToken });
      } catch (err) {
        if (err instanceof GithubError && (err.githubStatus === 404 || err.githubStatus === 403))
          throw new HttpError(403, 'That installation isn’t one your GitHub account can see, so Concord can’t link it');
        throw err;
      }
      const list = got.repositories ?? [];
      repos.push(...list.map((r) => ({ id: String(r.id), fullName: r.full_name })));
      if (list.length < 100) break;
    }
    return repos;
  } finally {
    // Concord needs nothing more from the person's account.
    await gh(s, `/applications/${encodeURIComponent(s.clientId)}/token`, { token: `${s.clientId}:${s.clientSecret}`, basic: true, method: 'DELETE', body: { access_token: userToken } }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------------ */
/* Webhooks                                                                 */
/* ------------------------------------------------------------------------ */

/** Does this delivery carry the App's signature (X-Hub-Signature-256) over exactly these bytes? */
export function signedByGithub(s: GithubAppSettings, body: Buffer, signature: string | undefined): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const want = Buffer.from(`sha256=${createHmac('sha256', s.webhookSecret).update(body).digest('hex')}`);
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}
