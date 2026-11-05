import { compactIRI, localName } from '@concord/core';
import type { ClassView, IndividualView, OntologyView, PropertyView, Restriction, TermView } from '@concord/core/types';
import type { ChangeLevel } from '@concord/shared';
import { escapeHtml as esc, renderMarkdown, safeHref } from './markdown.js';
import type { PublicUseCaseView, PublishedRequirements, RequirementView } from './requirements.js';
import { PAGE_CSS, PAGE_SCRIPT } from './assets.js';
import { fragment, pageIds, termAnchors } from './anchors.js';
import { memberReportUrl, reportChoices } from './reportForm.js';

/**
 * The public page for one version of an ontology: what people see when they
 * open the ontology IRI or a version IRI in a browser. It follows the shape of
 * well-presented vocabularies (W3C specs, Widoco, pyLODE, schema.org): a
 * metadata header, a readable reference for every term with an anchor that
 * matches its IRI fragment, the use cases and requirements behind it, the
 * changes in this version, and every serialisation.
 *
 * Rendered on the server as one self-contained HTML document, so it works
 * without JavaScript, can be crawled, and is also written into each release
 * (index.html) for the copy on GitHub.
 */

export interface PageRelease {
  version: string;
  level: ChangeLevel;
  publishedAt?: string;
  href: string;
}

export interface PageDownload {
  label: string;
  mediaType: string;
  href: string;
  /** File extension, used in curl examples. */
  extension: string;
}

export interface OntologyPageInput {
  project: {
    title: string;
    slug: string;
    description: string;
    prefix: string;
    namespace: string;
    ontologyIRI: string;
    github?: { repo: string };
  };
  view: OntologyView;
  /** A published release, or the unreleased working draft. */
  kind: 'release' | 'draft';
  /** '1.0.0', or 'draft' for the working draft. */
  version: string;
  release?: { level: ChangeLevel; notes: string; publishedAt?: string; githubUrl?: string };
  /** Every published release, newest first. */
  releases: PageRelease[];
  latestVersion?: string;
  downloads: PageDownload[];
  /** Where the generated JavaScript classes are, for the "Use in code" section. */
  code?: {
    moduleUrl: string;
    packageUrl: string;
    packageName: string;
    datasetClass: string;
    exampleClass?: string;
    exampleGetter?: string;
    exampleProperty?: string;
  };
  /** Absolute URL of this page. */
  pageUrl: string;
  /** report: the public report form for this ontology; site: the app's origin (for member sign-in). */
  links: { latest: string; draft: string; app?: string; versionBase: string; report?: string; site?: string };
  requirements: PublishedRequirements;
  persistentId?: { service: string; file: string; rules: string };
  generatedAt: string;
}

const KIND_LABEL: Record<TermView['kind'], string> = {
  class: 'Class',
  objectProperty: 'Object property',
  datatypeProperty: 'Datatype property',
  annotationProperty: 'Annotation property',
  individual: 'Individual',
};
const LEVEL_LABEL: Record<ChangeLevel, string> = { major: 'Major', minor: 'Minor', patch: 'Patch' };
const CHARACTERISTIC_LABEL: Record<string, string> = {
  functional: 'Functional',
  inverseFunctional: 'Inverse functional',
  transitive: 'Transitive',
  symmetric: 'Symmetric',
  asymmetric: 'Asymmetric',
  reflexive: 'Reflexive',
  irreflexive: 'Irreflexive',
};
const MAPPING_LABEL: Record<string, string> = {
  exactMatch: 'Exact match',
  closeMatch: 'Close match',
  broadMatch: 'Broader match',
  narrowMatch: 'Narrower match',
  relatedMatch: 'Related match',
  seeAlso: 'See also',
};

interface Indexed {
  term: TermView;
  anchor: string;
  name: string;
}

const isIri = (v: string) => /^[a-z][a-z0-9+.-]*:[^\s]+$/i.test(v);
/** Plain text, never HTML: always escape it. An unparseable value comes back as it was. */
const formatDate = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const anchorSafe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '-');

/**
 * Names the renderer in each page. Bump it when a change must reach release
 * pages already written to disk: refreshReleasePages regenerates any page
 * that doesn't carry the current value.
 */
export const PAGE_GENERATOR = 'Concord public page 4';

const BUG_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>';
const COPY_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

