import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ChangeLevel, Release } from '@concord/shared';
import { ExternalLink, Package, Rocket } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { formatDate } from '../../lib/format';
import { GitHubIcon, LevelBadge } from '../../components/badges';
import { Badge, Button, Card, Dialog, EmptyState, ErrorCard, Field, InlineError, Loading, Textarea } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { useOntology } from './Layout';

const ORDER: ChangeLevel[] = ['patch', 'minor', 'major'];

export function bumpVersion(v: string, level: ChangeLevel): string {
  const [maj = 0, min = 0, pat = 0] = v.split('.').map((x) => parseInt(x, 10) || 0);
  if (level === 'major') return maj === 0 && min === 0 && pat === 0 ? '1.0.0' : `${maj + 1}.0.0`;
  if (level === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

export function ReleaseStatus({ r }: { r: Release }) {
  const tone = r.status === 'published' ? 'ok' : r.status === 'voting' ? 'accent' : r.status === 'rejected' ? 'danger' : 'outline';
  return <Badge tone={tone}>{r.status === 'published' ? 'Published' : r.status === 'voting' ? 'Voting' : r.status === 'rejected' ? 'Rejected' : 'Draft'}</Badge>;
}

function DraftReleaseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { id, ontology } = useOntology();
  const nav = useNavigate();
  const merged = useAsync(async () => (open ? api.changeRequests(id, 'merged') : []), [id, open]);
  const [notes, setNotes] = useState('');
  const crs = (merged.data ?? []).filter((c) => c.status === 'merged' && !c.releaseId);
  const level = crs.reduce<ChangeLevel>((acc, c) => (ORDER.indexOf(c.classification?.level ?? 'patch') > ORDER.indexOf(acc) ? c.classification!.level : acc), 'patch');
  const next = bumpVersion(ontology.currentVersion, level);
  const draft = useAction(async () => {
    const r = await api.draftRelease(id, notes.trim() || undefined);
    onClose();
    nav(`/o/${id}/releases/${r.id}`);
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Draft a release"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={draft.pending} disabled={!crs.length} onClick={() => void draft.run()}>
            Draft v{next}
          </Button>
        </>
      }
    >
      {merged.error ? (
        <ErrorCard error={merged.error} onRetry={merged.reload} />
      ) : !merged.data ? (
        <Loading />
      ) : !crs.length ? (
        <p className="text-sm text-muted">There are no merged changes waiting for a release. Merge approved change requests first.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-lg bg-surface-2 p-3 text-sm">
            <span className="font-mono text-muted">v{ontology.currentVersion}</span> → <span className="font-mono font-semibold">v{next}</span>
            <LevelBadge level={level} />
            <span className="text-xs text-muted">level = the highest of the included changes</span>
          </div>
          <div>
            <div className="mb-1 text-sm font-medium">Includes {crs.length} merged change{crs.length === 1 ? '' : 's'}</div>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {crs.map((c) => (
                <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="text-muted">#{c.number}</span>
                  <span className="flex-1">{c.title}</span>
                  <LevelBadge level={c.classification?.level} />
                </li>
              ))}
            </ul>
          </div>
          <Field label="Release notes" hint="Leave blank and Concord will write them from the change requests.">
            <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <InlineError error={draft.error} />
        </div>
      )}
    </Dialog>
  );
}

export function ReleasesTab() {
  const { id, ontology } = useOntology();
  const list = useAsync(() => api.releases(id), [id]);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Releases</h2>
          <p className="max-w-2xl text-sm text-muted">
            Versions follow semantic versioning. Current version: <strong className="font-mono">v{ontology.currentVersion}</strong>
            {ontology.github && (
              <>
                {' '}· published to <a className="text-accent hover:underline" href={`https://github.com/${ontology.github.repo}`} target="_blank" rel="noreferrer">{ontology.github.repo}</a>
              </>
            )}
          </p>
        </div>
        <Button variant="primary" icon={Package} onClick={() => setOpen(true)}>
          Draft release
        </Button>
      </div>
      {list.error && !list.data ? (
        <ErrorCard error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : !list.data.length ? (
        <EmptyState icon={Rocket} title="No releases yet" action={<Button icon={Package} onClick={() => setOpen(true)}>Draft the first release</Button>}>
          Once change requests are merged into the working draft, bundle them into a versioned release.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {[...list.data]
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
            .map((r) => (
              <Card key={r.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Link to={`/o/${id}/releases/${r.id}`} className="flex items-center gap-2 hover:text-accent">
                      <span className="font-mono text-lg font-semibold">v{r.version}</span>
                      <LevelBadge level={r.level} />
                      <ReleaseStatus r={r} />
                    </Link>
                    <p className="mt-0.5 text-xs text-muted">
                      {r.publishedAt ? `Published ${formatDate(r.publishedAt)}` : `Drafted ${formatDate(r.createdAt)}`} · {r.changeRequestIds.length} change{r.changeRequestIds.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  {r.githubUrl && (
                    <a href={r.githubUrl} target="_blank" rel="noreferrer">
                      <Button size="sm">
                        <GitHubIcon className="size-3.5" /> GitHub <ExternalLink className="size-3" />
                      </Button>
                    </a>
                  )}
                </div>
                {r.notes && <Markdown text={r.notes} className="mt-3 line-clamp-4 text-muted" />}
              </Card>
            ))}
        </div>
      )}
      <DraftReleaseDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
