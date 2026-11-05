import type { ReactNode } from "react";

export interface SignInProvider {
  id: string;
  name: string;
  issuer: string;
  /** @deprecated Kept for compatibility; provider pills show only the name or label. */
  description?: string;
  signUpUrl?: string;
  label?: string;
  iconUrl?: string;
  /** Brand colour override. Only six-digit #rrggbb colours are accepted. */
  color?: string;
}

export interface SignInRecentAccount {
  webId: string;
  name?: string;
  photoUrl?: string;
}

export interface SignInCardProps {
  title?: string;
  accountsTitle?: string;
  subtitle?: string;
  /** Initial view only. Without remembered accounts, sign-in is always shown. */
  defaultView?: "accounts" | "sign-in";
  recentAccounts?: SignInRecentAccount[];
  /** Ordered by the host, with the home provider first. */
  providers: SignInProvider[];
  recentProviders?: string[];
  allowCustomProvider?: boolean;
  /** Initial expansion only; later changes do not override the user's choice. */
  defaultCustomProviderOpen?: boolean;
  /** Provider key: id or issuer. Account key: WebID. Form key: submitted input. */
  pending?: {
    kind: "webid" | "provider" | "account" | "custom";
    key: string;
  } | null;
  error?: string | null;
  onWebId(input: string): void;
  onProvider(provider: SignInProvider): void;
  onCustomProvider(input: string): void;
  onAccount(account: SignInRecentAccount): void;
  onCancel?(): void;
  footer?: ReactNode;
  webIdHelpHref?: string;
}