export function renderOntologyPage(input: OntologyPageInput): string {
  const { view, project } = input;
  const meta = view.metadata;
  const prefixes = { ...view.prefixes, [project.prefix]: project.namespace };
  const compact = (iri: string) => compactIRI(iri, prefixes);

  /* --------------------------- term index --------------------------- */
  const anchors = termAnchors(view, project.namespace);
  // The page's own ids step aside for term anchors (an ontology may define #main).
  const id = pageIds(anchors.values());
  const groups: { id: string; title: string; terms: TermView[] }[] = [
    { id: id('sec-classes'), title: 'Classes', terms: view.classes },
    { id: id('sec-object-properties'), title: 'Object properties', terms: view.objectProperties },
    { id: id('sec-datatype-properties'), title: 'Datatype properties', terms: view.datatypeProperties },
    { id: id('sec-annotation-properties'), title: 'Annotation properties', terms: view.annotationProperties },
    { id: id('sec-individuals'), title: 'Individuals', terms: view.individuals },
  ].map((g) => ({ ...g, terms: [...g.terms].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'en', { sensitivity: 'base' })) }));

  const index = new Map<string, Indexed>();
  for (const g of groups) for (const t of g.terms) index.set(t.iri, { term: t, anchor: anchors.get(t.iri)!, name: nameOf(t) });

  const ref = (iri: string) => {
    const hit = index.get(iri);
    if (hit) return `<a class="ref${hit.term.deprecated ? ' deprecated' : ''}" href="#${esc(fragment(hit.anchor))}" title="${esc(compact(iri))}">${esc(hit.name)}</a>`;
    const c = compact(iri);
    return safeHref(iri) ? `<a class="ref ext" href="${esc(iri)}" rel="noreferrer"><code>${esc(c)}</code></a>` : `<code>${esc(c)}</code>`;
  };
  const value = (v: string) => (isIri(v) ? ref(v) : `<span class="lit">“${esc(v)}”</span>`);
  const refs = (iris: string[]) => iris.map(ref).join('<span class="sep">, </span>');
  const restriction = (r: Restriction) => {
    const filler = r.filler ? ref(r.filler) : r.fillerExpression ? `<code>${esc(r.fillerExpression)}</code>` : r.literal !== undefined ? value(r.literal) : '';
    return `${ref(r.property)} <span class="kw">${esc(r.kind)}</span>${r.cardinality !== undefined ? ` <span class="kw">${r.cardinality}</span>` : ''} ${filler}`;
  };

  /* ------------------------ inverse relations ------------------------ */
  const subClasses = new Map<string, string[]>();
  const instances = new Map<string, string[]>();
  const domainOf = new Map<string, string[]>();
  const rangeOf = new Map<string, string[]>();
  const subProperties = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const c of view.classes) for (const s of c.superClasses) push(subClasses, s, c.iri);
  for (const i of view.individuals) for (const t of i.types) push(instances, t, i.iri);
  for (const p of [...view.objectProperties, ...view.datatypeProperties, ...view.annotationProperties]) {
    for (const d of p.domain) push(domainOf, d, p.iri);
    for (const r of p.range) push(rangeOf, r, p.iri);
    for (const s of p.superProperties) push(subProperties, s, p.iri);
  }
  const byName = (iris: string[] = []) => [...iris].sort((a, b) => (index.get(a)?.name ?? a).localeCompare(index.get(b)?.name ?? b));

  /* ---------------------------- term cards ---------------------------- */
  const row = (label: string, html: string | undefined | false) => (html ? `<div class="row"><dt>${esc(label)}</dt><dd>${html}</dd></div>` : '');
  const list = (items: string[]) => (items.length ? (items.length === 1 ? items[0] : `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`) : '');

  const annotationRows = (t: TermView) => {
    const mappings = Object.entries(t.mappings ?? {}).map(([p, iris]) => row(MAPPING_LABEL[localName(p)] ?? compact(p), refs(iris)));
    return [
      row('Also known as', t.altLabels?.length ? t.altLabels.map(esc).join(', ') : ''),
      row('Example', list((t.examples ?? []).map((e) => `<span class="example">${esc(e)}</span>`))),
      ...mappings,
      row('Source', list((t.source ?? []).map((s) => (isIri(s) && safeHref(s) ? `<a href="${esc(s)}" rel="noreferrer">${esc(s)}</a>` : esc(s))))),
      row('Editorial note', t.editorialNote ? esc(t.editorialNote) : ''),
    ].join('');
  };

  const classRows = (c: ClassView) =>
    [
      row('Subclass of', list([...c.superClasses.map(ref), ...(c.superClassExpressions ?? []).map((e) => `<code>${esc(e)}</code>`)]) || '<span class="muted">owl:Thing (top level)</span>'),
      row('Equivalent to', list([...c.equivalentClasses.map(ref), ...(c.equivalentExpressions ?? []).map((e) => `<code>${esc(e)}</code>`)])),
      row('Restrictions', list(c.restrictions.map(restriction))),
      row('Disjoint with', refs(c.disjointWith)),
      row('Superclass of', refs(byName(subClasses.get(c.iri)))),
      row('In domain of', refs(byName(domainOf.get(c.iri)))),
      row('In range of', refs(byName(rangeOf.get(c.iri)))),
      row('Instances', refs(byName(instances.get(c.iri)))),
    ].join('');

  const propertyRows = (p: PropertyView) =>
    [
      row('Domain', list([...p.domain.map(ref), ...(p.domainExpressions ?? []).map((e) => `<code>${esc(e)}</code>`)]) || '<span class="muted">Any (unconstrained)</span>'),
      row('Range', list([...p.range.map(ref), ...(p.rangeExpressions ?? []).map((e) => `<code>${esc(e)}</code>`)]) || '<span class="muted">Any (unconstrained)</span>'),
      row('Subproperty of', refs(p.superProperties)),
      row('Superproperty of', refs(byName(subProperties.get(p.iri)))),
      row('Inverse of', p.inverseOf ? ref(p.inverseOf) : ''),
      row('Characteristics', p.characteristics.map((c) => `<span class="pill">${esc(CHARACTERISTIC_LABEL[c] ?? c)}</span>`).join(' ')),
    ].join('');

  const individualRows = (i: IndividualView) =>
    [row('Instance of', refs(i.types)), ...Object.entries(i.facts).map(([p, vals]) => row(index.get(p)?.name ?? compact(p), vals.map(value).join(', ')))].join('');

  const reportHref = (t: TermView) =>
    input.links.report ? `${input.links.report}?term=${encodeURIComponent(t.iri)}&version=${encodeURIComponent(input.kind === 'draft' ? 'draft' : input.version)}` : undefined;
  const card = (t: TermView) => {
    const { anchor, name } = index.get(t.iri)!;
    const rows =
      t.kind === 'class' ? classRows(t) : t.kind === 'individual' ? individualRows(t) : propertyRows(t as PropertyView);
    const report = reportHref(t);
    return `<article class="term${t.deprecated ? ' is-deprecated' : ''}" id="${esc(anchor)}" data-kind="${t.kind}">
  <header class="term-head">
    <div class="term-title">
      <h3><a class="permalink" href="#${esc(fragment(anchor))}" aria-label="Link to ${esc(name)}">#</a>${esc(name)}</h3>
      <span class="kind kind-${t.kind}">${KIND_LABEL[t.kind]}</span>${t.deprecated ? '<span class="kind kind-deprecated">Deprecated</span>' : ''}
    </div>
    ${report ? `<a class="btn btn-ghost report-link" href="${esc(report)}" data-report data-term-iri="${esc(t.iri)}" data-term-name="${esc(name)}" data-member-href="${esc(memberReportUrl(input.links.site ?? '', project.slug, t.iri))}" rel="nofollow">${BUG_ICON}Report a problem with this term</a>` : ''}
  </header>
  <p class="iri"><code title="${esc(t.iri)}">${esc(compact(t.iri))}</code><button class="btn btn-ghost btn-icon copy" type="button" data-copy="${esc(t.iri)}" aria-label="Copy IRI" title="Copy IRI">${COPY_ICON}</button></p>
  ${t.deprecated ? `<p class="notice warn">This term is deprecated${t.replacedBy ? `. Use ${ref(t.replacedBy)} instead` : ''}.</p>` : ''}
  ${t.definition ? `<p class="definition">${esc(t.definition)}</p>` : '<p class="definition warn-text">No definition yet. Strict OWL practice expects a genus–differentia definition.</p>'}
  ${t.comment && t.comment !== t.definition ? `<p class="comment muted">${esc(t.comment)}</p>` : ''}
  ${rows || annotationRows(t) ? `<dl class="facts">${rows}${annotationRows(t)}</dl>` : ''}
</article>`;
  };

  /* ------------------------- class hierarchy ------------------------- */
  const localClass = (iri: string) => index.get(iri)?.term.kind === 'class';
  const roots = view.classes.filter((c) => !c.superClasses.some(localClass));
  // Classes the tree can't reach (a cycle with no root, say) are listed on their own, so every class can be found.
  const reached = new Set<string>();
  const reach = (iri: string) => {
    if (reached.has(iri)) return;
    reached.add(iri);
    for (const k of (subClasses.get(iri) ?? []).filter(localClass)) reach(k);
  };
  roots.forEach((r) => reach(r.iri));
  const unreached = view.classes.filter((c) => !reached.has(c.iri));
  const searchText = (t: TermView) => `${nameOf(t)} ${localName(t.iri)} ${(t.altLabels ?? []).join(' ')} ${t.definition ?? ''}`.toLowerCase();
  const navLink = (iri: string) => {
    const { term, anchor, name } = index.get(iri)!;
    return `<a class="nav-item${term.deprecated ? ' deprecated' : ''}" href="#${esc(fragment(anchor))}">${esc(name)}</a>`;
  };
  // The class tree, as in Browse: open two levels deep, the rest a click away.
  const tree = (iris: string[], seen: Set<string>, depth: number): string =>
    iris.length
      ? `<ul>${byName(iris)
          .map((iri) => {
            if (seen.has(iri)) return '';
            const kids = seen.has(iri) ? [] : (subClasses.get(iri) ?? []).filter(localClass);
            const data = ` data-term="${esc(searchText(index.get(iri)!.term))}"`;
            if (!kids.length) return `<li${data}><span class="node leaf">${navLink(iri)}</span></li>`;
            return `<li${data}><details${depth < 2 ? ' open' : ''}><summary class="node">${navLink(iri)}<span class="n">${kids.length}</span></summary>${tree(kids, new Set([...seen, iri]), depth + 1)}</details></li>`;
          })
          .join('')}</ul>`
      : '';

  /* ------------------------------ header ------------------------------ */
  const isLatest = input.kind === 'release' && input.version === input.latestVersion;
  const versionLabel = input.kind === 'draft' ? 'Working draft' : `Version ${input.version}`;
  const statusPill =
    input.kind === 'draft'
      ? '<span class="status status-draft">Unreleased draft</span>'
      : isLatest
        ? '<span class="status status-latest">Latest release</span>'
        : '<span class="status status-old">Superseded</span>';
  const banner =
    input.kind === 'draft'
      ? `<p class="notice draft" role="note">This is the working draft. It is not a release and any term may still change.${input.latestVersion ? ` The latest release is <a href="${esc(input.links.latest)}">${esc(input.latestVersion)}</a>.` : ' Nothing has been released yet.'}</p>`
      : !isLatest && input.latestVersion
        ? `<p class="notice warn" role="note">This version has been superseded. The latest release is <a href="${esc(input.links.latest)}">${esc(input.latestVersion)}</a>.</p>`
        : '';

  const people = (xs: string[]) => xs.map((x) => (isIri(x) && safeHref(x) ? `<a href="${esc(x)}" rel="noreferrer">${esc(x)}</a>` : esc(x))).join(', ');
  const versionHref = (iri?: string) => {
    if (!iri) return '';
    const v = /\/([^/]+)$/.exec(iri)?.[1];
    const local = v && input.releases.find((r) => r.version === v);
    return local ? `<a href="${esc(local.href)}"><code>${esc(iri)}</code></a>` : `<code>${esc(iri)}</code>`;
  };
  const compat = [
    ...(meta.backwardCompatibleWith ?? []).map((i) => `Backward compatible with ${versionHref(i)}`),
    ...(meta.incompatibleWith ?? []).map((i) => `<strong>Not</strong> backward compatible with ${versionHref(i)}`),
  ];

  const metaRows = [
    row('This version', input.kind === 'release' && meta.versionIRI ? `<a href="${esc(input.pageUrl)}"><code>${esc(meta.versionIRI)}</code></a>` : `<a href="${esc(input.links.draft)}">Working draft</a> (no version IRI until released)`),
    row('Latest version', `<a href="${esc(input.links.latest)}"><code>${esc(meta.iri || project.ontologyIRI)}</code></a>`),
    row('Previous version', meta.priorVersion ? versionHref(meta.priorVersion) : ''),
    row('Compatibility', list(compat)),
    row('Released', esc(formatDate(input.release?.publishedAt ?? meta.issued))),
    row('Last modified', esc(formatDate(meta.modified))),
    row('Creators', people(meta.creators)),
    row('Contributors', people(meta.contributors)),
    row('Publisher', meta.publisher ? people([meta.publisher]) : ''),
    row('Licence', meta.license ? (safeHref(meta.license) ? `<a href="${esc(meta.license)}" rel="noreferrer">${esc(meta.license)}</a>` : esc(meta.license)) : ''),
    row('Namespace', `<code>${esc(meta.preferredNamespace ?? project.namespace)}</code>, prefix <code>${esc(meta.preferredPrefix ?? project.prefix)}:</code>`),
    row('Imports', refs(meta.imports)),
  ].join('');

  const downloadsInline = input.downloads
    .map((d) => `<a class="chip" href="${esc(d.href)}" type="${esc(d.mediaType)}">${esc(d.label)}</a>`)
    .join('');

  /* ------------------------------ tabs ------------------------------ */
  const reqs = input.requirements;
  const tabs = [
    { key: 'spec' as const, id: id('tab-spec'), tabId: id('tab-spec-tab'), label: 'Specification' },
    { key: 'useCasesPanel' as const, id: id('tab-use-cases'), tabId: id('tab-use-cases-tab'), label: 'Use cases and requirements', count: reqs.useCases.length },
    { key: 'changes' as const, id: id('tab-changes'), tabId: id('tab-changes-tab'), label: 'Changes' },
    { key: 'download' as const, id: id('tab-download'), tabId: id('tab-download-tab'), label: 'Download and cite' },
  ];

  const counts = [
    { n: view.classes.length, label: 'classes', href: `#${id('sec-classes')}` },
    { n: view.objectProperties.length, label: 'object properties', href: `#${id('sec-object-properties')}` },
    { n: view.datatypeProperties.length, label: 'datatype properties', href: `#${id('sec-datatype-properties')}` },
    { n: view.individuals.length, label: 'individuals', href: `#${id('sec-individuals')}` },
  ];

  const nonEmpty = groups.filter((g) => g.terms.length);
  const navGroups = nonEmpty
    .filter((g) => g.title !== 'Classes')
    .map(
      (g) =>
        `<details class="nav-group" open><summary>${esc(g.title)} <span class="count">${g.terms.length}</span></summary><ul>${g.terms.map((t) => `<li data-term="${esc(searchText(t))}">${navLink(t.iri)}</li>`).join('')}</ul></details>`,
    )
    .join('');
  const reportDialog = input.links.report
    ? `<dialog class="report-dialog" id="${id('report-dialog')}" aria-labelledby="${id('report-dialog-title')}">
  <div class="dialog-head"><h2 id="${id('report-dialog-title')}">Report a problem with “<span data-report-name></span>”</h2><button class="btn btn-ghost btn-icon" type="button" data-close aria-label="Close">×</button></div>
  <div data-report-body>${reportChoices({ action: input.links.report, iri: '', version: input.kind === 'draft' ? 'draft' : input.version, memberUrl: input.links.app ?? '#', id })}</div>
  <div data-report-done hidden><h3 tabindex="-1" data-report-done-title>Thanks for your report</h3><p>Someone from the working group will review it.</p><p class="muted">Reference: <code data-report-ref></code></p><p><button class="btn" type="button" data-close>Close</button></p></div>
</dialog>`
    : '';
  const spec = `
<div class="browse">
  <aside class="browse-nav card" aria-label="Terms">
    <label class="search" hidden><span class="sr-only">Search terms</span><input class="term-filter" type="search" placeholder="Search terms, definitions…" autocomplete="off"></label>
    <p class="sr-only" role="status" aria-live="polite" data-search-status></p>
    <a class="nav-item nav-overview" href="#${id('sec-overview')}">Overview</a>
    ${view.classes.length ? `<p class="nav-title">Classes <span class="count">${view.classes.length}</span></p><div class="ctree">${tree(roots.map((r) => r.iri), new Set(), 0)}${unreached.length ? `<ul class="unrooted">${byName(unreached.map((c) => c.iri)).map((iri) => `<li data-term="${esc(searchText(index.get(iri)!.term))}"><span class="node leaf">${navLink(iri)}</span></li>`).join('')}</ul>` : ''}</div>` : ''}
    ${navGroups}
    <p class="muted filter-empty" hidden>No terms match.</p>
  </aside>
  <div class="browse-main">
    <section id="${id('sec-overview')}" class="card overview">
      <h2 id="${id('sec-abstract')}">Overview</h2>
      ${renderMarkdown(meta.description || project.description) || '<p class="muted">No description yet.</p>'}
      <div class="stats">${counts.filter((c) => c.n > 0).map((c) => `<a class="stat" href="${c.href}"><strong>${c.n}</strong><span>${c.label}</span></a>`).join('')}</div>
      <p class="muted pick">Pick a term on the left to see its definition, axioms and where it’s used.</p>
      <details class="namespaces" id="${id('sec-namespaces')}"><summary>Namespaces</summary>
      <table class="table"><thead><tr><th>Prefix</th><th>Namespace</th></tr></thead><tbody>
      ${Object.entries(prefixes)
        .filter(([, ns]) => ns)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([p, ns]) => `<tr><td><code>${esc(p)}:</code></td><td><code>${esc(ns)}</code></td></tr>`)
        .join('')}
      </tbody></table></details>
    </section>
    ${nonEmpty.map((g) => `<section id="${g.id}" class="term-group" aria-label="${esc(g.title)}"><h2 class="group-title">${esc(g.title)} <span class="count">${g.terms.length}</span></h2>${g.terms.map(card).join('')}</section>`).join('')}
  </div>
</div>
${reportDialog}`;

  const useCasesPanel = renderUseCases(input, reqs, ref, id);

  const history = input.releases.length
    ? `<table class="table"><thead><tr><th>Version</th><th>Released</th><th>Level</th><th></th></tr></thead><tbody>${input.releases
        .map(
          (r) =>
            `<tr${r.version === input.version ? ' class="current"' : ''}><td><a href="${esc(r.href)}">${esc(r.version)}</a></td><td>${esc(formatDate(r.publishedAt))}</td><td><span class="level level-${r.level}">${LEVEL_LABEL[r.level]}</span></td><td>${r.version === input.version ? '<span class="muted">You are here</span>' : ''}${r.version === input.latestVersion ? ' <span class="status status-latest">Latest</span>' : ''}</td></tr>`,
        )
        .join('')}<tr${input.kind === 'draft' ? ' class="current"' : ''}><td><a href="${esc(input.links.draft)}">Working draft</a></td><td class="muted">Unreleased</td><td></td><td>${input.kind === 'draft' ? '<span class="muted">You are here</span>' : ''}</td></tr></tbody></table>`
    : '<p class="muted">Nothing has been released yet.</p>';

  const changes = `
<section class="block">
  <h2>${input.kind === 'release' ? `What changed in ${esc(input.version)}` : 'Unreleased changes'}</h2>
  ${
    input.kind === 'release'
      ? `${input.release ? `<p><span class="level level-${input.release.level}">${LEVEL_LABEL[input.release.level]} release</span></p>` : ''}<div class="prose">${renderMarkdown(input.release?.notes) || '<p class="muted">No release notes.</p>'}</div>`
      : `<p>The working draft holds changes that have been approved but not yet released.${input.links.app ? ` See them as change requests <a href="${esc(input.links.app)}">in Concord</a>.` : ''}</p>`
  }
  ${input.release?.githubUrl ? `<p><a href="${esc(input.release.githubUrl)}" rel="noreferrer">This release on GitHub</a></p>` : ''}
</section>
<section class="block">
  <h2>Version history</h2>
  ${history}
</section>`;

  const exampleTarget = input.kind === 'release' ? meta.versionIRI ?? input.pageUrl : input.pageUrl;
  const turtle = input.downloads.find((d) => d.mediaType === 'text/turtle');
  const citeAuthors = meta.creators.length ? meta.creators.filter((c) => !isIri(c)).join(', ') : meta.publisher && !isIri(meta.publisher) ? meta.publisher : '';
  const citeDate = input.release?.publishedAt ?? meta.issued;
  const citation = `${citeAuthors ? `${citeAuthors}. ` : ''}${meta.title ?? project.title}. ${input.kind === 'release' ? `Version ${input.version}` : 'Working draft'}${citeDate ? `, ${formatDate(citeDate)}` : ''}. ${input.kind === 'release' && meta.versionIRI ? meta.versionIRI : project.ontologyIRI}`;
  const download = `
<section class="block">
  <h2>Formats</h2>
  <table class="table"><thead><tr><th>Format</th><th>Media type</th><th></th></tr></thead><tbody>
  ${input.downloads.map((d) => `<tr><td>${esc(d.label)}</td><td><code>${esc(d.mediaType)}</code></td><td><a href="${esc(d.href)}" type="${esc(d.mediaType)}" download>Download</a> · <a href="${esc(d.href)}" type="${esc(d.mediaType)}">View</a></td></tr>`).join('')}
  </tbody></table>
</section>
<section class="block">
  <h2>Content negotiation</h2>
  <p>The ontology IRI and every version IRI serve this page to browsers and RDF to anything that asks for it.</p>
  <pre class="code"><code>curl -L -H 'Accept: text/turtle' ${esc(exampleTarget)}
curl -L -H 'Accept: application/ld+json' ${esc(exampleTarget)}
curl -L -H 'Accept: application/rdf+xml' ${esc(exampleTarget)}
curl -L -H 'Accept-Profile: &lt;http://www.w3.org/ns/shacl#&gt;' ${esc(exampleTarget)}</code></pre>
  ${turtle ? `<p>Or add an extension to this page’s address, for example <a href="${esc(turtle.href)}"><code>${esc(turtle.href)}</code></a>.</p>` : ''}
  <p>The last one returns the SHACL shapes derived from the ontology (the SHACL profile; <code>?_profile=shacl</code> works too).</p>
</section>
<section class="block" id="validate">
  <h2>Validate data</h2>
  <p>POST RDF data (Turtle, JSON-LD, N-Triples, N-Quads, TriG or RDF/XML) to this address to check it against the ${input.kind === 'release' ? 'version’s' : 'draft’s'} SHACL shapes and terms. The answer is a JSON report, or a SHACL validation report with <code>Accept: text/turtle</code>. Nothing is stored.</p>
  <pre class="code"><code>curl -X POST ${esc(input.pageUrl)} \
  -H 'Content-Type: text/turtle' --data-binary @data.ttl</code></pre>
  ${input.links.app ? `<p>Or <a href="${esc(input.links.app)}/validate?version=${esc(encodeURIComponent(input.kind === 'release' ? input.version : 'draft'))}">upload a file in the validator</a>.</p>` : ''}
</section>
${input.code ? codeSection(input.code) : ''}
<section class="block">
  <h2>Cite this ${input.kind === 'release' ? 'version' : 'draft'}</h2>
  <pre class="code cite"><code>${esc(citation)}</code></pre>
</section>
${
  input.persistentId
    ? `<section class="block">
  <h2>Persistent identifiers</h2>
  <p>The ontology’s IRIs are under ${esc(input.persistentId.service)}, which redirects them here. If they don’t resolve yet, the redirect below needs adding to <code>${esc(input.persistentId.file)}</code>.</p>
  <details><summary>Redirect rules</summary><pre class="code"><code>${esc(input.persistentId.rules)}</code></pre></details>
