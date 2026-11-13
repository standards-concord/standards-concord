import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Bug, History, KeyRound, Sparkles } from 'lucide-react';
import { APP_RELEASES, type ChangeWithRelease } from '@concord/shared';
import { api } from '../api';
import { useAction } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useDemoOntology } from '../lib/ontologies';
import { CURRENT_RELEASE, changeLink, serverRendered, useTester } from '../lib/tester';
import { TESTER_ROLES } from '../lib/walkthrough';
import { formatDate } from '../lib/format';
import { GitHubIcon, GoogleIcon } from './badges';
import { Disclosure } from './Disclosure';
import { Badge, Button, Card, InlineError, Select, buttonClasses, cx } from './ui';

/**
 * The alpha tester's status, for the top of the alpha pages: the version of
 * Concord they're testing, a prompt to sign in so that version and their
 * feedback are saved to their pod, and what changed since the version they
 * last tested (which they pick themselves when we don't know it).
 */
export function TesterStatus({ className, returnTo = '/alpha', compact }: { className?: string; returnTo?: string; compact?: boolean }) {
  const t = useTester();
  const { session } = useSession();
  // Whose answer in the fold this is: once someone picks a version there, the fold stays (mounted and open) for
  // them, so the picker doesn't vanish from under the keyboard and "This is my first time" doesn't fold it away.
  const [pickedBy, setPickedBy] = useState<string | null>();
  const who = session?.user?.id ?? null;
  // A first-time tester needs neither the version picker nor the sign-in prompt, so both fold into one link.
  if (!t.since || (pickedBy !== undefined && pickedBy === who))
    return (
      <Card className={cx('divide-y divide-line', className)}>
        <div className={compact ? 'p-4' : 'p-4 sm:p-5'}>
          <VersionLine />
        </div>
        <div className={compact ? 'px-4 py-3' : 'px-4 py-3 sm:px-5'}>
          <Disclosure title="What’s new since you last tested?">
            <div className="space-y-4 pt-1">
              <WhatsChanged showTitle={!!t.since} onPick={() => setPickedBy(who)} />
              <SavePrompt returnTo={returnTo} />
            </div>
          </Disclosure>
        </div>
      </Card>
    );
  if (compact)
    // Once the walkthrough is under way, keep this out of the way: the changes fold up.
    return (
      <Card className={cx('divide-y divide-line', className)}>
        <div className="space-y-3 p-4">
          <VersionLine />
          <SavePrompt returnTo={returnTo} />
        </div>
        <div className="px-4 py-3">
          <Disclosure title={`What’s changed since ${t.since}`} summary={`${t.changes.length} change${t.changes.length === 1 ? '' : 's'}`}>
            <WhatsChanged />
          </Disclosure>
        </div>
      </Card>
    );
  return (
    <Card className={cx('divide-y divide-line', className)}>
      <div className="p-4 sm:p-5">
        <VersionLine />
      </div>
      <div className="p-4 sm:p-5">
        <SavePrompt returnTo={returnTo} />
      </div>
      <div className="p-4 sm:p-5">
        <WhatsChanged />
      </div>
    </Card>
  );
}

