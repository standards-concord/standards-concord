import { useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { ArrowRight, Compass, KeyRound } from 'lucide-react';
import { api } from '../api';
import { useSession } from '../lib/session';
import { useAction } from '../lib/hooks';
import { GitHubIcon, GoogleIcon, WebIdIcon } from '../components/badges';
import { Button, Card, ErrorCard, InlineError, Input, Loading } from '../components/ui';

/**
 * Sign in with your own WebID. A plain GET form: the server finds the WebID's
 * Solid provider and sends the browser there (Solid-OIDC with DPoP).
 */
function SolidSignIn({ next, error }: { next: string; error?: string }) {
  const [open, setOpen] = useState(!!error);
  const [webId, setWebId] = useState('');
  if (!open)
    return (
      <Button size="lg" className="w-full" onClick={() => setOpen(true)}>
        <WebIdIcon /> Sign in with your WebID (Solid)
      </Button>
    );
  return (
    <form
      method="get"
      action="/auth/solid"
      aria-label="Sign in with Solid"
      className="space-y-2 rounded-lg border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (webId.trim()) window.location.assign(api.solidLoginUrl(webId.trim(), next));
      }}
    >
      <label htmlFor="solid-webid" className="flex items-center gap-2 text-sm font-medium">
        <WebIdIcon /> Sign in with your WebID
      </label>
      <Input
        id="solid-webid"
        name="webId"
        type="url"
        inputMode="url"
        autoComplete="url"
        required
        autoFocus
        placeholder="https://you.solidcommunity.net/profile/card#me"
        value={webId}
        onChange={(e) => setWebId(e.target.value)}
        aria-describedby="solid-webid-hint"
        className="w-full"
      />
      <input type="hidden" name="returnTo" value={next} />
      <p id="solid-webid-hint" className="text-xs text-muted">
        Your WebID, or the address of your Solid provider. You’ll sign in there, and Concord checks your WebID names that provider.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger" data-testid="solid-error">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full">
        Continue <ArrowRight className="size-4" aria-hidden />
      </Button>
    </form>
  );
}

export function LoginPage() {
  const { session, loading, error, refresh, setSession } = useSession();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const after = useRef<string>(undefined);
  const next = params.get('next') || '/';
  const solidError = params.get('solidError') ?? undefined;
  const demo = useAction(async () => {
    const s = await api.demoLogin({});
    // Once the session is set, the redirect below takes over; demo testers start at the walkthrough.
    after.current = next === '/' ? '/alpha' : next;
    setSession(s);
  });

  if (session?.user) return <Navigate to={after.current ?? next} replace />;

  return (
    <div className="mx-auto grid max-w-5xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.15fr_1fr] md:gap-16 md:py-20">
      <section aria-labelledby="login-title">
        <div className="page-eyebrow mb-3 text-xs font-medium tracking-wide text-muted uppercase">Alpha</div>
        <h1 id="login-title" className="page-title max-w-md">
          Concord: design open standards together
        </h1>
        <p className="mt-4 max-w-md text-muted">Write strict OWL ontologies in the open and run their governance without needing meetings.</p>
        <ol className="mt-8 max-w-md divide-y divide-line border-y border-line text-sm">
          {[
            ['Gather requirements', 'Use cases from interviews, meeting transcripts and coding agents.'],
            ['Change the ontology', 'Every change request is checked for consistency, FAIR principles and competency questions.'],
            ['Decide in the open', 'Fixes, minor and major changes follow review, sign-off and voting rules you configure.'],
          ].map(([t, d], i) => (
            <li key={t} className="flex gap-4 py-3">
              <span className="font-mono text-xs text-subtle tabular-nums">{String(i + 1).padStart(2, '0')}</span>
              <span>
                <span className="font-medium">{t}.</span> <span className="text-muted">{d}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <div className="md:pt-10">
        {!session && loading ? (
          <Loading label="Connecting…" />
        ) : !session ? (
          <ErrorCard error={error} onRetry={() => void refresh()} />
        ) : (
          <Card className="p-6">
            <div className="space-y-3">
              {session.providers.google && (
                <a href={api.oauthUrl('google', next)} className="block">
                  <Button size="lg" className="w-full">
                    <GoogleIcon /> Sign in with Google
                  </Button>
                </a>
              )}
              {session.providers.github && (
                <a href={api.oauthUrl('github', next)} className="block">
                  <Button size="lg" className="w-full">
                    <GitHubIcon /> Sign in with GitHub
                  </Button>
                </a>
              )}
              {session.providers.solid && <SolidSignIn next={next} error={solidError} />}
              {(session.providers.google || session.providers.github || session.providers.solid) && session.providers.demo && (
                <div className="flex items-center gap-3 py-1 text-xs text-subtle">
                  <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
                </div>
              )}
              {session.providers.demo && (
                <Button size="lg" variant="primary" className="w-full" loading={demo.pending} onClick={() => void demo.run()}>
                  Try the demo <ArrowRight className="size-4" aria-hidden />
                </Button>
              )}
              {!session.providers.google && !session.providers.github && !session.providers.solid && !session.providers.demo && <p className="text-sm text-muted">No sign-in methods are configured on this server.</p>}
              <InlineError error={demo.error} />
            </div>
            <p className="mt-5 flex items-start gap-2 border-t border-line pt-4 text-xs text-muted">
              <KeyRound className="mt-0.5 size-3.5 shrink-0" />
              We create a WebID and a private Solid pod for you automatically — your interview transcripts are stored there, not in a shared database. Already have a WebID? Sign in with it.
            </p>
          </Card>
        )}

        <button onClick={() => nav('/welcome')} className="mt-5 inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
          <Compass className="size-4" /> Alpha tester? Start here
        </button>
      </div>
    </div>
  );
}
