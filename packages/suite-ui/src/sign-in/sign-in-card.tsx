"use client";

import { ArrowLeft, Globe, LoaderCircle, UserPlus } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar.js";
import { Button } from "../components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Separator } from "../components/ui/separator.js";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../components/ui/sheet.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip.js";
import { providerBrandFor } from "./brands.js";
import { foregroundFor, hostOf, monogramFor, safeHref, signUpTarget } from "./model.js";
import type { SignInCardProps } from "./types.js";

type View = "accounts" | "sign-in";
type Action = NonNullable<SignInCardProps["pending"]>["kind"];

function Spinner() {
  return (
    <LoaderCircle className="su-sign-in-spinner" size={20} strokeWidth={1.75} aria-hidden="true" />
  );
}

function Progress({ active, children }: { active: boolean; children: ReactNode }) {
  return active ? (
    <span className="su-sign-in-progress">
      <Spinner />
      <span>Signing in…</span>
    </span>
  ) : (
    children
  );
}

export function SignInCard({
  title,
  accountsTitle = "Choose an account",
  subtitle,
  defaultView,
  recentAccounts = [],
  providers,
  recentProviders = [],
  allowCustomProvider = true,
  defaultCustomProviderOpen = false,
  pending = null,
  error = null,
  onWebId,
  onProvider,
  onCustomProvider,
  onAccount,
  onCancel,
  footer,
  webIdHelpHref,
}: SignInCardProps) {
  const id = useId();
  const [selectedView, setView] = useState<View>(
    defaultView ?? (recentAccounts.length ? "accounts" : "sign-in"),
  );
  const [webId, setWebId] = useState("");
  const [customProvider, setCustomProvider] = useState("");
  const [customOpen, setCustomOpen] = useState(defaultCustomProviderOpen);
  const [helpOpen, setHelpOpen] = useState(false);
  const [lastAction, setLastAction] = useState<Action>(
    recentAccounts.length && selectedView === "accounts" ? "account" : "webid",
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const anotherRef = useRef<HTMLButtonElement>(null);
  const customRef = useRef<HTMLInputElement>(null);
  const focusCustom = useRef(defaultCustomProviderOpen);
  const focusTarget = useRef<"heading" | "another" | null>(null);
  const busy = pending !== null;
  const view = !recentAccounts.length
    ? "sign-in"
    : pending
      ? pending.kind === "account"
        ? "accounts"
        : "sign-in"
      : selectedView;
  const expanded = customOpen || pending?.kind === "custom";
  const errorAction = pending?.kind ?? lastAction;
  const webIdError = !!error && errorAction === "webid";
  const customError = !!error && errorAction === "custom";
  const signUp = signUpTarget(providers);
  const helpHref = safeHref(webIdHelpHref, true);
  const errorAlert = error ? (
    <Alert id={`${id}-error`} variant="destructive" className="su-sign-in-error">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;

  // Remember externally initiated actions as well as local clicks after pending clears.
  useEffect(() => {
    if (pending) {
      setLastAction(pending.kind);
      setView(pending.kind === "account" ? "accounts" : "sign-in");
      if (pending.kind === "custom") setCustomOpen(true);
    }
  }, [pending]);

  // Focus the address field only when it is opened (initially or by its toggle), never when a
  // step change reveals an already open field: that would raise the mobile keyboard.
  useEffect(() => {
    if (customOpen && focusCustom.current) customRef.current?.focus();
    focusCustom.current = false;
  }, [customOpen]);

  useEffect(() => {
    if (focusTarget.current === "heading" && view === "sign-in") headingRef.current?.focus();
    if (focusTarget.current === "another" && view === "accounts") anotherRef.current?.focus();
    focusTarget.current = null;
  }, [view]);

  return (
    <section className="su-sign-in-card" aria-labelledby={`${id}-title`}>
      {view === "sign-in" && recentAccounts.length > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="su-sign-in-back"
                variant="outline"
                size="icon"
                aria-label="Back to accounts"
                disabled={busy}
                onClick={() => {
                  if (busy) return;
                  focusTarget.current = "another";
                  setView("accounts");
                }}
              >
                <ArrowLeft size={20} aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Back to accounts</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <header className="su-sign-in-stack su-sign-in-header">
        <h2 className="su-sign-in-title" id={`${id}-title`} tabIndex={-1} ref={headingRef}>
          {view === "accounts" ? accountsTitle : (title ?? "Sign in")}
        </h2>
        {subtitle && <p className="su-sign-in-muted">{subtitle}</p>}
      </header>

      {view === "accounts" ? (
        <>
          {errorAction === "account" && errorAlert}
          <ul className="su-sign-in-accounts" aria-label="Recent accounts">
            {recentAccounts.map((account) => {
              const name = account.name?.trim() || hostOf(account.webId) || "Your account";
              const initials = name.split(/\s+/).slice(0, 2).map(monogramFor).join("");
              const active = pending?.kind === "account" && pending.key === account.webId;
              const photoUrl = safeHref(account.photoUrl);
              return (
                <li key={account.webId}>
                  <Button
                    className="su-sign-in-account"
                    variant="ghost"
                    disabled={busy}
                    aria-busy={active || undefined}
                    onClick={() => {
                      if (busy) return;
                      setLastAction("account");
                      onAccount(account);
                    }}
                  >
                    <Avatar className="su-sign-in-avatar" aria-hidden="true">
                      {photoUrl && <AvatarImage src={photoUrl} alt="" />}
                      <AvatarFallback>{initials}</AvatarFallback>
                    </Avatar>
                    <span className="su-sign-in-account-copy">
                      <span className="su-sign-in-account-name">{name}</span>
                      <span className="su-sign-in-muted">
                        {active ? "Signing in…" : hostOf(account.webId)}
                      </span>
                    </span>
                    {active && <Spinner />}
                  </Button>
                </li>
              );
            })}
            <li>
              <Button
                ref={anotherRef}
                className="su-sign-in-account"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (busy) return;
                  focusTarget.current = "heading";
                  setView("sign-in");
                }}
              >
                <span className="su-sign-in-avatar su-sign-in-user" aria-hidden="true">
                  <UserPlus size={20} />
                </span>
                <span className="su-sign-in-account-name">Use another account</span>
              </Button>
            </li>
          </ul>
        </>
      ) : (
        <>
          <form
            className="su-sign-in-stack"
            aria-label="Sign in with your WebID"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const value = webId.trim();
              if (busy || !value) return;
              setLastAction("webid");
              onWebId(value);
            }}
          >
            <Label htmlFor={`${id}-webid`}>WebID</Label>
            <Input
              id={`${id}-webid`}
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://you.example/profile/card#me"
              value={webId}
              onChange={(event) => setWebId(event.target.value)}
              disabled={busy}
              aria-invalid={webIdError || undefined}
              aria-describedby={webIdError ? `${id}-error` : undefined}
            />
            {webIdError && errorAlert}
            <Button
              className="su-sign-in-submit"
              type="submit"
              disabled={busy || !webId.trim()}
              aria-busy={pending?.kind === "webid" || undefined}
            >
              <Progress active={pending?.kind === "webid"}>Continue</Progress>
            </Button>
          </form>

          <div className="su-sign-in-divider">
            <Separator />
            <span className="su-sign-in-muted">or</span>
            <Separator />
          </div>

          {errorAction === "provider" && errorAlert}
          <ul className="su-sign-in-stack su-sign-in-providers" aria-label="Providers">
            {providers.map((provider) => {
              const active =
                pending?.kind === "provider" &&
                (pending.key === provider.id || pending.key === provider.issuer);
              const iconUrl = safeHref(provider.iconUrl);
              const { color, Logo } = providerBrandFor(provider);
              return (
                <li key={provider.id}>
                  <Button
                    className="su-sign-in-provider"
                    style={{ backgroundColor: color, color: foregroundFor(color) }}
                    disabled={busy}
                    aria-busy={active || undefined}
                    onClick={() => {
                      if (busy) return;
                      setLastAction("provider");
                      onProvider(provider);
                    }}
                  >
                    <span
                      className="su-sign-in-logo"
                      style={
                        !active && !iconUrl && !Logo
                          ? { color: foregroundFor(color) === "#ffffff" ? color : "#111111" }
                          : undefined
                      }
                      aria-hidden="true"
                    >
                      {active ? (
                        <Spinner />
                      ) : iconUrl ? (
                        // biome-ignore lint/performance/noImgElement: Optional host-supplied logos need no Next.js image loader.
                        <img src={iconUrl} alt="" />
                      ) : Logo ? (
                        <Logo />
                      ) : (
                        monogramFor(provider.name)
                      )}
                    </span>
                    <span>
                      {active
                        ? `Signing in with ${provider.label ?? provider.name}…`
                        : (provider.label ?? provider.name)}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>

          {allowCustomProvider && (
            <Collapsible
              className="su-sign-in-stack"
              open={expanded}
              onOpenChange={(open) => {
                focusCustom.current = open;
                setCustomOpen(open);
              }}
              disabled={busy}
            >
              <CollapsibleTrigger asChild>
                <Button className="su-sign-in-other" variant="outline" disabled={busy}>
                  <Globe size={20} aria-hidden="true" />
                  Other provider
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <form
                  className="su-sign-in-stack"
                  aria-label="Sign in with another provider"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    const value = customProvider.trim();
                    if (busy || !value) return;
                    setLastAction("custom");
                    onCustomProvider(value);
                  }}
                >
                  <Label htmlFor={`${id}-provider`}>Provider address</Label>
                  <Input
                    ref={customRef}
                    id={`${id}-provider`}
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    placeholder="https://your-provider.example/"
                    list={`${id}-recent-providers`}
                    value={customProvider}
                    onChange={(event) => setCustomProvider(event.target.value)}
                    disabled={busy}
                    aria-invalid={customError || undefined}
                    aria-describedby={customError ? `${id}-error` : undefined}
                  />
                  {customError && errorAlert}
                  <datalist id={`${id}-recent-providers`}>
                    {Array.from(new Set(recentProviders)).map((issuer) => (
                      <option key={issuer} value={issuer} />
                    ))}
                  </datalist>
                  <Button
                    className="su-sign-in-submit"
                    type="submit"
                    disabled={busy || !customProvider.trim()}
                    aria-busy={pending?.kind === "custom" || undefined}
                  >
                    <Progress active={pending?.kind === "custom"}>Continue</Progress>
                  </Button>
                </form>
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}

      {busy && onCancel && (
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      )}

      <footer className="su-sign-in-stack su-sign-in-footer">
        {signUp && (
          <p>
            New to Solid?{" "}
            <a
              href={busy ? undefined : signUp}
              aria-disabled={busy || undefined}
              tabIndex={busy ? -1 : undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              Get a pod
            </a>
          </p>
        )}
        {helpHref ? (
          <a
            href={busy ? undefined : helpHref}
            aria-disabled={busy || undefined}
            tabIndex={busy ? -1 : undefined}
            rel="noopener noreferrer"
          >
            What is a WebID?
          </a>
        ) : (
          <Sheet open={helpOpen && !busy} onOpenChange={setHelpOpen}>
            <SheetTrigger asChild>
              <Button variant="link" disabled={busy}>
                What is a WebID?
              </Button>
            </SheetTrigger>
            <SheetContent className="su-sign-in-help" showCloseButton={false}>
              <SheetHeader>
                <SheetTitle>What is a WebID?</SheetTitle>
                <SheetDescription>
                  A WebID is a web address that identifies you. Your provider gave you one when you
                  made your account. You can sign in by choosing your provider instead.
                </SheetDescription>
              </SheetHeader>
              <SheetClose asChild>
                <Button variant="outline">Close</Button>
              </SheetClose>
            </SheetContent>
          </Sheet>
        )}
        {footer && <div inert={busy || undefined}>{footer}</div>}
      </footer>
    </section>
  );
}
