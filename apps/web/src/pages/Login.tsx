import { useRef } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Compass, KeyRound } from 'lucide-react';
import { api } from '../api';
import { useSession } from '../lib/session';
import { useAction } from '../lib/hooks';
import { GitHubIcon, GoogleIcon } from '../components/badges';
import { SolidSignIn } from '../components/SolidSignIn';
import { AnchorButton, Button, Card, ErrorCard, InlineError, Loading } from '../components/ui';

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
        <h1 id="login-title" className="page-title max-w-md">
          Design open standards together
        </h1>
        <p className="mt-4 max-w-md text-lg">
          Concord is where working groups write strict OWL ontologies in the open and decide on changes without needing a meeting.
        </p>
        <p className="mt-4 max-w-md text-muted">
          Requirements come in from interviews, meeting transcripts and coding agents. Every proposed change is checked for consistency, FAIR principles and the
          questions the standard must answer, then reviewed, signed off or voted on under rules each group sets for itself.
        </p>
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
                <AnchorButton href={api.oauthUrl('google', next)} size="lg" className="flex w-full">
                  <GoogleIcon /> Sign in with Google
                </AnchorButton>
              )}
              {session.providers.github && (
                <AnchorButton href={api.oauthUrl('github', next)} size="lg" className="flex w-full">
                  <GitHubIcon /> Sign in with GitHub
                </AnchorButton>
              )}
              {session.providers.solid && <SolidSignIn next={next} error={solidError} />}
              {(session.providers.google || session.providers.github || session.providers.solid) && session.providers.demo && (
                <div className="flex items-center gap-3 py-1 text-xs text-subtle">
                  <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
                </div>
              )}
              {session.providers.demo && (
                <Button size="lg" variant="primary" className="w-full" loading={demo.pending} onClick={() => void demo.run()}>
                  Try the demo
                </Button>
              )}
              {!session.providers.google && !session.providers.github && !session.providers.solid && !session.providers.demo && <p className="text-sm text-muted">No sign-in methods are configured on this server.</p>}
              <InlineError error={demo.error} />
            </div>
            <p className="mt-5 flex items-start gap-2 border-t border-line pt-4 text-xs text-muted">
              <KeyRound className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Already have a Solid pod? Sign in with Solid. Signing in shares
                your name, email address and profile picture with Concord; see our{' '}
                <Link to="/privacy" className="text-accent hover:underline">
                  privacy policy
                </Link>
                .
              </span>
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
