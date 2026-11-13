import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { GovernanceTemplateId } from '@concord/shared';
import { BookOpen, Compass, Network, Plus } from 'lucide-react';
import { api } from '../api';
import { useAction, useAsync } from '../lib/hooks';
import { useOntologies } from '../lib/ontologies';
import { useSession } from '../lib/session';
import { useAdvancedFeatures } from '../lib/advanced';
import { plural, relativeTime, titleCase } from '../lib/format';
import { Page } from '../components/Shell';
import { Disclosure } from '../components/Disclosure';
import { HealthChip } from '../components/Phase';
import { ActivityFeed } from '../components/ActivityFeed';
import { OntologyDetailsFields } from '../components/OntologyDetails';
import { Badge, Button, Card, Dialog, EmptyState, ErrorCard, Field, InlineError, Input, Loading, PageHeader, Select, LinkButton } from '../components/ui';

function NewOntologyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const ontologies = useOntologies();
  const templates = useAsync(() => api.governanceTemplates(), []);
  const user = useSession().session?.user;
  const [form, setForm] = useState({ title: '', prefix: '', description: '', domain: '', governanceTemplate: '' as GovernanceTemplateId | '', creditCreator: false });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const create = useAction(async () => {
    const o = await api.createOntology({
      title: form.title.trim(),
      prefix: form.prefix.trim(),
      description: form.description.trim(),
      domain: form.domain.trim() || undefined,
      governanceTemplate: form.governanceTemplate || undefined,
      creditCreator: form.creditCreator,
    });
    onClose();
    nav(`/o/${o.id}`);
    // In the background: the list counts every ontology, and the new one's first validation can be slow.
    void ontologies.reload();
  });
  const hintId = useId();
  // A description is needed from the start: without one in the ontology file, every change fails its checks.
  const needed = [!form.title.trim() && 'a title', !form.prefix.trim() && 'a prefix', !form.description.trim() && 'a description'].filter((x): x is string => !!x);
  const missing = needed.length ? `Add ${needed.length > 1 ? `${needed.slice(0, -1).join(', ')} and ${needed[needed.length - 1]}` : needed[0]} to continue.` : undefined;
  const chosen = templates.data?.find((t) => t.templateId === form.governanceTemplate);
  const autoPrefix = (title: string) =>
    title
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .toLowerCase()
      .slice(0, 6);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New ontology"
      footer={
        <>
          {missing && <p id={hintId} className="w-full text-sm text-muted">{missing}</p>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.pending} disabled={!!missing} aria-describedby={missing ? hintId : undefined} onClick={() => void create.run()}>
            Create ontology
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <OntologyDetailsFields creating value={form} onChange={(field, value) => setForm((f) => ({ ...f, [field]: value, ...(field === 'title' && { prefix: f.prefix && f.prefix !== autoPrefix(f.title) ? f.prefix : autoPrefix(value) }) }))} afterTitle={<Field label={<>Prefix <span className="text-muted">(required)</span></>} hint="Short namespace prefix used in CURIEs, e.g. vol:Shift">
          <Input required aria-required="true" value={form.prefix} onChange={set('prefix')} placeholder="vol" pattern="[a-z][a-z0-9-]*" />
        </Field>} />
        <Field label="Governance policy" hint="You can change this later from the Governance tab.">
          <Select value={form.governanceTemplate} onChange={set('governanceTemplate')} disabled={!templates.data}>
            <option value="">Default</option>
            {templates.data?.map((t) => (
              <option key={t.templateId} value={t.templateId}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-[var(--accent)]"
            checked={form.creditCreator}
            onChange={(e) => setForm((f) => ({ ...f, creditCreator: e.target.checked }))}
            data-testid="credit-creator"
          />
          <span>
            Credit me as the creator
            <span className="block text-xs text-muted">
              {form.creditCreator
                ? `“${user?.name ?? 'Your name'}” is shown publicly on the ontology’s page and in its metadata, before any release.`
                : 'No creator is listed. You can add creators later in the ontology’s metadata.'}
            </span>
          </span>
        </label>
        {templates.error ? <InlineError error={templates.error} /> : null}
        {chosen && <p className="rounded-lg bg-surface-2 p-3 text-xs text-muted">{chosen.description}</p>}
        <InlineError error={create.error} />
      </div>
    </Dialog>
  );
}

/** "3 classes", or "— classes" when the count is withheld. */
const count = (n: number | undefined, one: string, many = `${one}s`) => (n === undefined ? `— ${many}` : plural(n, one, many));

export function HubPage() {
  const ontologies = useOntologies();
  const { now, isDemo } = useSession();
  const [open, setOpen] = useState(false);
  const [advanced] = useAdvancedFeatures();
  return (
    <Page wide>
      <PageHeader
        eyebrow="Open data standards"
        title="Ontologies"
        subtitle="Shared vocabularies designed in the open: use cases first, every change validated, classified and governed."
        actions={
          <>
            {/* Federations are an Advanced feature: linked only with Advanced features on (the pages open from any link). */}
            {advanced && (
              <LinkButton to="/f" icon={Network}>
                Federations
              </LinkButton>
            )}
            <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
              New ontology
            </Button>
          </>
        }
      />
      <p className="mb-6 text-sm text-muted">
        <a href="/def" className="hover:text-fg hover:underline">Public list of standards</a>
      </p>
      {isDemo && (
        <Card className="mb-6 flex flex-wrap items-center justify-between gap-3 border-accent/30 bg-accent-soft/60 px-5 py-4">
          <div className="text-sm">
            <strong>Alpha tester?</strong> The guided walkthrough helps you pick a role and try the main flows in about 5 minutes.
          </div>
          <LinkButton to="/alpha" size="sm" variant="primary" icon={Compass}>
              Open walkthrough
            </LinkButton>
        </Card>
      )}
      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        <div>
          {ontologies.error && !ontologies.data ? (
            <ErrorCard error={ontologies.error} onRetry={ontologies.reload} />
          ) : !ontologies.data ? (
            <Loading />
          ) : !ontologies.data.length ? (
            <EmptyState
              icon={BookOpen}
              title="No ontologies yet"
              action={
                <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
                  Create the first one
                </Button>
              }
            >
              Start an ontology, then describe use cases to the interviewer or upload a meeting transcript — Concord drafts the terms for you.
            </EmptyState>
          ) : (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                {ontologies.data.filter((o) => !o.sample).map((o) => (
                  <Link key={o.id} to={`/o/${o.id}`} className="group">
                    <Card className="flex h-full flex-col p-5 transition-shadow group-hover:border-line-strong group-hover:shadow-md">
                      <div className="flex items-start justify-between gap-2">
                        <h2 className="font-semibold group-hover:text-accent">{o.title}</h2>
                        <div className="flex gap-1">
                          {o.demo && <Badge tone="warn">Demo</Badge>}
                          <Badge tone="outline">{titleCase(o.stage)}</Badge>
                        </div>
                      </div>
                      <p className="mt-2 line-clamp-3 flex-1 text-sm text-muted">{o.description || 'No description yet.'}</p>
                      <p className="mt-4 border-t border-line pt-3 text-sm text-muted">
                        {/* Counts are withheld while the working draft is reviewed before publishing: show a dash, never "undefined". */}
                        {count(o.stats.classes, 'class', 'classes')}, {count(o.stats.properties, 'property', 'properties')}, {count(o.stats.useCases, 'use case')} and{' '}
                        {count(o.stats.members, 'member')}.
                      </p>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                          <HealthChip o={o} />
                          <span>Version {o.currentVersion}</span>
                          {(o.stats.openChangeRequests ?? 0) > 0 && <span>{plural(o.stats.openChangeRequests!, 'open change')}</span>}
                        </span>
                        <span className="text-xs text-subtle">Updated {relativeTime(o.updatedAt, now())}</span>
                      </div>
                    </Card>
                  </Link>
                ))}
              </div>
              {ontologies.data.some((o) => o.sample) && (
                <section aria-label="Sample standards">
                  <Disclosure title="Sample standards" heading={2}>
                    <p className="mb-3 text-sm text-muted">Try Concord with standards used by SolidOS. Each copy links to its original publisher and licence.</p>
                    <ul className="divide-y divide-line">
                      {ontologies.data.filter((o) => o.sample).map((o) => (
                        <li key={o.id} className="py-3">
                          <Link to={`/o/${o.id}`} className="font-semibold text-accent underline underline-offset-2">{o.title}</Link>
                          <p className="mt-1 text-sm text-muted">{o.description}</p>
                        </li>
                      ))}
                    </ul>
                  </Disclosure>
                </section>
              )}
            </div>
          )}
        </div>
        <aside>
          <h2 className="mb-2 text-sm font-semibold">Recent activity</h2>
          <Card className="p-2">
            <ActivityFeed limit={10} compact />
          </Card>
        </aside>
      </div>
      <NewOntologyDialog open={open} onClose={() => setOpen(false)} />
    </Page>
  );
}
