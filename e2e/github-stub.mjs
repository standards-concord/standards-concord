// A stand-in for the parts of GitHub Concord talks to, so the e2e server (and the server's unit
// tests) work offline:
//
// - the issues API, for public feedback summaries: POST /repos/:owner/:repo/issues creates, GET
//   lists, PATCH /repos/:owner/:repo/issues/:n edits; GET /__issues lists everything received;
// - the Concord GitHub App: installing (the install page sends the browser straight back to
//   Concord's callback), the installer's one-time code, installation tokens (checking the App's
//   JWT against its public key), starting workflows, branches, files and pull requests;
//   GET /__app shows what happened, POST /__app/next-install sets up the next installation,
//   POST /__app/merge merges a pull request, POST /__app/hold and /__app/release keep workflow
//   dispatches unanswered until released, POST /__app/reset forgets everything;
// - GitHub Actions' OIDC issuer: GET /.well-known/jwks, and GET /__oidc/token mints a run's token.
//
// Run as a script (`node e2e/github-stub.mjs`, PORT, GITHUB_APP_ID, GITHUB_APP_PUBLIC_KEY,
// GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, CALLBACK_URL) or imported (createGithubStub).
import { createPublicKey, createSign, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const b64url = (v) => Buffer.from(v).toString('base64url');

/**
 * @param {{ appId?: string, publicKey?: string, clientId?: string, clientSecret?: string, callbackUrl?: string }} opts
 */
export function createGithubStub(opts = {}) {
  const issues = [];
  const oidcKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const oidcJwk = { ...oidcKeys.publicKey.export({ format: 'jwk' }), kid: 'stub-key', alg: 'RS256', use: 'sig' };
  let base = '';
  let app;
  const resetApp = () => {
    app = {
      nextRepoId: 9000,
      nextInstallation: 4200,
      nextPr: 1,
      /** What the next install covers: repositories by full name, and those the installer may only read. */
      nextInstall: { repos: ['example/family-finder'], readOnly: [] },
      /** id -> { repos: repo ids, readOnly: repo ids the installer can't push to } */
      installations: new Map(),
      /** full name -> { id, full_name, default_branch, branches: Map<branch, Map<path, text>>, pulls: [] } */
      repos: new Map(),
      /** one-time code -> installation id; user tokens likewise */
      codes: new Map(),
      userTokens: new Map(),
      /** installation token -> { installationId, repoIds, permissions } */
      tokens: new Map(),
      dispatches: [],
      /** While `holdDispatches`, workflow dispatches wait here (unanswered) until POST /__app/release. */
      holdDispatches: false,
      held: [],
      revoked: [],
      tokenRequests: [],
    };
  };
  resetApp();

  const repoNamed = (fullName) => {
    let r = app.repos.get(fullName.toLowerCase());
    if (!r) {
      r = { id: String(++app.nextRepoId), full_name: fullName, default_branch: 'main', branches: new Map([['main', new Map([['README.md', '# app\n']])]]), pulls: [] };
      app.repos.set(fullName.toLowerCase(), r);
    }
    return r;
  };
  const repoById = (id) => [...app.repos.values()].find((r) => r.id === String(id));
  const sha = (text) => b64url(text ?? '').slice(0, 40);

  /** Is this the App's JWT, signed with its key and still valid? */
  const appJwtOk = (auth) => {
    if (!opts.publicKey || !auth?.startsWith('Bearer ')) return false;
    const [h, p, s] = auth.slice(7).split('.');
    if (!h || !p || !s) return false;
    if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey(opts.publicKey), Buffer.from(s, 'base64url'))) return false;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    return String(claims.iss) === String(opts.appId) && claims.exp > Date.now() / 1000;
  };

  const mintOidc = (claims) => {
    const now = Math.floor(Date.now() / 1000);
    const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'stub-key' }));
    const repository = claims.repository ?? 'example/app';
    const body = b64url(
      JSON.stringify({
        iss: base,
        iat: now,
        nbf: now,
        exp: now + 300,
        jti: randomUUID(),
        run_id: 1,
        event_name: 'workflow_dispatch',
        sha: 'f00dfeed',
        repository_id: app.repos.get(String(repository).toLowerCase())?.id ?? '1',
        job_workflow_ref: `${repository}/.github/workflows/concord.yml@refs/heads/main`,
        ...claims,
      }),
    );
    return `${h}.${body}.${createSign('RSA-SHA256').update(`${h}.${body}`).sign(oidcKeys.privateKey).toString('base64url')}`;
  };

  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? '' : JSON.stringify(body));
      const url = new URL(req.url ?? '/', 'http://stub');
      const p = url.pathname;
      const m = (re) => p.match(re);
      const json = () => (data ? JSON.parse(data) : {});
      const auth = req.headers.authorization;
      let mm;

      if (req.method === 'GET' && p === '/healthz') return send(200, { ok: true });

      /* ---------------- issues (feedback summaries) ---------------- */
      if (req.method === 'GET' && p === '/__issues') return send(200, issues);
      if (req.method === 'GET' && p === '/user') return send(200, { login: 'concord-e2e-bot' });
      // No triage comments in e2e: an empty list, so withdrawal has none to delete.
      if (req.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(p)) return send(200, []);
      const list = m(/^\/repos\/([^/]+)\/([^/]+)\/issues$/);
      const one = m(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
      if (list && req.method === 'GET') return send(200, [...issues].reverse().map((i) => ({ number: i.number, html_url: i.html_url, title: i.title, body: i.body, created_at: i.created_at, user: { login: 'concord-e2e-bot' } })));
      if (list && req.method === 'POST') {
        const number = issues.length + 1;
        const html_url = `https://github.com/${list[1]}/${list[2]}/issues/${number}`;
        issues.push({ number, html_url, state: 'open', created_at: new Date().toISOString(), repo: `${list[1]}/${list[2]}`, authorized: auth === 'Bearer e2e-feedback-token', ...json() });
        return send(201, { number, html_url });
      }
      if (one && req.method === 'PATCH' && issues[Number(one[3]) - 1]) {
        Object.assign(issues[Number(one[3]) - 1], json());
        return send(200, {});
      }

      /* ---------------- OIDC issuer (GitHub Actions) ---------------- */
      if (req.method === 'GET' && p === '/.well-known/jwks') return send(200, { keys: [oidcJwk] });
      if (req.method === 'GET' && p === '/__oidc/token') {
        const claims = Object.fromEntries(url.searchParams);
        if (claims.audience) claims.aud = claims.audience;
        delete claims.audience;
        return send(200, { value: mintOidc(claims) });
      }

      /* ---------------- the GitHub App: test controls ---------------- */
      if (req.method === 'GET' && p === '/__app')
        return send(200, {
          dispatches: app.dispatches,
          held: app.held.length,
          revoked: app.revoked,
          tokenRequests: app.tokenRequests,
          installations: [...app.installations].map(([id, i]) => ({ id, repos: i.repos.map((r) => repoById(r)?.full_name) })),
          repos: [...app.repos.values()].map((r) => ({ id: r.id, full_name: r.full_name, files: Object.fromEntries([...r.branches].map(([b, f]) => [b, Object.fromEntries(f)])), pulls: r.pulls })),
        });
      if (req.method === 'POST' && p === '/__app/next-install') {
        const b = json();
        app.nextInstall = { repos: b.repos ?? ['example/family-finder'], readOnly: b.readOnly ?? [] };
        for (const name of app.nextInstall.repos) repoNamed(name);
        return send(200, { repos: app.nextInstall.repos.map((n) => ({ full_name: n, id: repoNamed(n).id })) });
      }
      if (req.method === 'POST' && p === '/__app/merge') {
        const { repo, number } = json();
        const r = repoNamed(repo);
        const pr = r.pulls.find((x) => x.number === number);
        if (!pr) return send(404, { message: 'Not Found' });
        for (const [path, text] of r.branches.get(pr.head) ?? []) r.branches.get(r.default_branch).set(path, text);
        pr.state = 'closed';
        pr.merged = true;
        return send(200, pr);
      }
      if (req.method === 'POST' && p === '/__app/hold') {
        app.holdDispatches = !!json().hold;
        return send(200, {});
      }
      if (req.method === 'POST' && p === '/__app/release') {
        const held = app.held.splice(0);
        for (const answer of held) answer();
        return send(200, { released: held.length });
      }
      if (req.method === 'POST' && p === '/__app/reset') {
        resetApp();
        return send(200, {});
      }

      /* ---------------- the GitHub App: GitHub's side ---------------- */
      // The install page: install on what /__app/next-install set up, and send the browser back to Concord.
      if (req.method === 'GET' && (mm = m(/^\/apps\/[^/]+\/installations\/new$/))) {
        const id = String(++app.nextInstallation);
        app.installations.set(id, { repos: app.nextInstall.repos.map((n) => repoNamed(n).id), readOnly: app.nextInstall.readOnly.map((n) => repoNamed(n).id) });
        const code = `stub-code-${randomUUID()}`;
        app.codes.set(code, id);
        const back = new URL(opts.callbackUrl ?? 'http://localhost/api/github-app/setup');
        back.searchParams.set('code', code);
        back.searchParams.set('installation_id', id);
        back.searchParams.set('setup_action', 'install');
        if (url.searchParams.get('state')) back.searchParams.set('state', url.searchParams.get('state'));
        return res.writeHead(302, { location: back.toString() }).end();
      }
      if (req.method === 'POST' && p === '/login/oauth/access_token') {
        const b = json();
        if (b.client_id !== opts.clientId || b.client_secret !== opts.clientSecret || !app.codes.has(b.code)) return send(200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
        const token = `ghu_${randomUUID()}`;
        app.userTokens.set(token, app.codes.get(b.code));
        app.codes.delete(b.code);
        return send(200, { access_token: token, token_type: 'bearer' });
      }
      if (req.method === 'GET' && (mm = m(/^\/user\/installations\/(\d+)\/repositories$/))) {
        const token = auth?.replace(/^Bearer /, '');
        if (app.userTokens.get(token) !== mm[1]) return send(404, { message: 'Not Found' });
        const inst = app.installations.get(mm[1]);
        // As GitHub does, each repository says what the signed-in person may do with it.
        const permissions = (id) => (inst.readOnly?.includes(id) ? { admin: false, maintain: false, push: false, triage: false, pull: true } : { admin: false, maintain: false, push: true, triage: true, pull: true });
        return send(200, { total_count: inst.repos.length, repositories: inst.repos.map((id) => repoById(id)).map((r) => ({ id: Number(r.id), full_name: r.full_name, permissions: permissions(r.id) })) });
      }
      if (req.method === 'DELETE' && m(/^\/applications\/[^/]+\/token$/)) {
        const token = json().access_token;
        app.revoked.push(token);
        app.userTokens.delete(token);
        return send(204);
      }
      if (req.method === 'POST' && (mm = m(/^\/app\/installations\/(\d+)\/access_tokens$/))) {
        if (!appJwtOk(auth)) return send(401, { message: 'A JSON web token could not be decoded' });
        const inst = app.installations.get(mm[1]);
        if (!inst) return send(404, { message: 'Not Found' });
        const b = json();
        const repoIds = (b.repository_ids ?? []).map(String);
        if (repoIds.some((id) => !inst.repos.includes(id))) return send(422, { message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' });
        const token = `ghs_${randomUUID()}`;
        app.tokens.set(token, { installationId: mm[1], repoIds, permissions: b.permissions ?? {} });
        app.tokenRequests.push({ installationId: mm[1], repoIds, permissions: b.permissions ?? {} });
        return send(201, { token, permissions: b.permissions });
      }
      // Everything below acts as an installation, on the repositories and permissions its token has.
      const inst = app.tokens.get(auth?.replace(/^Bearer /, '') ?? '');
      const may = (r, perm, level = 'write') => inst && inst.repoIds.includes(r.id) && (perm === undefined || inst.permissions[perm] === level || inst.permissions[perm] === 'write');
      if (req.method === 'GET' && (mm = m(/^\/repositories\/(\d+)$/))) {
        const r = repoById(mm[1]);
        if (!r || !may(r)) return send(404, { message: 'Not Found' });
        return send(200, { id: Number(r.id), full_name: r.full_name, default_branch: r.default_branch });
      }
      const repoPath = m(/^\/repos\/([^/]+)\/([^/]+)(\/.*)$/);
      if (repoPath) {
        const r = app.repos.get(`${decodeURIComponent(repoPath[1])}/${decodeURIComponent(repoPath[2])}`.toLowerCase());
        if (!r || !may(r)) return send(404, { message: 'Not Found' });
        const rest = repoPath[3];
        if (req.method === 'POST' && (mm = rest.match(/^\/actions\/workflows\/([^/]+)\/dispatches$/))) {
          if (!may(r, 'actions')) return send(403, { message: 'Resource not accessible by integration' });
          const ref = json().ref;
          if (!r.branches.get(ref)?.has(`.github/workflows/${decodeURIComponent(mm[1])}`)) return send(404, { message: 'Not Found' });
          const workflow = decodeURIComponent(mm[1]);
          const accept = () => {
            app.dispatches.push({ repo: r.full_name, workflow, ref, at: new Date().toISOString() });
            send(204);
          };
          if (app.holdDispatches) return void app.held.push(accept);
          return accept();
        }
        if ((mm = rest.match(/^\/contents\/(.+)$/))) {
          const path = decodeURIComponent(mm[1]);
          if (req.method === 'GET') {
            const text = r.branches.get(url.searchParams.get('ref') ?? r.default_branch)?.get(path);
            return text === undefined ? send(404, { message: 'Not Found' }) : send(200, { sha: sha(text), content: Buffer.from(text).toString('base64') });
          }
          if (req.method === 'PUT') {
            if (!may(r, 'contents') || (path.startsWith('.github/workflows/') && !may(r, 'workflows'))) return send(403, { message: 'Resource not accessible by integration' });
            const b = json();
            const files = r.branches.get(b.branch);
            if (!files) return send(404, { message: 'Branch not found' });
            if (files.has(path) && b.sha !== sha(files.get(path))) return send(409, { message: 'sha does not match' });
            const text = Buffer.from(b.content, 'base64').toString('utf8');
            files.set(path, text);
            return send(201, { content: { sha: sha(text) } });
          }
        }
        if (req.method === 'GET' && (mm = rest.match(/^\/git\/ref\/heads\/(.+)$/))) {
          const b = decodeURIComponent(mm[1]);
          return r.branches.has(b) ? send(200, { object: { sha: `${b}-head` } }) : send(404, { message: 'Not Found' });
        }
        if (req.method === 'POST' && rest === '/git/refs') {
          if (!may(r, 'contents')) return send(403, { message: 'Resource not accessible by integration' });
          const b = json().ref.replace(/^refs\/heads\//, '');
          if (r.branches.has(b)) return send(422, { message: 'Reference already exists' });
          r.branches.set(b, new Map(r.branches.get(r.default_branch)));
          return send(201, { ref: `refs/heads/${b}` });
        }
        if (rest === '/pulls' && req.method === 'GET') {
          const head = url.searchParams.get('head')?.split(':')[1];
          return send(200, r.pulls.filter((x) => x.state === 'open' && (!head || x.head === head)));
        }
        if (rest === '/pulls' && req.method === 'POST') {
          if (!may(r, 'pull_requests')) return send(403, { message: 'Resource not accessible by integration' });
          const b = json();
          const pr = { number: app.nextPr++, html_url: `https://github.com/${r.full_name}/pull/${app.nextPr - 1}`, state: 'open', head: b.head, base: b.base, title: b.title, body: b.body };
          r.pulls.push(pr);
          return send(201, pr);
        }
      }
      send(404, { message: 'Not Found' });
    });
  });

  return {
    server,
    /** Start listening; resolves with the stand-in's base URL. */
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) =>
        server.listen(port, host, () => {
          base = `http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`;
          resolve(base);
        }),
      );
    },
    /** For a test that wants to set the callback after it knows its own port. */
    set callbackUrl(v) {
      opts.callbackUrl = v;
    },
    mintOidc,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8799);
  const stub = createGithubStub({
    appId: process.env.GITHUB_APP_ID,
    publicKey: process.env.GITHUB_APP_PUBLIC_KEY,
    clientId: process.env.GITHUB_APP_CLIENT_ID,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
    callbackUrl: process.env.CALLBACK_URL,
  });
  // The issuer in minted tokens must match what Concord expects (GITHUB_OIDC_ISSUER), so name the host as Concord does.
  stub.listen(port, 'localhost').then((url) => console.log(`GitHub stub on ${url}`));
}
