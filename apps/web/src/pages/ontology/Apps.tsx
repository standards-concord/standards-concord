import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { workflowYaml, type AutopilotSettings, type ChangeLevel, type ConnectedApp, type GithubAppStatus, type GovernancePolicy, type Role } from '@concord/shared';
import { AppWindow, CheckCircle2, CircleAlert, ExternalLink, GitPullRequest, KeyRound, Play, Plus, RefreshCw, Trash2, Unlink, Workflow, X } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import { LEVEL_LABEL, relativeTime, roleLabel } from '../../lib/format';
import { Avatar, Badge, Button, Card, CardHeader, CodeBlock, CopyButton, EmptyState, ErrorCard, Field, InlineError, Input, Loading, Select, Toggle } from '../../components/ui';
import { useOntology } from './Layout';

const LEVELS: ChangeLevel[] = ['patch', 'minor', 'major'];
const LEVEL_HINT: Record<ChangeLevel, string> = { patch: 'fixes and wording', minor: 'new terms', major: 'breaking changes' };

/** What autopilot can do for someone with these roles, for each change level. */
function powers(policy: GovernancePolicy, roles: Role[]) {
  return LEVELS.map((level) => {
    const rule = policy.changes[level];
    const approves = rule.approverRoles.some((r) => roles.includes(r)) && rule.minApprovals > 0;
    const votes = !!rule.vote && rule.vote.voterRoles.some((r) => roles.includes(r));
    const text = approves && votes ? 'approves in review and votes yes' : approves ? 'approves in review' : votes ? 'votes yes when it goes to a vote' : 'can only report results (your role doesn’t approve or vote on these)';
    return { level, approves, votes, text };
  });
}

function BaselineBadge({ app }: { app: ConnectedApp }) {
  const { now } = useSession();
  if (!app.baseline) return <Badge tone="outline">Not run yet</Badge>;
  // The working draft has moved on since the app last tested it.
  if (app.baseline.current === false)
    return (
      <Badge tone="outline" title={`Last run ${relativeTime(app.baseline.at, now())}: ${app.baseline.outcome}`}>
        {app.baseline.outcome === 'passed' ? 'Passed an earlier draft' : 'Failed an earlier draft'}, waiting for a new run
      </Badge>
    );
  if (app.baseline.outcome === 'passed')
    return (
      <Badge tone="ok" icon={CheckCircle2}>
        Passes the working draft
      </Badge>
    );
  return (
    <Badge tone="danger" icon={CircleAlert} title={app.baseline.summary}>
      {app.baseline.outcome === 'failed' ? 'Fails the working draft' : 'Could not run'}
    </Badge>
  );
}

function TokenSteps({ app, token }: { app: ConnectedApp; token?: string }) {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const yaml = workflowYaml(origin);
  const repoUrl = app.repo ? `https://github.com/${app.repo}` : undefined;
  return (
    <ol className="space-y-4 text-sm">
      <li>
        <div className="mb-1 font-medium">1. Add the app token as a repository secret named <code className="font-mono">CONCORD_APP_TOKEN</code></div>
        {token ? (
          <div className="rounded-lg border border-warn/40 bg-warn-soft p-3">
            <p className="mb-2 font-medium">Copy the token now. It won’t be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1.5 font-mono text-xs" data-testid="app-token">
                {token}
              </code>
              <CopyButton text={token} label="Copy" />
            </div>
          </div>
        ) : (
          <p className="text-muted">
            The token starts <code className="font-mono">{app.tokenPrefix}…</code>. Lost it? Replace it below and update the secret.
          </p>
        )}
        {repoUrl && (
          <a className="mt-1 inline-flex items-center gap-1 text-accent hover:underline" href={`${repoUrl}/settings/secrets/actions/new`} target="_blank" rel="noreferrer">
            Open {app.repo}’s secrets <ExternalLink className="size-3" />
          </a>
        )}
      </li>
      <li>
        <div className="mb-1 font-medium">2. Add this workflow</div>
        <p className="mb-2 text-muted">
          Change <code className="font-mono">npm ci</code> and <code className="font-mono">npm test</code> to however your app installs and tests itself. Each run tests the working draft, then each open change that it hasn’t tested yet.
        </p>
        <CodeBlock code={yaml} language="yaml" ariaLabel="Workflow file" maxHeight={360} />
        {repoUrl && (
          <a
            className="mt-1 inline-flex items-center gap-1 text-accent hover:underline"
            href={`${repoUrl}/new/main?filename=${encodeURIComponent('.github/workflows/concord.yml')}&value=${encodeURIComponent(yaml)}`}
            target="_blank"
            rel="noreferrer"
          >
            Create it in {app.repo} <ExternalLink className="size-3" />
          </a>
        )}
      </li>
      <li>
        <div className="mb-1 font-medium">3. Run it once</div>
        <p className="text-muted">Start it from the Actions tab (“Run workflow”). Results appear on each change request’s page within a minute of the run finishing.</p>
      </li>
    </ol>
  );
}

