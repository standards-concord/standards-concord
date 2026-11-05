import { useEffect, useState } from 'react';
import { KNOWN_PROVIDERS } from '@jeswr/pod-auth/directory';
import { Alert, AlertDescription, Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@jeswr/suite-ui';
import { SignInCard, type SignInCardProps, type SignInProvider } from '@jeswr/suite-ui/sign-in';
import { api } from '../api';
import { SolidIcon } from './badges';
import { Button } from './ui';

/** The suite's providers, home provider (solidcommunity.net) first, as every suite app lists them. */
const PROVIDERS: SignInProvider[] = KNOWN_PROVIDERS.map((provider) => ({ ...provider }));

type Pending = NonNullable<SignInCardProps['pending']>;
type Choice = Pending['kind'];

/** Which kind of choice the visitor last made, so a refusal coming back can be shown beside it. */
const LAST_CHOICE = 'concord.solidSignIn.choice';
const CHOICES: Choice[] = ['webid', 'provider', 'custom'];

function rememberChoice(kind: Choice) {
  try {
    sessionStorage.setItem(LAST_CHOICE, kind);
  } catch {
    // Storage blocked: a refusal is then shown above the card, blaming no field.
  }
}

function recallChoice(): Choice | null {
  try {
    // Every attempt overwrites it, so it is always the choice this refusal is about.
    const kind = sessionStorage.getItem(LAST_CHOICE) as Choice | null;
    return kind && CHOICES.includes(kind) ? kind : null;
  } catch {
    return null;
  }
}

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
  // The card keeps an error with the last choice made in it, which after the trip to
  // /auth/solid and back is always its WebID field. So only a refused WebID goes to the
  // card; a refused provider or address is shown above it, blaming no field.
  const [failed] = useState(() => (error ? recallChoice() : null));
  const cardError = error && failed === 'webid' ? error : null;
  const generalError = error && failed !== 'webid' ? error : null;

  // Coming back to this page with the browser's Back button restores it as it was left,
  // spinner and all, so clear the "Signing in…" state when that happens.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(null);
    };
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  const go = (kind: Choice, key: string, address: string) => {
    rememberChoice(kind);
    setPending({ kind, key });
    window.location.assign(api.solidLoginUrl(address, next));
  };

  /** Stop the trip to the provider, if one is under way, and make the card usable again. */
  const cancel = () => {
    window.stop();
    setPending(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        // Closing the dialog (Escape, Close, a click outside) while signing in gives up on it.
        if (!isOpen && pending) cancel();
        setOpen(isOpen);
      }}
    >
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
        {generalError && (
          <Alert variant="destructive" className="concord-solid-error">
            <AlertDescription>{generalError}</AlertDescription>
          </Alert>
        )}
        <SignInCard
          title="Sign in with Solid"
          subtitle="Choose your Solid provider, or enter your WebID."
          providers={PROVIDERS}
          pending={pending}
          error={cardError}
          onWebId={(webId) => go('webid', webId, webId)}
          onProvider={(provider) => go('provider', provider.id, provider.issuer)}
          onCustomProvider={(address) => go('custom', address, address)}
          // Concord doesn't remember accounts, so the card never lists any.
          onAccount={() => undefined}
          onCancel={cancel}
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
