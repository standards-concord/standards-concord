import { Link } from 'react-router';
import { Bot, Lock, LogIn, SlidersHorizontal, UserRound } from 'lucide-react';
import { api } from '../api';
import { useSession } from '../lib/session';
import { useAdvancedFeatures } from '../lib/advanced';
import { formatDate, titleCase } from '../lib/format';
import { Page } from '../components/Shell';
import { GitHubIcon, GoogleIcon, SolidIcon } from '../components/badges';
import { CollapsibleCard } from '../components/Disclosure';
import { Avatar, Badge, Card, CardHeader, CopyButton, PageHeader, AnchorButton, Toggle } from '../components/ui';

/** The signed-in person's profile: who they are, how they sign in, and where their private data lives. */
export function SettingsPage() {
  const { session } = useSession();
  const [advanced, setAdvanced] = useAdvancedFeatures();
  const u = session?.user;
  if (!u) return null;
  const solidOn = session?.solid?.enabled ?? false;
  const ownWebId = u.providers.some((p) => p.provider === 'solid' && p.subject === u.webId);

  return (
    <Page>
      <PageHeader title="Profile" />
      <div className="space-y-6">
        <Card>
          <div className="flex flex-wrap items-center gap-4 p-5">
            <Avatar name={u.name} src={u.avatarUrl} size={56} />
            <div className="min-w-0">
              <div className="text-lg font-semibold">{u.name}</div>
              {u.email && <div className="text-sm text-muted">{u.email}</div>}
              {u.organisation && <div className="text-sm text-muted">{u.organisation}</div>}
              {u.simulated && <Badge tone="warn" className="mt-1">Simulated persona</Badge>}
              <div className="mt-1 text-xs text-subtle">Joined {formatDate(u.createdAt)}</div>
            </div>
          </div>
          {u.persona && <p className="border-t border-line px-5 py-4 text-sm text-muted">{u.persona}</p>}
        </Card>

        <Card>
          <CardHeader level={2} icon={LogIn} title="Ways to sign in" subtitle="Each of these opens this same Concord account. Linking another one gives you a second way in; it doesn’t share your Concord data with it." />
          <ul className="divide-y divide-line">
            {u.providers.map((p) => (
              <li key={p.provider + p.subject} className="flex items-center gap-3 px-5 py-3 text-sm">
                {p.provider === 'google' ? <GoogleIcon /> : p.provider === 'github' ? <GitHubIcon /> : p.provider === 'solid' ? <SolidIcon /> : <UserRound className="size-4 text-muted" />}
                <span className="font-medium">{p.provider === 'solid' ? 'Solid (your WebID)' : titleCase(p.provider)}</span>
                <span className="truncate text-xs text-muted">{p.subject}</span>
              </li>
            ))}
          </ul>
          {(session.providers.google || session.providers.github) && (
            <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
              {session.providers.google && !u.providers.some((p) => p.provider === 'google') && (
                <AnchorButton href={api.oauthUrl('google', '/settings')} size="sm">
                    <GoogleIcon className="size-3.5" /> Link Google
                  </AnchorButton>
              )}
              {session.providers.github && !u.providers.some((p) => p.provider === 'github') && (
                <AnchorButton href={api.oauthUrl('github', '/settings')} size="sm">
                    <GitHubIcon className="size-3.5" /> Link GitHub
                  </AnchorButton>
              )}
            </div>
          )}
        </Card>

        <CollapsibleCard
          id="webid"
          icon={Lock}
          level={2}
          title="Your WebID and Solid pod"
          subtitle={
            ownWebId
              ? 'You signed in with your own WebID. What Concord saves for you, such as interview transcripts, goes in a private pod Concord keeps for you here, not in Concord’s database.'
              : solidOn
              ? 'Private data, such as interview transcripts, is saved to your own Solid pod. If the pod can’t be reached, it’s kept in Concord’s private storage instead. Concord set this up for you.'
              : 'This server runs without a Solid server, so private data, such as interview transcripts, is kept in Concord’s private storage.'
          }
          keepMounted
        >
          <div className="space-y-4 p-5">
            <p className="text-sm text-muted">Your WebID is the web address that identifies you to your pod and to other Solid apps.</p>
            <div>
              <div className="mb-1 text-xs font-medium text-muted">WebID</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm">{u.webId}</code>
                <CopyButton text={u.webId} />
              </div>
            </div>
            {u.podUrl && (
              <div>
                <div className="mb-1 text-xs font-medium text-muted">Pod</div>
                <div className="flex items-center gap-2">
                  <a href={u.podUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-accent hover:underline">
                    {u.podUrl}
                  </a>
                  <CopyButton text={u.podUrl} />
                </div>
              </div>
            )}
          </div>
        </CollapsibleCard>

        <Card>
          <CardHeader level={2} icon={SlidersHorizontal} title="Advanced features" subtitle="Tools most people won’t need. Saved in this browser." />
          <div className="space-y-2 p-5">
            <Toggle checked={advanced} onChange={setAdvanced} label="Show advanced features" />
            <p className="text-sm text-muted">Adds Query to Explore, for asking questions of an ontology in SPARQL.</p>
          </div>
        </Card>

        <p className="flex items-center gap-2 text-sm text-muted">
          <Bot className="size-4" />
          <span>
            Agents you’ve connected and personal tokens are on <Link to="/connect#agents" className="text-accent hover:underline">Connect an agent</Link>. The look of the app is under <Link to="/appearance" className="text-accent hover:underline">Appearance</Link>.
          </span>
        </p>
      </div>
    </Page>
  );
}