/** Connected through the Concord GitHub App: add the workflow (Concord can open the pull request), and Concord starts it. */
function GithubSteps({ app, onChange }: { app: ConnectedApp; onChange: (a: ConnectedApp) => void }) {
  const { now } = useSession();
  const gh = app.github!;
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const yaml = workflowYaml(origin, { app: app.id });
  const [already, setAlready] = useState(false);
  const pr = useAction(async () => {
    const out = await api.openWorkflowPr(app.id);
    setAlready(!!out.alreadyThere);
    onChange(out.app);
  });
  const run = useAction(async () => onChange(await api.runGithubNow(app.id)));
  const unlink = useAction(async () => {
    if (!confirm(`Stop connecting ${app.name} through GitHub? Concord stops starting its runs, and runs without the app token can’t sign in. To remove the Concord app’s access to ${gh.repo}, uninstall it on GitHub too.`)) return;
    onChange(await api.unlinkGithub(app.id));
  });
  const last = gh.lastDispatch;
  return (
    <ol className="space-y-4 text-sm">
      <li>
        <div className="mb-1 font-medium">1. Add the workflow to {gh.repo}</div>
        <p className="mb-2 text-muted">
          It has no secret: the run signs in with GitHub’s proof that it runs in {gh.repo}. Change <code className="font-mono">npm ci</code> and <code className="font-mono">npm test</code> to however your app installs and tests itself.
        </p>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {gh.workflowPr ? (
            <a className="inline-flex items-center gap-1 font-medium text-accent hover:underline" href={gh.workflowPr.url} target="_blank" rel="noreferrer">
              <GitPullRequest className="size-4" /> Pull request #{gh.workflowPr.number} adds it <ExternalLink className="size-3" />
            </a>
          ) : null}
          <Button size="sm" variant={gh.workflowPr ? 'ghost' : 'primary'} icon={GitPullRequest} loading={pr.pending} disabled={gh.suspended} onClick={() => void pr.run()}>
            {gh.workflowPr ? 'Update the pull request' : 'Open a pull request that adds it'}
          </Button>
        </div>
        {already && <p className="mb-2 text-ok">{gh.repo} already has this workflow. Nothing to add.</p>}
        <InlineError error={pr.error} />
        <CodeBlock code={yaml} language="yaml" ariaLabel="Workflow file" maxHeight={360} />
      </li>
      <li>
        <div className="mb-1 font-medium">2. Concord starts it</div>
        <p className="text-muted">Whenever a change is proposed or edited, or the working draft moves on, Concord starts the workflow (at most every two minutes). It also starts once when the pull request is merged.</p>
        {gh.suspended ? (
          <p className="mt-1 text-warn">The Concord app is suspended on {gh.repo}, so Concord can’t start runs. Unsuspend it on GitHub.</p>
        ) : last ? (
          <p className={last.ok ? 'mt-1 text-muted' : 'mt-1 text-warn'} data-testid="last-dispatch">
            {last.ok ? `Last started ${relativeTime(last.at, now())}.` : `Couldn’t start a run ${relativeTime(last.at, now())}: ${last.message ?? 'GitHub refused'}`}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" icon={Play} loading={run.pending} disabled={gh.suspended} onClick={() => void run.run()}>
            Start a run now
          </Button>
          <Button size="sm" variant="ghost" icon={Unlink} loading={unlink.pending} onClick={() => void unlink.run()}>
            Stop using GitHub
          </Button>
        </div>
        <InlineError error={run.error ?? unlink.error} />
      </li>
    </ol>
  );
}

/** How to set up the app's CI: through the Concord GitHub App if this Concord has one, with the token route alongside. */
function SetupSteps({ app, token, githubApp, onChange }: { app: ConnectedApp; token?: string; githubApp?: GithubAppStatus; onChange: (a: ConnectedApp) => void }) {
  const connect = useAction(async () => {
    const { url } = await api.startGithubInstall(app.id);
    location.assign(url);
  });
  if (!githubApp?.enabled) return <TokenSteps app={app} token={token} />;
  if (app.github) return <GithubSteps app={app} onChange={onChange} />;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-accent/40 bg-accent-soft/40 p-3 text-sm">
        <p className="mb-2 font-medium">Recommended: connect with GitHub</p>
        <p className="mb-3 text-muted">
          Install the Concord app on {app.repo ?? 'your app’s repository'}. There’s no token to store, Concord can open the pull request that adds the workflow, and it starts a run as soon as there is something new to test.{' '}
          {githubApp.url && (
            <a className="text-accent hover:underline" href={githubApp.url} target="_blank" rel="noreferrer">
              What it can access
            </a>
          )}
        </p>
        <Button size="sm" variant="primary" loading={connect.pending} onClick={() => void connect.run()}>
          Connect with GitHub
        </Button>
        <InlineError error={connect.error} />
      </div>
      <details open={!!token} className="text-sm">
        <summary className="cursor-pointer font-medium">Or use a token and add the workflow yourself</summary>
        <div className="mt-3">
          <TokenSteps app={app} token={token} />
        </div>
      </details>
    </div>
  );
}

function AutopilotEditor({ app, onSaved, policyOff }: { app: ConnectedApp; onSaved: (a: ConnectedApp) => void; policyOff: boolean }) {
  const { ontology, myRoles } = useOntology();
  const save = useAction(async (autopilot: Partial<AutopilotSettings>) => onSaved(await api.updateApp(app.id, { autopilot })));
  const a = app.autopilot;
  const what = powers(ontology.governance, myRoles);
  const toggleLevel = (l: ChangeLevel, on: boolean) => void save.run({ levels: on ? LEVELS.filter((x) => x === l || a.levels.includes(x)) : a.levels.filter((x) => x !== l) });
  return (
    <div className="space-y-3">
      <Toggle checked={a.enabled} disabled={save.pending || policyOff} onChange={(enabled) => void save.run({ enabled })} label={<span className="font-medium">Autopilot: say yes for me when this app passes</span>} />
      {policyOff && <p className="text-xs text-warn">This ontology’s governance policy has autopilot turned off. Results are still shown on each change.</p>}
      {a.enabled && !policyOff && (
        <div className="space-y-3 rounded-lg border border-line bg-surface-2/50 p-3 text-sm">
          <fieldset>
            <legend className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Changes autopilot may say yes to</legend>
            <div className="space-y-1">
              {what.map((p) => (
                <label key={p.level} className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={a.levels.includes(p.level)} disabled={save.pending} onChange={(e) => toggleLevel(p.level, e.target.checked)} />
                  <span>
                    <span className="font-medium">{LEVEL_LABEL[p.level]}</span> <span className="text-muted">({LEVEL_HINT[p.level]}):</span> <span className={p.approves || p.votes ? '' : 'text-muted'}>{p.text}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold tracking-wide text-muted uppercase">When the app fails</span>
            <Select value={a.onFailure} disabled={save.pending} onChange={(e) => void save.run({ onFailure: e.target.value as AutopilotSettings['onFailure'] })} aria-label="When the app fails">
              <option value="report">Show the failure and take back any autopilot yes</option>
              <option value="oppose">Also vote no for me when it goes to a vote</option>
            </Select>
          </label>
          <p className="text-xs text-muted">
            Autopilot only acts on verified runs: GitHub Actions runs in this app’s repository that GitHub vouches for (the workflow file asks for this with <code>id-token: write</code>), or results you report yourself while signed in. A run with only the app token shows its results but doesn’t move autopilot.
          </p>
          {!app.repo && <p className="text-xs text-warn">Add the app’s GitHub repository so Concord can check its runs come from there.</p>}
          <p className="text-xs text-muted">
            Autopilot waits until all of your apps with autopilot on have tested the current version of a change, does nothing if an app already fails the working draft, and never overrides a review or vote you make yourself. Your roles: {myRoles.map(roleLabel).join(', ') || 'none yet'}.
          </p>
        </div>
      )}
      <InlineError error={save.error} />
    </div>
  );
}

function MyApp({
  app,
  token,
  onChange,
  onRemoved,
  policyOff,
  githubApp,
  justConnected,
}: {
  app: ConnectedApp;
  token?: string;
  onChange: (a: ConnectedApp, token?: string) => void;
  onRemoved: () => void;
  policyOff: boolean;
  githubApp?: GithubAppStatus;
  justConnected?: boolean;
}) {
  const { now } = useSession();
  const [setup, setSetup] = useState(!!token || !!justConnected);
  const rotate = useAction(async () => {
    if (!confirm('Replace the token? The old one stops working, so update the CONCORD_APP_TOKEN secret afterwards.')) return;
    const a = await api.rotateAppToken(app.id);
    onChange(a, a.token);
    setSetup(true);
  });
  const remove = useAction(async () => {
    if (!confirm(`Remove ${app.name}? Its results disappear from change requests. Reviews and votes autopilot already made stay.`)) return;
    await api.deleteApp(app.id);
    onRemoved();
  });
  return (
    <Card as="section">
      <CardHeader
        icon={AppWindow}
        title={app.name}
        subtitle={
          <>
            {app.repo ? (
              <a className="text-accent hover:underline" href={`https://github.com/${app.repo}`} target="_blank" rel="noreferrer">
                {app.repo}
              </a>
            ) : (
              'No repository set'
            )}{' '}
            {app.github && '· connected through GitHub '}· {app.lastSeenAt ? `CI last checked in ${relativeTime(app.lastSeenAt, now())}` : 'CI hasn’t checked in yet'}
          </>
        }
        actions={<BaselineBadge app={app} />}
      />
      <div className="space-y-4 p-5">
        <AutopilotEditor app={app} onSaved={(a) => onChange(a)} policyOff={policyOff} />
        <div className="border-t border-line pt-4">
          <button className="text-sm font-medium text-accent hover:underline" aria-expanded={setup} onClick={() => setSetup((s) => !s)}>
            {setup ? 'Hide CI setup' : 'Set up CI'}
          </button>
          {setup && (
            <div className="mt-3">
              <SetupSteps app={app} token={token} githubApp={githubApp} onChange={(a) => onChange(a)} />
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          <Button size="sm" icon={RefreshCw} loading={rotate.pending} onClick={() => void rotate.run()}>
            Replace token
          </Button>
          <Button size="sm" variant="ghost" icon={Trash2} className="text-danger" loading={remove.pending} onClick={() => void remove.run()}>
            Remove app
          </Button>
        </div>
        <InlineError error={rotate.error ?? remove.error} />
      </div>
    </Card>
  );
}

function ConnectForm({ ontologyId, onCreated }: { ontologyId: string; onCreated: (a: ConnectedApp) => void }) {
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const create = useAction(async () => {
    const a = await api.createApp(ontologyId, { name: name.trim(), repo: repo.trim() || undefined });
    setName('');
    setRepo('');
    onCreated(a);
  });
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        void create.run();
      }}
    >
      <Field label="App name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rota planner" required />
      </Field>
      <Field label="GitHub repository (optional)">
        <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" />
      </Field>
      <Button type="submit" variant="primary" icon={Plus} loading={create.pending} disabled={!name.trim()}>
        Connect app
      </Button>
      <div className="sm:col-span-3">
        <InlineError error={create.error} />
      </div>
    </form>
  );
}

export function AppsTab() {
  const { id, ontology, myRoles } = useOntology();
  const canDisconnect = myRoles.includes('owner') || myRoles.includes('steward');
  const { session } = useSession();
  const uid = session?.user?.id;
  const state = useAsync(() => api.apps(id), [id]);
  const githubApp = useAsync(() => api.githubApp(), []);
  // Back from installing the Concord app on GitHub: say how it went.
  const [params, setParams] = useSearchParams();
  const connectedId = params.get('github') === 'connected' ? (params.get('app') ?? undefined) : undefined;
  const githubError = params.get('github_error');
  const dismiss = () => setParams((p) => {
    p.delete('github');
    p.delete('app');
    p.delete('github_error');
    return p;
  }, { replace: true });
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const policyOff = ontology.governance.automation.appAutopilot === false;
  // Results come in from CI at any time; keep the page current while it's open.
  const { reload } = state;
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 30_000);
    return () => clearInterval(t);
  }, [reload]);

  if (state.error && !state.data) return <ErrorCard error={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading />;
  const mine = state.data.filter((a) => a.ownerId === uid);
  const others = state.data.filter((a) => a.ownerId !== uid);
  const replace = (a: ConnectedApp, token?: string) => {
    state.setData((prev) => (prev ?? []).map((x) => (x.id === a.id ? a : x)));
    if (token) setTokens((t) => ({ ...t, [a.id]: token }));
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">App checks</h2>
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void reload()} disabled={state.loading}>
            Refresh
          </Button>
        </div>
        <p className="max-w-3xl text-sm text-muted">
          Connect your app and its CI tests it against every proposed change. Results show on each{' '}
          <Link className="text-accent hover:underline" to={`/o/${id}/changes`}>
            change request
          </Link>
          . With autopilot on, a pass counts as your approval or yes vote.
        </p>
      </div>

      {(connectedId || githubError) && (
        <div role="status" className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${githubError ? 'border-warn/40 bg-warn-soft' : 'border-ok/40 bg-ok-soft'}`}>
          <p className="flex-1">
            {githubError
              ? `Couldn’t connect through GitHub: ${githubError}`
              : `Connected ${state.data.find((a) => a.id === connectedId)?.name ?? 'your app'} through GitHub. Next, add the workflow: Concord can open the pull request for you.`}
          </p>
          <Button size="sm" variant="ghost" icon={X} aria-label="Dismiss" onClick={dismiss} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader icon={Plus} title="Connect an app" subtitle={githubApp.data?.enabled ? 'Then connect it with GitHub, or use a token and add a workflow file.' : 'You get a token for its CI and a workflow file to add.'} />
            <div className="p-5">
              <ConnectForm
                ontologyId={id}
                onCreated={(a) => {
                  state.setData((prev) => [...(prev ?? []), a]);
                  if (a.token) setTokens((t) => ({ ...t, [a.id]: a.token! }));
                }}
              />
            </div>
          </Card>

          {mine.length ? (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">Your apps</h3>
              {mine.map((a) => (
                <MyApp
                  key={a.id}
                  app={a}
                  token={tokens[a.id]}
                  policyOff={policyOff}
                  githubApp={githubApp.data}
                  justConnected={a.id === connectedId}
                  onChange={replace}
                  onRemoved={() => state.setData((prev) => (prev ?? []).filter((x) => x.id !== a.id))}
                />
              ))}
            </div>
          ) : (
            <EmptyState icon={AppWindow} title="You haven’t connected an app yet">
              Connect one above. {githubApp.data?.enabled ? 'Then install the Concord app on its repository and merge the pull request it opens.' : 'It takes a token, a repository secret and one workflow file.'}
            </EmptyState>
          )}
        </div>

        <div className="space-y-6">
          <Card className="h-fit">
            <CardHeader icon={Workflow} title="How it works" />
            <ol className="list-decimal space-y-2 py-4 pr-5 pl-9 text-sm text-muted">
              <li>Your CI runs the Concord GitHub Action: Concord starts it when there is something new to test (if connected with GitHub), or it runs on a schedule.</li>
              <li>It downloads the working draft and runs your tests. If they fail there, it stops, because the changes can’t be judged.</li>
              <li>For each open change request, it downloads the ontology as it would be after that change and runs your tests again.</li>
              <li>Each result goes to the change request. If the change or the draft moves on, it is tested again.</li>
              <li>With autopilot on, a pass from all your apps becomes your approval or yes vote. A failure takes it back.</li>
            </ol>
            <p className="border-t border-line px-5 py-3 text-xs text-muted">
              Not on GitHub? The action is one Node script with no dependencies:{' '}
              <a className="text-accent hover:underline" href="https://github.com/standards-concord/standards-concord/tree/main/actions/app-check" target="_blank" rel="noreferrer">
                run it in any CI
              </a>
              .
            </p>
          </Card>

          <Card className="h-fit">
            <CardHeader icon={KeyRound} title="Everyone’s apps" subtitle={`${state.data.length} connected`} />
            {others.length ? (
              <ul className="divide-y divide-line">
                {others.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 px-5 py-3 text-sm">
                    <Avatar name={a.owner?.name} src={a.owner?.avatarUrl} simulated={a.owner?.simulated} size={24} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{a.name}</div>
                      <div className="text-xs text-muted">{a.owner?.name}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <BaselineBadge app={a} />
                        {a.autopilot.enabled && <Badge tone="accent">Autopilot on</Badge>}
                        {a.github && <Badge tone="outline">Connected with GitHub</Badge>}
                      </div>
                    </div>
                    {canDisconnect && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Disconnect ${a.name}`}
                        onClick={async () => {
                          if (!confirm(`Disconnect ${a.owner?.name ?? 'this person'}’s app ${a.name}? Its token stops working and its results disappear from change requests.`)) return;
                          await api.deleteApp(a.id);
                          state.setData((prev) => (prev ?? []).filter((x) => x.id !== a.id));
                        }}
                      >
                        Disconnect
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-4 text-sm text-muted">No one else has connected an app yet.</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