</section>`
    : ''
}
${project.github ? `<section class="block"><h2>Source</h2><p>Every release is a tagged commit in <a href="https://github.com/${esc(project.github.repo)}" rel="noreferrer">github.com/${esc(project.github.repo)}</a>.</p></section>` : ''}`;

  /* ------------------------------ head ------------------------------ */
  const title = `${meta.title ?? project.title} ${input.kind === 'release' ? input.version : '(working draft)'}`;
  const description = (meta.description || project.description || '').replace(/\s+/g, ' ').slice(0, 300);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'DefinedTermSet',
    '@id': input.kind === 'release' && meta.versionIRI ? meta.versionIRI : project.ontologyIRI,
    name: meta.title ?? project.title,
    description,
    url: input.pageUrl,
    identifier: meta.iri || project.ontologyIRI,
    version: input.kind === 'release' ? input.version : undefined,
    datePublished: input.release?.publishedAt?.slice(0, 10),
    license: meta.license,
    creator: meta.creators.map((c) => (isIri(c) ? { '@id': c } : { '@type': 'Person', name: c })),
    publisher: meta.publisher ? (isIri(meta.publisher) ? { '@id': meta.publisher } : { '@type': 'Organization', name: meta.publisher }) : undefined,
    encoding: input.downloads.map((d) => ({ '@type': 'MediaObject', contentUrl: d.href, encodingFormat: d.mediaType })),
    hasDefinedTerm: [...index.values()].slice(0, 500).map(({ term, anchor, name }) => ({
      '@type': 'DefinedTerm',
      '@id': term.iri,
      name,
      description: term.definition,
      url: `${input.pageUrl}#${fragment(anchor)}`,
    })),
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="generator" content="${PAGE_GENERATOR}">
<link rel="canonical" href="${esc(input.pageUrl)}">
${input.downloads.map((d) => `<link rel="alternate" type="${esc(d.mediaType)}" href="${esc(d.href)}" title="${esc(d.label)}">`).join('\n')}
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
<style>${PAGE_CSS}</style>
</head>
<body>
<a class="skip" href="#${id('main')}">Skip to content</a>
<header class="masthead">
  <div class="wrap">
    <p class="crumbs">${input.links.app ? `<a href="${esc(input.links.app)}">Concord</a>` : 'Concord'} <span aria-hidden="true">/</span> <span>${esc(project.slug)}</span></p>
    <h1>${esc(meta.title ?? project.title)}</h1>
    <p class="subtitle">${statusPill}<span class="version">${esc(versionLabel)}</span>${input.release?.publishedAt ? `<span class="muted">Released ${esc(formatDate(input.release.publishedAt))}</span>` : ''}</p>
    ${banner}
    <dl class="meta">${metaRows}</dl>
    <p class="downloads"><span class="muted">Download</span> ${downloadsInline}</p>
  </div>
