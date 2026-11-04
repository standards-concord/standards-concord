import { useEffect } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import type { PublicUseCase, RequirementItem } from '@concord/shared';
import { ArrowLeft, Download, RefreshCw, Tag, VenetianMask } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { compactIri, download, formatDate } from '../../lib/format';
import { Markdown } from '../../components/Markdown';
import { UseCaseStatusBadge } from '../../components/UseCaseSharing';
import { Badge, Button, Card, ErrorCard, InlineError, Loading, ProgressBar } from '../../components/ui';
import { useOntology } from './Layout';

const REQ_TONE: Record<RequirementItem['status'], 'ok' | 'accent' | 'neutral'> = { met: 'ok', partial: 'accent', open: 'neutral' };
const REQ_LABEL: Record<RequirementItem['status'], string> = { met: 'Met', partial: 'Partly met', open: 'Open' };

/**
 * A release's "Use cases and requirements" document: the story first, then the
 * requirements and the use cases, each with an anchor the story links to.
 */
export function RequirementsDocPage() {
  const { version = '' } = useParams();
  const { id, hasRole, view } = useOntology();
  const { hash } = useLocation();
  const doc = useAsync(() => api.requirementsDoc(id, version), [id, version]);
  const rewrite = useAction(async () => {
    if (!doc.data?.releaseId) return;
    doc.setData(await api.generateRequirements(doc.data.releaseId));
  });
  const md = useAction(async () => download(`use-cases-${version}.md`, await api.requirementsMarkdown(id, version), 'text/markdown'));

  // Jump to #uc-… or #req-… once the document has rendered.
  useEffect(() => {
    if (!doc.data || !hash) return;
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: 'start' });
  }, [doc.data, hash]);

  if (doc.error && !doc.data) return <ErrorCard error={doc.error} onRetry={doc.reload} />;
  if (!doc.data) return <Loading />;
  const d = doc.data;
  const byId = new Map(d.useCases.map((u) => [u.id, u]));
  const prefixes = view.data?.prefixes ?? {};
  const hidden = d.unpublished.group + d.unpublished.private;

  return (
    <div className="mx-auto max-w-4xl">
      <Link to={`/o/${id}/use-cases`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Use cases
      </Link>
      <Card className="p-6 sm:p-8" as="article">
        <header className="mb-6 border-b border-line pb-5">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone="outline" icon={Tag}>
              v{d.version}
            </Badge>
            {d.status === 'published' ? <Badge tone="ok">Published</Badge> : <Badge tone="warn">Draft</Badge>}
            {d.simulated && <Badge tone="neutral">Written by the offline assistant</Badge>}
          </div>
          <h2 className="text-2xl font-semibold">{d.title}</h2>
          <p className="mt-1 text-xs text-muted">
            {d.status === 'published' ? 'Published' : 'Drafted'} {formatDate(d.generatedAt)}
            {d.releaseId && (
              <>
                {' · '}
                <Link to={`/o/${id}/releases/${d.releaseId}`} className="text-accent hover:underline">
                  release v{d.version}
                </Link>
              </>
            )}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="min-w-48 flex-1">
              <div className="mb-1 flex justify-between text-xs">
                <span className="font-medium">Use cases covered by v{d.version}</span>
                <span className="tabular-nums text-muted" data-testid="coverage">
                  {d.coverage.closed} of {d.coverage.total}
                </span>
              </div>
              <ProgressBar value={d.coverage.total ? d.coverage.closed / d.coverage.total : 0} tone="ok" />
            </div>
            <Button size="sm" icon={Download} loading={md.pending} onClick={() => void md.run()}>
              Markdown
            </Button>
            {d.status === 'draft' && d.releaseId && hasRole('editor', 'steward', 'owner') && (
              <Button size="sm" icon={RefreshCw} loading={rewrite.pending} onClick={() => void rewrite.run()}>
                Rewrite
              </Button>
            )}
          </div>
          <InlineError error={rewrite.error || md.error} />
        </header>

        <nav aria-label="Contents" className="mb-6 text-sm">
          <p className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Contents</p>
          <ol className="list-decimal space-y-0.5 pl-5">
            {d.sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="hover:text-accent">
                  {s.heading}
                </a>
              </li>
            ))}
            <li>
              <a href="#requirements" className="hover:text-accent">
                Requirements
              </a>
            </li>
            <li>
              <a href="#use-cases" className="hover:text-accent">
                Use cases
              </a>
            </li>
          </ol>
        </nav>

        <Markdown text={d.intro} className="mb-6 text-base" />
        {d.sections.map((s) => (
          <section key={s.id} id={s.id} className="mb-6 scroll-mt-20">
            <h3 className="mb-2 text-lg font-semibold">{s.heading}</h3>
            <Markdown text={s.markdown} className="text-base" />
          </section>
        ))}

        <section id="requirements" className="mb-8 scroll-mt-20">
          <h3 className="mb-3 text-lg font-semibold">Requirements</h3>
          {d.requirements.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="w-12 py-2 pr-2 font-medium">#</th>
                    <th className="py-2 pr-3 font-medium">Requirement</th>
                    <th className="py-2 pr-3 font-medium">From</th>
                    <th className="py-2 font-medium">Status at v{d.version}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.requirements.map((r) => (
                    <tr key={r.id} id={`req-${r.id}`} className="scroll-mt-20 border-b border-line/60 align-top last:border-0 target:bg-accent-soft/40">
                      <td className="py-2 pr-2 font-mono text-xs text-muted">{r.id}</td>
                      <td className="py-2 pr-3">
                        {r.text}
                        {!!r.termIris.length && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {r.termIris.map((iri) => (
                              <Link key={iri} to={`/o/${id}/browse?term=${encodeURIComponent(iri)}`} className="rounded bg-surface-2 px-1.5 font-mono text-[0.7rem] hover:text-accent">
                                {compactIri(iri, prefixes)}
                              </Link>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {r.useCaseIds.map((u, i) => (
                          <span key={u}>
                            {i > 0 && ', '}
                            <a href={`#uc-${u}`} className="font-mono text-xs text-accent hover:underline">
                              {byId.get(u)?.ref ?? 'UC'}
                            </a>
                          </span>
                        ))}
                      </td>
                      <td className="py-2">
                        <Badge tone={REQ_TONE[r.status]}>{REQ_LABEL[r.status]}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted">No requirements yet.</p>
          )}
        </section>

        <section id="use-cases" className="scroll-mt-20">
          <h3 className="mb-3 text-lg font-semibold">Use cases</h3>
          <div className="space-y-3">
            {d.useCases.map((u) => (
              <PublicUseCaseCard key={u.id} u={u} ontologyId={id} />
            ))}
            {!d.useCases.length && <p className="text-sm text-muted">No public use cases yet.</p>}
          </div>
          {hidden > 0 && (
            <p className="mt-4 text-xs text-muted">
              {hidden} more use case{hidden === 1 ? '' : 's'} informed this version but {hidden === 1 ? 'is' : 'are'} not published ({d.unpublished.group} shared with the working group only, {d.unpublished.private} private).
            </p>
          )}
        </section>
      </Card>
    </div>
  );
}

function PublicUseCaseCard({ u, ontologyId }: { u: PublicUseCase; ontologyId: string }) {
  return (
    <div id={`uc-${u.id}`} className="scroll-mt-20 rounded-lg border border-line p-4 target:border-accent target:ring-2 target:ring-accent/30">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted">{u.ref}</span>
        <Link to={`/o/${ontologyId}/use-cases/${u.id}`} className="font-medium hover:text-accent">
          {u.title}
        </Link>
        <UseCaseStatusBadge status={u.status} version={u.coveredIn} />
        {u.anonymised && (
          <Badge tone="outline" icon={VenetianMask}>
            Anonymised
          </Badge>
        )}
      </div>
      <p className="mb-2 text-xs text-muted">
        {u.origin?.href ? (
          <Link to={u.origin.href} className="hover:text-accent">
            {u.origin.label}
          </Link>
        ) : (
          u.origin?.label
        )}
        {u.attribution && `, described by ${u.attribution}`}
        {u.origin?.date && ` · ${formatDate(u.origin.date)}`}
      </p>
      {u.goal && <p className="text-sm">{u.goal}</p>}
      {!!u.scenarios.length && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-muted">
          {u.scenarios.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      {!!u.competencyQuestions.length && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-xs text-accent">Competency questions ({u.competencyQuestions.length})</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {u.competencyQuestions.map((q, i) => (
              <li key={i}>
                {q.question}
                {q.exampleAnswer && <span className="text-muted"> e.g. {q.exampleAnswer}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}


