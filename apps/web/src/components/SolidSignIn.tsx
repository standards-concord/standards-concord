import { useEffect, useState } from 'react';
import { KNOWN_PROVIDERS } from '@jeswr/pod-auth/directory';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@jeswr/suite-ui';
import { SignInCard, type SignInCardProps, type SignInProvider } from '@jeswr/suite-ui/sign-in';
import { api } from '../api';
import { SolidIcon } from './badges';
import { Button } from './ui';

/** The suite's providers, home provider (solidcommunity.net) first, as every suite app lists them. */
const PROVIDERS: SignInProvider[] = KNOWN_PROVIDERS.map((provider) => ({ ...provider }));

type Pending = NonNullable<SignInCardProps['pending']>;

/**
 * "Sign in with Solid": opens the Solid Suite's shared sign-in card (the same one
 * every suite app uses) in a dialog. Choosing a provider, entering a WebID or typing
 * another provider's address all go to /auth/solid, which finds the provider and
 * sends the browser there (Solid-OIDC with DPoP). A refused address comes back as
 * ?solidError=…, which reopens the dialog with the reason.
 */
export function SolidSignIn({ next, error }: { next: string; error?: string }) {
  const [open, setOpen] = useState(!!error);
  const [pending, setPending] = useState<Pending | null>(null);

  // Coming back to this page with the browser's Back button restores it as it was left,
  // spinner and all, so clear the "Signing in…" state when that happens.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(null);
    };
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  const go = (kind: Pending['kind'], key: string, address: string) => {
    setPending({ kind, key });
    window.location.assign(api.solidLoginUrl(address, next));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="lg" className="w-full">
          <SolidIcon /> Sign in with Solid
        </Button>
      </DialogTrigger>
      <DialogContent className="concord-solid-dialog">
        {/* Names the dialog; the card shows the same words as its heading. */}
        <DialogTitle asChild>
          <span hidden>Sign in with Solid</span>
        </DialogTitle>
        <SignInCard
          title="Sign in with Solid"
          subtitle="Choose your Solid provider, or enter your WebID."
          providers={PROVIDERS}
          pending={pending}
          error={error ?? null}
          onWebId={(webId) => go('webid', webId, webId)}
          onProvider={(provider) => go('provider', provider.id, provider.issuer)}
          onCustomProvider={(address) => go('custom', address, address)}
          // Concord doesn't remember accounts, so the card never lists any.
          onAccount={() => undefined}
          onCancel={() => {
            window.stop();
            setPending(null);
          }}
          footer={
            <DialogDescription>
              You sign in at your provider, and Concord checks that your WebID names that provider.
            </DialogDescription>
            }
          />
        </DialogContent>
      </Dialog>
  );
}