</header>
<div class="tabbar">
  <nav class="tabs wrap" role="tablist" aria-label="Sections">
    ${tabs.map((t, i) => `<a role="tab" id="${t.tabId}" href="#${t.id}" aria-controls="${t.id}" aria-selected="${i === 0}">${esc(t.label)}${t.count !== undefined ? ` <span class="count">${t.count}</span>` : ''}</a>`).join('')}
  </nav>
</div>
<main id="${id('main')}" class="wrap">
  ${tabs.map((t) => `<section id="${t.id}" role="tabpanel" aria-labelledby="${t.tabId}" class="panel" tabindex="0">${{ spec, useCasesPanel, changes, download }[t.key]}</section>`).join('\n  ')}
</main>
<footer class="foot wrap">
  <p>${esc(meta.title ?? project.title)} · ${esc(versionLabel)} · Published with Concord${input.links.app ? ` · <a href="${esc(input.links.app)}">Take part in developing this standard</a>` : ''}</p>
</footer>
<script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}

function nameOf(t: TermView) {
  return t.label?.trim() || localName(t.iri) || t.iri;
}

/* ------------------------------------------------------------------------ */
/* Use cases and requirements                                               */
/* ------------------------------------------------------------------------ */

type StatusGroup = 'closed' | 'addressed' | 'open' | 'parked';
const STATUS: Record<string, { label: string; group: StatusGroup }> = {
  proposed: { label: 'Proposed', group: 'open' },
  triage: { label: 'In triage', group: 'open' },
  accepted: { label: 'Accepted', group: 'open' },
  'in-progress': { label: 'In progress', group: 'open' },
  addressed: { label: 'In the working draft', group: 'addressed' },
  covered: { label: 'Covered', group: 'closed' },
  closed: { label: 'Closed', group: 'closed' },
  deferred: { label: 'Deferred', group: 'parked' },
  'out-of-scope': { label: 'Out of scope', group: 'parked' },
  rejected: { label: 'Not taken forward', group: 'parked' },
};
const statusOf = (s: string) => STATUS[s] ?? { label: s.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()), group: 'open' as const };
const REQ_STATUS: Record<string, string> = { met: 'Met', partial: 'Partly met', open: 'Open' };
const ORIGIN_LABEL: Record<string, string> = {
  meeting: 'From a working group call',
  interview: 'From an interview',
  chat: 'From an interview',
  agent: 'From a coding agent',
  form: 'Submitted directly',
  synthetic: 'Anonymised example',
};