/** "You're testing Concord 0.9.0", with the build and the full release notes. */
export function VersionLine() {
  const t = useTester();
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span>You’re testing</span>
        <Badge tone="accent" title={`Concord version ${t.version}`}>
          <span data-testid="app-version">Concord {t.version}</span>
        </Badge>
        <span className="text-muted">
          {CURRENT_RELEASE.title}, released {formatDate(CURRENT_RELEASE.date)}
          {t.commit && (
            <>
              {' '}
              · build <code className="font-mono text-xs">{t.commit.slice(0, 7)}</code>
            </>
          )}
        </span>
      </p>
      <Disclosure tone="muted" title={<span className="text-xs">Release notes for every version</span>}>
        <ol className="max-h-80 space-y-3 overflow-y-auto pr-1 text-sm">
          {APP_RELEASES.map((r) => (
            <li key={r.version}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-xs font-semibold">{r.version}</span>
                <span className="font-medium">{r.title}</span>
                <span className="text-xs text-subtle">{formatDate(r.date)}</span>
              </div>
              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                {r.changes.map((c) => (
                  <li key={c.id}>
                    {c.type === 'fix' ? 'Fixed: ' : c.type === 'breaking' ? 'Breaking: ' : ''}
                    {c.title}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </Disclosure>
    </div>
  );
}

function OAuthButtons({ returnTo }: { returnTo: string }) {
  const { session } = useSession();
  if (!session?.providers.google && !session?.providers.github) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {session.providers.google && (
        <a href={api.oauthUrl('google', returnTo)} className={buttonClasses('secondary', 'sm')}>
          <GoogleIcon /> Sign in with Google
        </a>
      )}
      {session.providers.github && (
        <a href={api.oauthUrl('github', returnTo)} className={buttonClasses('secondary', 'sm')}>
          <GitHubIcon /> Sign in with GitHub
        </a>
      )}
    </div>
  );
}

/** Encourage sign-in, and say where the tester's record is kept. */
function SavePrompt({ returnTo }: { returnTo: string }) {
  const t = useTester();
  const { session, setSession } = useSession();
  const oauth = !!(session?.providers.google || session?.providers.github);
  const start = useAction(async () => {
    setSession(await api.demoLogin({ name: 'Alpha tester' }));
  });
  const tester = t.me?.tester;
  const where = t.me?.storedIn === 'solid' ? 'your Solid pod' : 'your private storage on this server';

  if (!session || (t.meLoading && !t.me)) return <p className="text-sm text-muted">Checking who’s testing…</p>;
  const podBehind = t.me?.podBehind && t.me.storedIn === 'solid' && (
    <p role="status" className="text-muted">
      Your pod couldn’t be reached just now, so its copy is a little behind. Nothing is lost: it catches up next time.
    </p>
  );

  if (tester?.lasting)
    return (
      <div role="group" aria-label="Your testing record" className="space-y-2 text-sm">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          <p>
            Signed in as <strong>{tester.name}</strong>. The versions you test and your feedback are saved to {where}
            {t.me?.versions.length ? ` (${t.me.versions.length} version${t.me.versions.length === 1 ? '' : 's'} so far)` : ''}.
            {session.user?.id !== tester.id && <span className="text-muted"> That stays true while you play someone else in the demo.</span>}
          </p>
        </div>
        {podBehind}
      </div>
    );

  if (tester)
    return (
      <div role="group" aria-label="Your testing record" className="space-y-2 text-sm">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          <p>
            You’re using a tester account kept in this browser. The versions you test and your feedback are saved to {where}.{' '}
            {oauth ? (
              <strong>Sign in to keep them and come back to them from any device.</strong>
            ) : (
              <span className="text-muted">Signing in with Google or GitHub isn’t switched on for this site yet, so come back in this browser to pick up where you left off.</span>
            )}
          </p>
        </div>
        {podBehind}
        <OAuthButtons returnTo={returnTo} />
      </div>
    );

  return (
    <div role="group" aria-label="Your testing record" className="space-y-2 text-sm">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
        <div>
          <p className="font-medium">Sign in so we can remember what you tested</p>
          <p className="text-muted">
            We’ll save the version you test and a copy of your feedback to your own Solid pod. Next time, you’ll see what’s changed and we’ll only ask about that.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <OAuthButtons returnTo={returnTo} />
        {session.providers.demo && (
          <Button size="sm" variant={oauth ? 'ghost' : 'primary'} loading={start.pending} onClick={() => void start.run()}>
            {oauth ? 'Or keep a tester account in this browser' : 'Keep a tester account in this browser'}
          </Button>
        )}
      </div>
      <InlineError error={start.error} />
    </div>
  );
}

function VersionPicker({ id, onPicked }: { id: string; onPicked?: () => void }) {
  const t = useTester();
  return (
    <div className="flex max-w-xl flex-wrap items-center gap-2 text-sm">
      <label htmlFor={id} className="font-medium">
        {t.hasHistory ? 'Compare with' : 'Last version you tested'}
      </label>
      <Select
        id={id}
        className="h-8 w-auto max-w-full text-xs"
        value={t.since ?? (t.baselineSource === 'picked' ? 'first' : '')}
        onChange={(e) => {
          const v = e.target.value;
          onPicked?.();
          t.pickSince(v === 'first' ? null : v || undefined);
        }}
      >
        {!t.since && t.baselineSource !== 'picked' && <option value="">Choose…</option>}
        {!t.hasHistory && <option value="first">This is my first time</option>}
        {t.earlier.map((r) => (
          <option key={r.version} value={r.version}>
            {r.version}: {r.title} ({formatDate(r.date)})
            {r.version === t.baseline && t.hasHistory ? ' (last tested)' : ''}
          </option>
        ))}
      </Select>
    </div>
  );
}

const SOURCE_LABEL = { picked: 'you picked it', pod: 'from your pod', browser: 'from this browser', compare: 'comparing' } as const;

/**
 * What changed since the tester's last version, or a picker to find out. The
 * picker stays open while they try versions, until they press Done, which
 * returns focus to the button that opened it; a status line announces the result.
 */
export function WhatsChanged({ showTitle = true, onPick }: { showTitle?: boolean; onPick?: () => void } = {}) {
  const t = useTester();
  const demo = useDemoOntology();
  const role = TESTER_ROLES.find((r) => r.key === t.roleKey);
  const pickerId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const undecided = !t.since && t.baselineSource !== 'picked';
  const [picking, setPicking] = useState(false);
  const showPicker = picking || undecided;
  const done = () => {
    setPicking(false);
    requestAnimationFrame(() => toggle.current?.focus());
  };
  const n = t.changes.length;
  const status = t.since ? `Showing ${n} change${n === 1 ? '' : 's'} since ${t.since}.` : t.baselineSource === 'picked' ? 'First time testing: everything is new to you.' : '';
  const shown = t.forRole.slice(0, 5);
  const rest = t.forRole.slice(5);

  return (
    <div className="space-y-3" role="region" aria-label="What’s changed">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {showTitle && (
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <History className="size-4 text-accent" aria-hidden /> {t.since ? `What’s changed since ${t.since}` : 'Tested Concord before?'}
          </h2>
        )}
        {!undecided && (
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            {t.since && (
              <span>
                {n} change{n === 1 ? '' : 's'} · {SOURCE_LABEL[t.sinceSource!]}
              </span>
            )}
            {t.sinceSource === 'compare' && (
              <button type="button" className="text-accent hover:underline" onClick={() => t.pickSince(undefined)}>
                Back to {t.baseline ? `your last tested version (${t.baseline})` : 'your history'}
              </button>
            )}
            <button ref={toggle} type="button" className="text-accent hover:underline" aria-expanded={showPicker} aria-controls={pickerId} onClick={() => (picking ? done() : setPicking(true))}>
              {picking ? 'Done' : t.hasHistory ? 'Compare with another version' : 'Change'}
            </button>
          </span>
        )}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
      {undecided && <p className="text-sm text-muted">Pick the last version you tried and we’ll show you what’s changed since, point you at it, and ask about that rather than everything.</p>}
      {showPicker && (
        <VersionPicker
          id={pickerId}
          onPicked={() => {
            setPicking(true);
            onPick?.();
          }}
        />
      )}
      {!t.since && t.baselineSource === 'picked' && <p className="text-sm text-muted">Welcome! Everything is new to you, so the walkthrough covers it all.</p>}
      {t.since && (
        <>
          {role && t.forRole.some((c) => c.roles.includes(role.key)) && <p className="text-xs text-muted">Changes for {role.title.toLowerCase()}s come first.</p>}
          {n === 0 ? <p className="text-sm text-muted">Nothing has changed since then.</p> : <ChangeList changes={shown} demoId={demo?.id} />}
          {rest.length > 0 && (
            <Disclosure tone="muted" title={<span className="text-xs">Show all {n} changes</span>}>
              <ChangeList changes={rest} demoId={demo?.id} />
            </Disclosure>
          )}
        </>
      )}
    </div>
  );
}

export function ChangeList({ changes, demoId, compact }: { changes: ChangeWithRelease[]; demoId?: string; compact?: boolean }) {
  const t = useTester();
  return (
    <ul className="space-y-2">
      {changes.map((c) => {
        const href = changeLink(c.to, demoId);
        const mine = !!t.roleKey && c.roles.includes(t.roleKey);
        return (
          <li key={c.id} className="flex items-start gap-2.5 rounded-lg border border-line bg-surface p-2.5" aria-label={c.title}>
            {c.type === 'fix' ? <Bug className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /> : <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-sm font-medium">{c.title}</span>
                <Badge tone="outline">
                  {c.type === 'fix' ? 'Fix' : 'New'} in {c.version}
                </Badge>
                {mine && <Badge tone="accent">For your role</Badge>}
              </div>
              {!compact && <p className="mt-0.5 text-xs text-muted">{c.detail}</p>}
            </div>
            {href && (
              <Link to={href} reloadDocument={serverRendered(href)} className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent hover:underline" aria-label={`Try it: ${c.title}`}>
                Try it <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
