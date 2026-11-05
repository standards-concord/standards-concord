// Vendored from jeswr/solid-sdk packages/pod-auth/src/directory.ts at 483de5d153d98345d02e017ce87cb27f47786aec
// by scripts/vendor-solid-sdk.mjs. Only the provider list; do not edit by hand.

/** Public presentation metadata; custom labels and icons are opt-in host configuration. */
export interface SolidProvider {
  id: string;
  name: string;
  issuer: string;
  description?: string;
  signUpUrl?: string;
  label?: string;
  iconUrl?: string;
}

// Taken from Pod Manager's directory and suite spec 02-§8.1. Re-verify live before release;
// the build sandbox cannot reach these providers. Default icons are local monograms.
export const KNOWN_PROVIDERS: readonly SolidProvider[] = Object.freeze(
  [
    {
      id: "solidcommunity",
      name: "solidcommunity.net",
      issuer: "https://solidcommunity.net/",
      description: "Free, run by the Solid community",
      signUpUrl: "https://solidcommunity.net/.account/login/password/register/",
    },
    {
      id: "inrupt",
      name: "Inrupt PodSpaces",
      issuer: "https://login.inrupt.com/",
      description: "Run by Inrupt",
      signUpUrl: "https://start.inrupt.com/",
    },
    {
      id: "solidweb",
      name: "solidweb.org",
      issuer: "https://solidweb.org/",
      description: "Free community pod host",
    },
    {
      id: "teamid",
      name: "teamid.live",
      issuer: "https://teamid.live/",
      description: "Free, quick sign-up",
    },
  ].map((provider) => Object.freeze(provider)),
);