function renderUseCases(input: OntologyPageInput, reqs: PublishedRequirements, ref: (iri: string) => string, id: (name: string) => string): string {
  const ucs = reqs.useCases;
  const ucId = (u: { id: string }) => id(`uc-${anchorSafe(u.id)}`);
  const byId = new Map(ucs.map((u) => [u.id, u]));
  const releaseHref = (v?: string) => {
    const r = v && input.releases.find((x) => x.version === v);
    return r ? `<a href="${esc(r.href)}">${esc(v)}</a>` : esc(v ?? '');
  };
  const ucLink = (id: string) => {
    const u = byId.get(id);
    return u ? `<a class="uc-ref" href="#${esc(fragment(ucId(u)))}">${esc(u.ref)}</a>` : '';
  };

  const groupCount = (g: StatusGroup) => ucs.filter((u) => statusOf(u.status).group === g).length;
  const closedHere = ucs.filter((u) => statusOf(u.status).group === 'closed' && u.addressedIn === input.version).length;

  const doc = reqs.document;
  const reqTable = (rows: RequirementView[]) =>
    rows.length
      ? `<h3 id="${id('sec-requirements')}">Requirements</h3><table class="table reqs"><thead><tr><th>Id</th><th>Requirement</th><th>Use cases</th><th>Status</th></tr></thead><tbody>${rows
          .map(
            (r) =>
              `<tr id="${esc(id(`req-${anchorSafe(r.id)}`))}"><td><code>${esc(r.id)}</code></td><td>${esc(r.text)}${r.termIris?.length ? `<div class="req-terms muted small">Met by ${r.termIris.map(ref).join(', ')}</div>` : ''}</td><td>${r.useCaseIds.map(ucLink).filter(Boolean).join(', ') || '<span class="muted">None</span>'}</td><td><span class="req req-${esc(anchorSafe(r.status))}">${esc(REQ_STATUS[r.status] ?? r.status)}</span></td></tr>`,
          )
          .join('')}</tbody></table>`
      : '';

  const story = doc
    ? `<article class="story block" aria-labelledby="${id('sec-story')}">
  <p class="eyebrow">Requirements document${doc.version && doc.version !== 'draft' ? ` for ${esc(doc.version)}` : ''}</p>
  <h2 id="${id('sec-story')}">${esc(doc.title)}</h2>
  <div class="prose">${renderMarkdown(doc.intro)}${renderMarkdown(doc.markdown)}${(doc.sections ?? []).map((s) => `<h3 id="${esc(id(`sec-story-${anchorSafe(s.id)}`))}">${esc(s.heading)}</h3>${renderMarkdown(s.markdown)}`).join('')}</div>
  ${reqTable(doc.requirements ?? [])}
  ${doc.unpublished && doc.unpublished.group + doc.unpublished.private > 0 ? `<p class="muted small">${[doc.unpublished.group ? `${plural(doc.unpublished.group, 'working group use case')}` : '', doc.unpublished.private ? `${plural(doc.unpublished.private, 'private use case')}` : ''].filter(Boolean).join(' and ')} also informed this version. They are not published here.</p>` : ''}
  ${doc.generatedAt ? `<p class="muted small">Written from the use cases below on ${esc(formatDate(doc.generatedAt))}. Each reference links to the use case it draws on.</p>` : ''}
</article>`
    : `<div class="notice" role="note">${
        input.kind === 'release'
          ? `There is no requirements document for ${esc(input.version)} yet.`
          : 'The requirements document is written when a version is released.'
      }${ucs.length ? ' The use cases below are the material it draws on.' : ''}</div>`;

  const scenarioList = (u: PublicUseCaseView) => (u.scenarios?.length ? `<h5>Scenarios</h5><ul>${u.scenarios.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '');
  const cqList = (u: PublicUseCaseView) =>
    u.competencyQuestions?.length
      ? `<h5>Questions the ontology must answer</h5><ul class="cqs">${u.competencyQuestions
          .map((q) => (typeof q === 'string' ? `<li>${esc(q)}</li>` : `<li>${esc(q.question)}${q.exampleAnswer ? `<span class="muted"> For example: ${esc(q.exampleAnswer)}</span>` : ''}</li>`))
          .join('')}</ul>`
      : '';

  const card = (u: PublicUseCaseView) => {
    const st = statusOf(u.status);
    const when = u.addressedIn ? ` in ${releaseHref(u.addressedIn)}` : '';
    const origin = u.origin ? ORIGIN_LABEL[u.origin.kind] ?? `From ${u.origin.kind}` : u.anonymised ? ORIGIN_LABEL.synthetic : '';
    const originHtml = origin
      ? `${u.origin?.href && safeHref(u.origin.href) ? `<a href="${esc(u.origin.href)}">${esc(u.origin.label || origin)}</a>` : esc(u.origin?.label || origin)}${u.origin?.date ? `, ${esc(formatDate(u.origin.date))}` : ''}`
      : '';
    const by = u.attribution ? `Contributed by ${esc(u.attribution)}` : u.anonymised ? 'Anonymised and contributed with consent' : '';
    return `<article class="uc" id="${esc(ucId(u))}" data-group="${st.group}">
  <header class="uc-head">
    <span class="uc-id">${esc(u.ref)}</span>
    <h4>${esc(u.title)}</h4>
    <span class="ucs ucs-${st.group}">${esc(st.label)}${when}</span>
  </header>
  ${u.summary ? `<p>${esc(u.summary)}</p>` : ''}
  ${u.goal ? `<p><strong>Goal.</strong> ${esc(u.goal)}</p>` : ''}
  ${u.description ? `<p>${esc(u.description)}</p>` : ''}
  ${u.actors ? `<p><strong>Who is involved.</strong> ${esc(u.actors)}</p>` : ''}
  ${scenarioList(u)}${cqList(u)}
  ${by || originHtml ? `<p class="uc-meta muted">${[by, originHtml].filter(Boolean).join(' · ')}${u.anonymised ? ' <span class="pill">Anonymised</span>' : ''}</p>` : ''}
</article>`;
  };

  const filters: { key: StatusGroup | 'all'; label: string; n: number }[] = [
    { key: 'all', label: 'All', n: ucs.length },
    { key: 'closed', label: 'Closed', n: groupCount('closed') },
    { key: 'addressed', label: 'In the working draft', n: groupCount('addressed') },
    { key: 'open', label: 'Open', n: groupCount('open') },
    { key: 'parked', label: 'Deferred or out of scope', n: groupCount('parked') },
  ];

  return `
<section class="block intro">
  <h2>Use cases and requirements</h2>
  <p class="lede">Why this ontology exists: the situations it has to support, the requirements drawn from them, and how each use case has been taken into a version.</p>
  ${
    ucs.length
      ? `<p class="summary">${[
          plural(ucs.length, 'public use case'),
          input.kind === 'release' && closedHere ? `${closedHere} closed in ${esc(input.version)}` : '',
          groupCount('addressed') ? `${groupCount('addressed')} in the working draft` : '',
          groupCount('open') ? `${groupCount('open')} open` : '',
        ]
          .filter(Boolean)
          .join(' · ')}</p>`
      : ''
  }
</section>
${story}
<section class="block" aria-labelledby="${id('sec-use-cases')}">
  <h2 id="${id('sec-use-cases')}">Use cases</h2>
  ${
    ucs.length
      ? `<div class="uc-filters" role="group" aria-label="Filter use cases by status">${filters
          .filter((f) => f.key === 'all' || f.n)
          .map((f) => `<button type="button" data-filter="${f.key}" aria-pressed="${f.key === 'all'}">${esc(f.label)} <span class="count">${f.n}</span></button>`)
          .join('')}</div>${ucs.map(card).join('')}`
      : reqs.snapshotMissing
        ? '<p class="muted snapshot-missing">The use cases for this release were not recorded when it was published, so none are shown. The working draft has the current ones.</p>'
        : '<p class="muted">No public use cases yet. Use cases shared privately or with the working group only are not shown here.</p>'
  }
</section>`;
}

/** How to use the generated classes from JavaScript or TypeScript. */
function codeSection(code: NonNullable<OntologyPageInput['code']>): string {
  const loop = code.exampleGetter
    ? `\nfor (const item of data.${code.exampleGetter}) {\n  console.log(item.value${code.exampleProperty ? `, item.${code.exampleProperty}` : ''});\n}`
    : '';
  return `
<section class="block" id="sec-code">
  <h2>Use in JavaScript and TypeScript</h2>
  <p>Every SHACL shape is also a class, generated with <a href="https://github.com/theodi/shacl-shape-converter-typescript" rel="noreferrer">the ODI SHACL converter</a> over <a href="https://github.com/rdfjs/wrapper" rel="noreferrer">@rdfjs/wrapper</a>. Its accessors read and write RDF in any RDF/JS dataset, such as an N3.js store.</p>
  <h3>In a browser, with no build step</h3>
  <pre class="code"><code>import { ${esc(code.datasetClass)} } from &quot;${esc(code.moduleUrl)}&quot;;

const data = new ${esc(code.datasetClass)}(store, DataFactory);${esc(loop)}</code></pre>
  <h3>With npm and a bundler</h3>
  <pre class="code"><code>npm install ${esc(code.packageUrl)}</code></pre>
  <pre class="code"><code>import { ${esc(code.datasetClass)}${code.exampleClass ? `, ${esc(code.exampleClass)}` : ''} } from &quot;${esc(code.packageName)}&quot;;</code></pre>
  <p class="muted small">The package name stays the same for every version and fork, so moving an app from a fork to a release only changes the URL in <code>package.json</code>. The TypeScript source and declarations are at <a href="${esc(code.moduleUrl.replace(/\.js$/, '.ts'))}"><code>.ts</code></a> and <a href="${esc(code.moduleUrl.replace(/\.js$/, '.d.ts'))}"><code>.d.ts</code></a>.</p>
</section>`;
}
