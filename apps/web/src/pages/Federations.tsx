import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CircleCheck, CircleX, Info, Network, Plus, TriangleAlert } from 'lucide-react';
import type { FederationCheck, FederationComparison, FederationDetail, FederationMember } from '@concord/shared';
import { Disclosure } from '../components/Disclosure';
import { api } from '../api';
import { useAction, useAsync } from '../lib/hooks';
import { localName, plural } from '../lib/format';
import { Page } from '../components/Shell';
import { Badge, Button, Card, Dialog, EmptyState, ErrorCard, Field, InlineError, Input, Loading, PageHeader, Select, Textarea } from '../components/ui';

/**
 * Federations: sets of ontologies, each at a chosen version, meant to be used together. An Advanced
 * feature (linked from the hub only with Advanced features on; these pages open from any link).
 */
export function FederationsPage() {
  const list = useAsync(() => api.federations(), []);
  const [open, setOpen] = useState(false);
  return (
    <Page>
      <PageHeader
        eyebrow={<>Advanced feature</>}
        title="Federations"
        subtitle="Ontologies meant to be used together, each at a chosen version. Concord checks that they still make sense together, and checks every change to a member against them."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
            New federation
          </Button>
        }
      />
      {list.error && !list.data ? (
        <ErrorCard error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : !list.data.length ? (
        <EmptyState icon={Network} title="No federations yet">
          Start one to check that a set of ontologies can be used together.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Federations">
          {list.data.map((f) => (
            <li key={f.id}>
              <Link to={`/f/${f.slug}`} className="group block">
                <Card className="p-4 group-hover:border-line-strong">
                  <h2 className="font-semibold group-hover:text-accent">{f.title}</h2>
                  <p className="mt-1 line-clamp-2 text-sm text-muted">{f.description || 'No description yet.'}</p>
                  <p className="mt-2 text-xs text-muted">{plural(f.members.length, 'ontology', 'ontologies')}</p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {open && <NewFederationDialog onClose={() => setOpen(false)} />}
    </Page>
  );
}

function NewFederationDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const create = useAction(async () => {
    const f = await api.createFederation({ title: title.trim(), description: description.trim() });
    nav(`/f/${f.slug}`);
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="New federation"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.pending} disabled={!title.trim()} onClick={() => void create.run()}>
            Create federation
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. UK government and financial services" />
        </Field>
        <Field label="What it's for (optional)">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {create.error ? <InlineError error={create.error} /> : null}
      </div>
    </Dialog>
  );
}

export function FederationPage() {
  const { slug = '' } = useParams();
  const fed = useAsync(() => api.federation(slug), [slug]);
  if (fed.error && !fed.data) return <Page><ErrorCard error={fed.error} onRetry={fed.reload} /></Page>;
  if (!fed.data) return <Page><Loading /></Page>;
  return <FederationView key={fed.data.updatedAt} fed={fed.data} onChange={fed.reload} />;
}

const versionLabel = (v: string) => (v === 'draft' ? 'Working draft' : v.startsWith('fork:') ? `Fork ${v.slice('fork:'.length)}` : `Release ${v}`);

function FederationView({ fed, onChange }: { fed: FederationDetail; onChange: () => void }) {
  const check = useAsync(() => api.federationCheck(fed.slug), [fed.slug, fed.updatedAt]);
  const save = useAction(async (members: FederationMember[]) => {
    await api.updateFederation(fed.slug, { members });
    onChange();
  });
  const commit = useAction(async (ontologyId: string, committed: boolean) => {
    await api.setFederationCommitment(ontologyId, fed.id, committed);
    onChange();
  });
  const members = fed.members;
  const titleOf = (id: string) => fed.memberInfo.find((m) => m.ontologyId === id)?.title ?? id;
  return (
    <Page>
      <PageHeader eyebrow={<Link to="/f" className="hover:underline">Federations</Link>} title={fed.title} subtitle={fed.description || undefined} actions={<ForkButton fed={fed} />} />
      <Family fed={fed} onChange={onChange} />
      <ForkBack fed={fed} />
      <Proposals fed={fed} onChange={onChange} />
      <section aria-labelledby="members-title" className="space-y-3">
        <h2 id="members-title" className="text-xl font-bold">
          Ontologies
        </h2>
        <p className="text-sm text-muted">
          A member that follows its working draft has every proposed change checked against this federation. If its owners commit it here, a change that breaks the federation fails its checks; otherwise the result is advice.
        </p>
        {members.length === 0 ? (
          <p className="text-sm text-muted">No ontologies yet.{fed.canEdit ? ' Add the first below.' : ''}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-fg text-xs text-muted">
              <tr>
                <th scope="col" className="py-2 pr-3 font-semibold">Ontology</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Version</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Committed</th>
                {fed.canEdit && <th scope="col" className="py-2 font-semibold"><span className="sr-only">Remove</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {fed.memberInfo.map((m) => (
                <tr key={m.ontologyId}>
                  <td className="py-2 pr-3">
                    <Link to={`/o/${m.ontologyId}`} className="font-medium text-accent hover:underline">{m.title}</Link>
                  </td>
                  <td className="py-2 pr-3">
                    {fed.canEdit ? (
                      <Select aria-label={`Version of ${m.title}`} value={m.version} disabled={save.pending} onChange={(e) => void save.run(members.map((x) => (x.ontologyId === m.ontologyId ? { ...x, version: e.target.value } : x)))}>
                        <option value="draft">Working draft</option>
                        {m.versions.map((v) => <option key={v} value={v}>Release {v}</option>)}
                        {m.forks.map((f) => <option key={f.slug} value={`fork:${f.slug}`}>Fork {f.slug}{f.title !== f.slug ? ` (${f.title})` : ''}</option>)}
                      </Select>
                    ) : (
                      versionLabel(m.version)
                    )}
                    {m.version !== 'draft' && !m.version.startsWith('fork:') && m.versions[0] && m.versions[0] !== m.version && (
                      <span className="mt-0.5 block text-xs text-warn">Release {m.versions[0]} is out{fed.canEdit ? ': pick it above to check it here' : ''}.</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {m.canCommit ? (
                      <Button size="sm" variant={m.committed ? 'secondary' : 'ghost'} aria-pressed={m.committed} aria-label={`${m.title} committed to this federation`} loading={commit.pending} onClick={() => void commit.run(m.ontologyId, !m.committed)}>
                        {m.committed ? 'Committed' : 'Commit'}
                      </Button>
                    ) : m.committed ? (
                      <Badge tone="ok">Committed</Badge>
                    ) : (
                      <span className="text-muted">Advisory</span>
                    )}
                  </td>
                  {fed.canEdit && (
                    <td className="py-2 text-right">
                      <Button size="sm" variant="ghost" aria-label={`Remove ${m.title}`} disabled={save.pending} onClick={() => void save.run(members.filter((x) => x.ontologyId !== m.ontologyId))}>
                        Remove
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {fed.canEdit && <AddMember fed={fed} onAdd={(m) => void save.run([...members, m])} pending={save.pending} />}
        {save.error ? <InlineError error={save.error} /> : null}
        {commit.error ? <InlineError error={commit.error} /> : null}
      </section>

      <section aria-labelledby="together-title" className="mt-10 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="together-title" className="text-xl font-bold">
            Used together
          </h2>
          <Button size="sm" variant="ghost" onClick={check.reload} disabled={!check.data && !check.error}>
            Check again
          </Button>
        </div>
        {check.error && !check.data ? <ErrorCard error={check.error} onRetry={check.reload} /> : !check.data ? <Loading label="Checking…" /> : <CheckReport check={check.data} titleOf={titleOf} />}
      </section>

      <Compare fed={fed} />

      {fed.parent && <Upstream fed={fed} />}

      <Releases fed={fed} />
    </Page>
  );
}

function AddMember({ fed, onAdd, pending }: { fed: FederationDetail; onAdd: (m: FederationMember) => void; pending: boolean }) {
  const ontologies = useAsync(() => api.ontologies(), []);
  const [pick, setPick] = useState('');
  const choices = (ontologies.data ?? []).filter((o) => !fed.members.some((m) => m.ontologyId === o.id));
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Add an ontology" className="min-w-60">
        <Select value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Choose…</option>
          {choices.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
        </Select>
      </Field>
      <Button disabled={!pick || pending} onClick={() => { onAdd({ ontologyId: pick, version: 'draft' }); setPick(''); }}>
        Add
      </Button>
    </div>
  );
}

function CheckReport({ check, titleOf }: { check: FederationCheck; titleOf: (id: string) => string }) {
  const j = check.joint;
  if (!check.members.length) return <p className="text-sm text-muted">Add ontologies to check them together.</p>;
  return (
    <div className="space-y-4 text-sm">
      <p>
        {j.checked === 'none' ? (
          <span className="text-warn">They couldn't be checked together{j.error ? `: ${j.error}` : '.'}</span>
        ) : check.passed ? (
          <strong className="text-ok">They can be used together.</strong>
        ) : !j.consistent ? (
          <strong className="text-danger">Together, they contradict each other: no data could ever conform to all of them.</strong>
        ) : (
          <strong className="text-danger">Together, {plural(j.unsatisfiable.length, 'class', 'classes')} can never have members.</strong>
        )}
      </p>
      {j.unsatisfiable.length > 0 && (
        <ul className="space-y-1" aria-label="Classes made impossible">
          {j.unsatisfiable.map((u) => (
            <li key={u.iri}>
              <strong>{localName(u.iri)}</strong>{' '}
              <span className="text-muted">
                ({u.member ? titleOf(u.member) : 'declared nowhere'}
                {u.alone ? ', already impossible on its own' : ', only when used together'})
              </span>
            </li>
          ))}
        </ul>
      )}
      {!check.passed && j.checked !== 'none' && (!j.consistent || j.unsatisfiable.some((u) => !u.alone)) && (
        <div>
          <h3 className="mb-1 text-sm font-semibold">Where it comes from</h3>
          {check.conflicts.length ? (
            <ul className="space-y-1" aria-label="Conflicting pairs">
              {check.conflicts.map((c) => (
                <li key={`${c.a}|${c.b}`} className="flex items-start gap-2">
                  <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                  <span>
                    <strong>{titleOf(c.a)}</strong> and <strong>{titleOf(c.b)}</strong> conflict{c.inconsistent ? ' outright' : c.unsatisfiable.length ? `: ${c.unsatisfiable.map(localName).join(', ')}` : ''}.
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">No two of them conflict on their own: it takes three or more together.</p>
          )}
        </div>
      )}
      <div>
        <h3 className="mb-1 text-sm font-semibold">Each on its own</h3>
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Each ontology on its own">
          {check.members.map((m) => (
            <li key={m.ontologyId} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
              {m.passed ? <CircleCheck className="size-4 text-ok" aria-label="Passes" role="img" /> : <CircleX className="size-4 text-danger" aria-label="Fails" role="img" />}
              <span className="font-medium">{m.title}</span>
              <span className="text-xs text-muted">
                {versionLabel(m.version)}
                {m.imports ? `, with ${plural(m.imports, 'import')}` : ''}
                {!m.passed && m.checked !== 'none' ? (m.consistent ? `: ${m.unsatisfiable.map(localName).join(', ')} impossible` : ': inconsistent') : ''}
                {m.checked === 'none' ? ': not checked' : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {check.foreignAxioms.length > 0 && (
        <div>
          <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-warn">
            <TriangleAlert className="size-4" /> One ontology changes another's terms ({check.foreignAxioms.length})
          </h3>
          <ul className="space-y-1" aria-label="Statements about another ontology's terms">
            {check.foreignAxioms.map((f, i) => (
              <li key={i}>
                {titleOf(f.member)} says <strong>{localName(f.subject)}</strong> {localName(f.predicate)} <strong>{f.object.startsWith('(') ? 'a class expression' : localName(f.object)}</strong>{' '}
                <span className="text-muted">(a term of {f.owner})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {check.unresolved.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-semibold">Not checked</h3>
          <ul className="space-y-1">
            {check.unresolved.map((u) => (
              <li key={`${u.member}|${u.iri}`} className="flex items-start gap-2">
                <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <span>
                  <span className="break-all font-mono text-xs">{u.iri}</span> <span className="text-muted">(imported by {titleOf(u.member)}; not on Concord)</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {check.versionClashes.map((v) => (
        <p key={v.ontologyId} className="text-xs text-warn">
          {v.title} is in the federation at more than one version ({v.versions.join(', ')}).
        </p>
      ))}
    </div>
  );
}

const short = (hash: string) => hash.replace(/^sha256:/, '').slice(0, 12);

/**
 * Releases pin every ontology (members and what they import) to a release and its RDFC-1.0 hash, with
 * the hash of the SHACL shapes derived from their OWL, and are published at /def/fed/<slug>/<version>.
 */
function Releases({ fed }: { fed: FederationDetail }) {
  const releases = useAsync(() => api.federationReleases(fed.slug), [fed.slug]);
  const plan = useAsync(() => api.federationReleasePlan(fed.slug), [fed.slug, fed.updatedAt]);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const publish = useAction(async () => {
    await api.releaseFederation(fed.slug, { version: version.trim() || undefined, notes: notes.trim() || undefined });
    setVersion('');
    setNotes('');
    releases.reload();
    plan.reload();
  });
  return (
    <section aria-labelledby="releases-title" className="mt-10 space-y-3">
      <h2 id="releases-title" className="text-xl font-bold">
        Releases
      </h2>
      <p className="text-sm text-muted">
        A release pins every ontology, and everything they import, to a release and its content hash (RDFC-1.0, SHA-256), with the hash of the SHACL shapes derived from them. It is published as an ontology anyone can import, which loads exactly the pinned content.
      </p>
      {fed.canEdit && plan.data && (
        <Card className="space-y-3 p-4">
          {plan.data.ready ? (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Version" hint={`Suggested: ${plan.data.suggested.version} (${plan.data.suggested.reasons.join('; ')})`}>
                  <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder={plan.data.suggested.version} className="w-32" />
                </Field>
                <Field label="Notes (optional)" className="min-w-60 flex-1">
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>
                <Button variant="primary" loading={publish.pending} onClick={() => void publish.run()}>
                  Publish release
                </Button>
              </div>
              <p className="text-xs text-muted">Pins {plural(plan.data.pins.length, 'ontology version', 'ontology versions')}.</p>
            </>
          ) : (
            <div>
              <p className="text-sm font-medium">Not ready to release:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted" aria-label="What stands in the way of a release">
                {plan.data.blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          )}
          {publish.error ? <InlineError error={publish.error} /> : null}
        </Card>
      )}
      {releases.error && !releases.data ? (
        <ErrorCard error={releases.error} onRetry={releases.reload} />
      ) : !releases.data ? (
        <Loading />
      ) : !releases.data.length ? (
        <p className="text-sm text-muted">No releases yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Federation releases">
          {releases.data.map((r) => (
            <li key={r.id} className="space-y-1 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <a href={`/def/fed/${encodeURIComponent(fed.slug)}/${r.version}`} className="font-semibold text-accent hover:underline">
                  {r.version}
                </a>
                <span className="text-xs text-muted">{r.publishedAt.slice(0, 10)}</span>
                <span className="font-mono text-xs text-muted" title={r.hash}>
                  {short(r.hash)}
                </span>
              </div>
              {r.notes && <p>{r.notes}</p>}
              <p className="text-xs text-muted">
                {r.pins.map((p) => `${p.title} ${p.version}${p.role === 'import' ? ' (imported)' : ''}`).join(', ')} ·{' '}
                <a href={`/def/fed/${encodeURIComponent(fed.slug)}/${r.version}/shapes`} className="text-accent hover:underline">
                  shapes
                </a>
                {r.closureHash && (
                  <>
                    {' · '}
                    <a href={`/def/fed/${encodeURIComponent(fed.slug)}/${r.version}/closure`} className="text-accent hover:underline" title="Every pinned ontology merged, exactly as checked">
                      frozen closure
                    </a>
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Which federation this one extends, and which extend it; owners can change what it extends. */
function Family({ fed, onChange }: { fed: FederationDetail; onChange: () => void }) {
  const all = useAsync(() => (fed.canEdit ? api.federations() : Promise.resolve([])), [fed.canEdit]);
  const save = useAction(async (parentId: string) => {
    await api.updateFederation(fed.slug, { parentId: parentId || null });
    onChange();
  });
  const choices = (all.data ?? []).filter((f) => f.id !== fed.id && !fed.children.some((c) => c.id === f.id));
  return (
    <div className="-mt-3 mb-8 space-y-2 text-sm" data-testid="federation-family">
      {fed.parent && (
        <p>
          Extends <Link to={`/f/${fed.parent.slug}`} className="font-medium text-accent hover:underline">{fed.parent.title}</Link>.
        </p>
      )}
      {fed.children.length > 0 && (
        <p>
          Extended by{' '}
          {fed.children.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ', '}
              <Link to={`/f/${c.slug}`} className="text-accent hover:underline">{c.title}</Link>
            </span>
          ))}
          .
        </p>
      )}
      {fed.forkedFrom && (
        <p>
          A {fed.forkedFrom.kind} fork of <Link to={`/f/${fed.forkedFrom.slug}`} className="font-medium text-accent hover:underline">{fed.forkedFrom.title}</Link>.
        </p>
      )}
      {fed.forks.length > 0 && (
        <p>
          Forks:{' '}
          {fed.forks.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ', '}
              <Link to={`/f/${c.slug}`} className="text-accent hover:underline">{c.title}</Link> <span className="text-muted">({c.kind})</span>
            </span>
          ))}
          .
        </p>
      )}
      {fed.canEdit && (
        <Field label="Extends (optional)" className="max-w-sm">
          <Select value={fed.parentId ?? ''} disabled={save.pending} onChange={(e) => void save.run(e.target.value)}>
            <option value="">Nothing: a federation of its own</option>
            {choices.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
          </Select>
        </Field>
      )}
      {save.error ? <InlineError error={save.error} /> : null}
    </div>
  );
}

const RELATIONS: { key: FederationComparison['terms'][number]['relation']; title: (a: string, b: string) => string; agree?: boolean }[] = [
  { key: 'same', title: () => 'The same', agree: true },
  { key: 'equivalent', title: () => 'Same meaning, said differently', agree: true },
  { key: 'tightened', title: (a) => `Refined: narrower than in ${a}`, agree: true },
  { key: 'loosened', title: (a) => `Loosened: broader than in ${a}` },
  { key: 'conflict', title: () => 'Conflicting: each says something the other doesn’t' },
  { key: 'only-b', title: (_a, b) => `Only in ${b}` },
  { key: 'only-a', title: (a) => `Only in ${a}` },
];

/** This federation compared with another (its parent by default), term by term. */
function Compare({ fed }: { fed: FederationDetail }) {
  const all = useAsync(() => api.federations(), []);
  const [other, setOther] = useState(fed.parent?.slug ?? '');
  const cmp = useAsync(() => (other ? api.compareFederations(fed.slug, other) : Promise.resolve(undefined)), [fed.slug, other, fed.updatedAt]);
  const choices = (all.data ?? []).filter((f) => f.id !== fed.id);
  return (
    <section aria-labelledby="compare-title" className="mt-10 space-y-3">
      <h2 id="compare-title" className="text-xl font-bold">
        Compare
      </h2>
      <p className="text-sm text-muted">See, term by term, how far this federation agrees with another: which terms it keeps, refines, loosens or contradicts.</p>
      <Field label="Compare with" className="max-w-sm">
        <Select value={other} onChange={(e) => setOther(e.target.value)}>
          <option value="">Choose a federation…</option>
          {choices.map((f) => <option key={f.id} value={f.slug}>{f.title}</option>)}
        </Select>
      </Field>
      {!other ? null : cmp.error && !cmp.data ? <ErrorCard error={cmp.error} onRetry={cmp.reload} /> : !cmp.data ? <Loading label="Comparing…" /> : <ComparisonReport cmp={cmp.data} />}
    </section>
  );
}

function ComparisonReport({ cmp }: { cmp: FederationComparison }) {
  const [a, b] = [cmp.a.title, cmp.b.title];
  return (
    <div className="space-y-3 text-sm">
      <p data-testid="agreement">
        {cmp.shared === 0 ? (
          <>They share no terms.</>
        ) : (
          <>
            <strong>{b}</strong> agrees with <strong>{a}</strong> on {cmp.agreeing} of the {plural(cmp.shared, 'term', 'terms')} they share
            {cmp.agreeing === cmp.shared ? ', so data written for one is right for the other on all of them.' : '.'}
          </>
        )}
      </p>
      <div className="divide-y divide-line rounded-lg border border-line">
        {RELATIONS.filter((r) => cmp.counts[r.key] > 0).map((r) => {
          const terms = cmp.terms.filter((t) => t.relation === r.key);
          return (
            <Disclosure key={r.key} className="px-4 py-2" heading={3} title={r.title(a, b)} summary={String(cmp.counts[r.key])} defaultOpen={r.key === 'conflict' || r.key === 'loosened'}>
              <ul className="space-y-1" aria-label={r.title(a, b)}>
                {terms.map((t) => (
                  <li key={t.iri}>
                    <span className="font-medium">{t.label ?? localName(t.iri)}</span> <span className="font-mono text-xs text-muted">{t.iri}</span>
                    {(t.onlyInB.length > 0 || t.onlyInA.length > 0) && (
                      <span className="block text-xs text-muted">
                        {t.onlyInB.length > 0 && <>Only {b} says: {t.onlyInB.join('; ')}. </>}
                        {t.onlyInA.length > 0 && <>Only {a} says: {t.onlyInA.join('; ')}.</>}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Disclosure>
          );
        })}
      </div>
    </div>
  );
}

/** Anyone signed in can fork a federation: a development fork to propose back, or a divergent one. */
function ForkButton({ fed }: { fed: FederationDetail }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'development' | 'divergent'>('development');
  const fork = useAction(async () => {
    const f = await api.forkFederation(fed.slug, { title: title.trim() || undefined, kind });
    setOpen(false);
    nav(`/f/${f.slug}`);
  });
  return (
    <>
      <Button onClick={() => setOpen(true)}>Fork</Button>
      {open && (
        <Dialog
          open
          onClose={() => setOpen(false)}
          title="Fork this federation"
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" loading={fork.pending} onClick={() => void fork.run()}>
                Create fork
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <Field label="Name">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${fed.title} (fork)`} />
            </Field>
            <Field label="Kind of fork">
              <Select value={kind} onChange={(e) => setKind(e.target.value as 'development' | 'divergent')}>
                <option value="development">Development: try changes, then propose them back</option>
                <option value="divergent">Divergent: go your own way</option>
              </Select>
            </Field>
            {fork.error ? <InlineError error={fork.error} /> : null}
          </div>
        </Dialog>
      )}
    </>
  );
}

/** A development fork's owners propose its ontology choices back to the original. */
function ForkBack({ fed }: { fed: FederationDetail }) {
  const [note, setNote] = useState('');
  const [done, setDone] = useState(false);
  const propose = useAction(async () => {
    await api.proposeFederationBack(fed.slug, note.trim() || undefined);
    setDone(true);
  });
  if (!fed.canEdit || fed.forkedFrom?.kind !== 'development') return null;
  return (
    <Card className="mb-8 space-y-2 p-4" as="section">
      <h2 className="font-semibold">Propose back to {fed.forkedFrom.title}</h2>
      {done ? (
        <p className="text-sm" role="status">
          Proposed. The owners of <Link to={`/f/${fed.forkedFrom.slug}`} className="text-accent hover:underline">{fed.forkedFrom.title}</Link> can now accept or decline it.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Note for its owners (optional)" className="min-w-60 flex-1">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button variant="primary" loading={propose.pending} onClick={() => void propose.run()}>
            Propose back
          </Button>
        </div>
      )}
      {propose.error ? <InlineError error={propose.error} /> : null}
    </Card>
  );
}

/** Development forks' proposals: the owners accept (the fork's ontology choices become this federation's) or decline. */
function Proposals({ fed, onChange }: { fed: FederationDetail; onChange: () => void }) {
  const decide = useAction(async (id: string, accept: boolean) => {
    await api.decideFederationProposal(fed.slug, id, accept);
    onChange();
  });
  if (!fed.proposalInfo.length) return null;
  return (
    <section aria-labelledby="proposals-title" className="mb-8 space-y-2">
      <h2 id="proposals-title" className="text-xl font-bold">
        Proposals from forks
      </h2>
      <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Proposals from forks">
        {[...fed.proposalInfo].reverse().map((p) => (
          <li key={p.id} className="space-y-1 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/f/${p.from.slug}`} className="font-medium text-accent hover:underline">{p.from.title}</Link>
              <Badge tone={p.status === 'open' ? 'warn' : p.status === 'accepted' ? 'ok' : 'neutral'}>{p.status === 'open' ? 'Open' : p.status === 'accepted' ? 'Accepted' : 'Declined'}</Badge>
            </div>
            <p>It {p.changes.length ? p.changes.join(', ') : 'matches this federation now'}.</p>
            {p.note && <p className="text-muted">“{p.note}”</p>}
            {fed.canEdit && p.status === 'open' && (
              <div className="flex gap-2">
                <Button size="sm" variant="primary" loading={decide.pending} onClick={() => void decide.run(p.id, true)}>
                  Accept
                </Button>
                <Button size="sm" variant="ghost" disabled={decide.pending} onClick={() => void decide.run(p.id, false)}>
                  Decline
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {decide.error ? <InlineError error={decide.error} /> : null}
    </section>
  );
}

/**
 * Handing settled terms upstream: the federation's own terms (ones the federation it extends doesn't
 * have) are proposed, as a change request, to an ontology of that federation.
 */
function Upstream({ fed }: { fed: FederationDetail }) {
  const nav = useNavigate();
  const parentSlug = fed.parent!.slug;
  const parent = useAsync(() => api.federation(parentSlug), [parentSlug]);
  const cmp = useAsync(() => (fed.canEdit ? api.compareFederations(fed.slug, parentSlug) : Promise.resolve(undefined)), [fed.slug, parentSlug, fed.updatedAt, fed.canEdit]);
  const [target, setTarget] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const propose = useAction(async () => {
    const out = await api.proposeUpstream(fed.slug, { ontologyId: target, terms: picked });
    nav(`/o/${out.changeRequest.ontologyId}/changes/${out.changeRequest.id}`);
  });
  const candidates = (cmp.data?.terms ?? []).filter((t) => t.relation === 'only-b' && (t.kind === 'class' || t.kind === 'objectProperty' || t.kind === 'datatypeProperty'));
  return (
    <section aria-labelledby="upstream-title" className="mt-10 space-y-3">
      <h2 id="upstream-title" className="text-xl font-bold">
        Hand terms upstream
      </h2>
      <p className="text-sm text-muted">
        When terms of this federation have settled, propose them to an ontology of {fed.parent!.title}. Each becomes a change request there: the term is re-created in that ontology, linked back to yours, and reviewed under its rules.
      </p>
      {fed.upstreamInfo.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label="Terms handed upstream">
          {fed.upstreamInfo.map((u) => (
            <li key={u.changeRequestId}>
              <Link to={`/o/${u.ontologyId}/changes/${u.changeRequestId}`} className="text-accent hover:underline">
                {u.ontologyTitle} #{u.number ?? '?'}
              </Link>{' '}
              <span className="text-muted">
                {Object.keys(u.mapping).map(localName).join(', ')}
                {u.status ? ` · ${u.status}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {fed.canEdit && (
        <Card className="space-y-3 p-4">
          {!cmp.data || !parent.data ? (
            cmp.error || parent.error ? <ErrorCard error={cmp.error ?? parent.error} /> : <Loading label="Finding this federation’s own terms…" />
          ) : !candidates.length ? (
            <p className="text-sm text-muted">Every term here is already in {fed.parent!.title}.</p>
          ) : (
            <>
              <fieldset>
                <legend className="mb-1 text-sm font-medium">Terms to hand upstream</legend>
                <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
                  {candidates.map((t) => (
                    <li key={t.iri}>
                      <label className="flex items-baseline gap-2">
                        <input type="checkbox" checked={picked.includes(t.iri)} onChange={(e) => setPicked(e.target.checked ? [...picked, t.iri] : picked.filter((x) => x !== t.iri))} />
                        <span>
                          {t.label ?? localName(t.iri)} <span className="font-mono text-xs text-muted">{t.iri}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Propose to" className="min-w-60">
                  <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="">Choose an ontology…</option>
                    {parent.data.memberInfo.map((m) => <option key={m.ontologyId} value={m.ontologyId}>{m.title}</option>)}
                  </Select>
                </Field>
                <Button variant="primary" disabled={!target || !picked.length} loading={propose.pending} onClick={() => void propose.run()}>
                  Propose upstream
                </Button>
              </div>
            </>
          )}
          {propose.error ? <InlineError error={propose.error} /> : null}
        </Card>
      )}
    </section>
  );
}
