import type { ForkSummary, OntologyProject, User } from '@concord/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { config } from './config.js';
import { HttpError } from './db.js';
import { ProposedTermSchema } from './llm/schemas.js';
import { checkFork, closeFork, createFork, discardForkChanges, editFork, findFork, forkSummary, forksOwnedBy, listForks, proposeFork, syncFork } from './services/forks.js';

/**
 * MCP tools for development forks. The loop for an agent building an app:
 *
 *   1. create_fork, then point the app's imports at the fork URL it returns
 *   2. edit_fork to add the terms the feature needs (usable immediately)
 *   3. propose_fork to open a change request upstream
 *   4. check_forks at the start of every session; when the terms land, follow
 *      the migration plan to move the app back to the main ontology
 */

export const FORK_INSTRUCTIONS =
  'If the ontology lacks a term your application needs, do not wait for it: create_fork gives you a personal pre-release of the ontology at a stable URL that you can import straight away, edit_fork adds the term, and propose_fork asks the standard to adopt it. New terms keep the standard\'s namespace, so your data stays valid when the change lands. At the start of every development session, call check_forks: it tells you whether your forks\' terms have been merged or released and, if so, exactly which import URLs to change.';

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const fail = (t: string): Text => ({ content: [{ type: 'text', text: t }], isError: true });

/** The part of a fork summary an agent needs. */
function brief(f: ForkSummary) {
  return {
    id: f.id,
    fork: `${f.ontology.slug}/${f.slug}`,
    title: f.title,
    purpose: f.purpose,
    status: f.status,
    version: f.version,
    iri: f.urls.iri,
    importUrls: f.urls.formats,
    appUrl: f.urls.app,
    upstream: `${f.ontology.title} ${f.ontology.currentVersion}`,
    behindUpstreamBy: f.behindBy || undefined,
    terms: f.terms.map((t) => ({ term: t.curie, iri: t.iri, change: t.change, upstream: t.upstream, releasedIn: t.releasedIn })),
    changeRequest: f.changeRequest,
  };
}

/** Hints connector directories require on every tool. */
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const howToImport = (f: ForkSummary) =>
  `Import the fork instead of the released ontology while you develop: use a file URL such as ${f.urls.formats.turtle} (or ${f.urls.iri} with an Accept header for the RDF format you want; like the release IRIs, it gives HTML to browsers and */*). Terms use the standard's own namespace, so nothing else in your code changes. Call check_forks at the start of each session to find out when you can switch back.`;

export function registerForkTools(server: McpServer, user: User, resolveOntology: (ref: string) => OntologyProject | undefined) {
  const forkArg = z.string().describe('Fork id (frk_…) or "<ontology-slug>/<fork-slug>", as returned by create_fork or list_forks');
  const guard = async (fn: () => Promise<Text>): Promise<Text> => {
    try {
      return await fn();
    } catch (err) {
      return fail(err instanceof HttpError || err instanceof Error ? err.message : String(err));
    }
  };
  const withFork = (ref: string, fn: (f: NonNullable<ReturnType<typeof findFork>>) => Promise<Text>) =>
    guard(async () => {
      const f = findFork(ref);
      if (!f) return fail(`No fork called "${ref}". Call list_forks to see yours.`);
      return fn(f);
    });

  server.registerTool(
    'create_fork',
    {
      title: 'Fork an ontology for development',
      description:
        'Create your own development fork (a pre-release) of an ontology, so you can add the terms your application needs and use them immediately while the change is reviewed. Returns the fork\'s URL to import in your application.',
      inputSchema: {
        ontology: z.string().describe('Ontology slug, prefix or IRI, from list_ontologies'),
        name: z.string().max(80).describe('Short name, e.g. "Volunteer hours"'),
        purpose: z.string().optional().describe('What you are building and why you need new terms, e.g. "Logging volunteer hours in the Helping Hands app"'),
      },
      annotations: WRITES,
    },
    ({ ontology, name, purpose }) =>
      guard(async () => {
        const p = resolveOntology(ontology);
        if (!p) return fail(`No ontology called "${ontology}". Call list_ontologies to see what exists.`);
        const f = await forkSummary(await createFork(p, user, { name, purpose }));
        return json({ ...brief(f), howToImport: howToImport(f), next: 'Add the terms you need with edit_fork.' });
      }),
  );

  server.registerTool(
    'list_forks',
    {
      title: 'List forks',
      description: 'List development forks: your own (default), or every fork of one ontology.',
      inputSchema: { ontology: z.string().optional().describe('Show every fork of this ontology instead of only yours') },
      annotations: { readOnlyHint: true },
    },
    ({ ontology }) =>
      guard(async () => {
        if (ontology) {
          const p = resolveOntology(ontology);
          if (!p) return fail(`No ontology called "${ontology}".`);
          return json(await Promise.all(listForks(p.id).map(async (f) => brief(await forkSummary(f)))));
        }
        return json(await Promise.all(forksOwnedBy(user.id).map(async (f) => brief(await forkSummary(f)))));
      }),
  );

  server.registerTool(
    'get_fork',
    { title: 'Get fork', description: 'A fork\'s URLs, its terms and where each one stands upstream.', inputSchema: { fork: forkArg }, annotations: { readOnlyHint: true } },
    ({ fork }) => withFork(fork, async (f) => json(brief(await forkSummary(f)))),
  );

  server.registerTool(
    'edit_fork',
    {
      title: 'Add or change terms in a fork',
      description:
        'Add terms to your fork (or change existing ones). Describe them in plain language, e.g. "Add a class VolunteeringActivity, a record of hours a volunteer gave, with a datatype property hoursVolunteered (xsd:decimal)", or pass structured terms for exact control. The edit is checked for logical consistency and is live at the fork URL as soon as this returns.',
      inputSchema: {
        fork: forkArg,
        description: z.string().optional().describe('The terms to add or change, in plain language'),
        terms: z.array(ProposedTermSchema).optional().describe('Structured terms (action add/update/deprecate, kind, localName, label, definition, superClasses, domain, range…); CURIEs resolve against the ontology'),
        message: z.string().optional().describe('A short summary of the edit, for the fork history'),
      },
      annotations: WRITES,
    },
    ({ fork, description, terms, message }) =>
      withFork(fork, async (f) => {
        if (!description && !terms?.length) return fail('Give a description or structured terms.');
        const r = await editFork(f, user, { description, terms, message });
        return json({
          fork: brief(r.fork),
          added: r.terms.map((t) => ({ term: t.curie, iri: t.iri, kind: t.kind, change: t.change })),
          validation: r.validation,
          warnings: r.warnings.length ? r.warnings : undefined,
          next: r.fork.changeRequest && ['review', 'voting', 'needs-work', 'triage'].includes(r.fork.changeRequest.status)
            ? `Change request #${r.fork.changeRequest.number} is open: call propose_fork again to update it with this edit.`
            : 'The new terms are live at the fork URL. When they work for you, call propose_fork.',
        });
      }),
  );

  server.registerTool(
    'propose_fork',
    {
      title: 'Propose a fork upstream',
      description:
        'Ask the standard to adopt your fork\'s edits: opens one change request (or updates the open one) that is classified as patch/minor/major, validated and reviewed under the ontology\'s governance policy. Keep using the fork meanwhile.',
      inputSchema: { fork: forkArg, title: z.string().optional(), description: z.string().optional().describe('Why the standard needs these terms; defaults to the fork\'s purpose') },
      annotations: WRITES,
    },
    ({ fork, title, description }) =>
      withFork(fork, async (f) => {
        const r = await proposeFork(f, user, { title, description });
        const cr = r.changeRequest;
        return json({
          fork: brief(r.fork),
          changeRequest: { id: cr.id, number: cr.number, title: cr.title, status: cr.status, level: cr.classification?.level, validationPassed: cr.validation?.passed, url: `${config.webUrl}/o/${r.fork.ontology.slug}/changes/${cr.id}` },
          next: 'Keep importing the fork. Call check_forks at the start of each session to see when the change lands.',
        });
      }),
  );

  server.registerTool(
    'check_forks',
    {
      title: 'Check forks against upstream',
      description:
        'Call this at the start of every development session. For each of your forks (or one fork), reports whether its terms are still pending review, merged into the working draft or released, and returns what to do: keep using the fork, sync it, resolve conflicts with upstream, or (once everything in the fork has landed exactly as it is in the fork) which import URLs to replace. A term that landed in a different form from the fork counts as not landed, so you never switch to a version that lacks what your code uses.',
      inputSchema: { fork: forkArg.optional().describe('Check one fork; default is all of your forks that are still in use') },
      annotations: { readOnlyHint: true },
    },
    ({ fork }) =>
      guard(async () => {
        const targets = fork ? [findFork(fork)].filter((f) => !!f) : forksOwnedBy(user.id).filter((f) => f.status !== 'closed');
        if (fork && !targets.length) return fail(`No fork called "${fork}".`);
        if (!targets.length) return text('You have no forks in use. If an ontology is missing a term you need, create_fork lets you add it and keep building.');
        const checks = await Promise.all(targets.map((f) => checkFork(f)));
        return json(
          checks.map((c) => ({
            fork: `${c.fork.ontology.slug}/${c.fork.slug}`,
            outcome: c.outcome,
            message: c.message,
            steps: c.steps,
            replace: c.replace.length ? c.replace : undefined,
            conflicts: c.conflicts.length ? c.conflicts : undefined,
            terms: c.fork.terms.map((t) => ({ term: t.curie, change: t.change, upstream: t.upstream, releasedIn: t.releasedIn })),
            changeRequest: c.fork.changeRequest,
          })),
        );
      }),
  );

  server.registerTool(
    'sync_fork',
    {
      title: 'Sync a fork with upstream',
      description: 'Replay your fork\'s edits on the latest upstream draft, so the fork picks up everything the standard has changed since you forked. Edits that already landed are dropped. If upstream changed a term the fork also changes, or the combination would be inconsistent, nothing changes and the conflicts are returned: resolve them with discard_fork_changes.',
      inputSchema: { fork: forkArg },
      annotations: WRITES,
    },
    ({ fork }) =>
      withFork(fork, async (f) => {
        const r = await syncFork(f, user);
        return json({ synced: r.synced, message: r.message, conflicts: r.conflicts.length ? r.conflicts : undefined, fork: brief(r.fork) });
      }),
  );

  server.registerTool(
    'discard_fork_changes',
    {
      title: 'Discard changes in a fork',
      description:
        'Drop the fork\'s changes to some terms (or all of them), so the fork goes back to upstream\'s version of those terms. Use it to resolve a conflict reported by sync_fork or check_forks: discard, sync, then redo the change with edit_fork if you still need it.',
      inputSchema: {
        fork: forkArg,
        terms: z.array(z.string()).optional().describe('Terms whose changes to drop, as CURIEs (vol:Shift) or IRIs, or keys from a conflict; omit with all: true to drop everything'),
        all: z.boolean().optional().describe('Drop every change in the fork'),
        includeRelated: z.boolean().optional().describe('Also drop changes to other terms made in the same edit (the error lists them when this is needed)'),
      },
      annotations: { ...WRITES, destructiveHint: true },
    },
    ({ fork, terms, all, includeRelated }) =>
      withFork(fork, async (f) => {
        if (!all && !terms?.length) return fail('Name the terms whose changes to discard, or pass all: true.');
        const r = await discardForkChanges(f, user, all ? 'all' : terms!, { includeRelated });
        return json({ fork: brief(r), next: r.behindBy ? 'Now call sync_fork to pick up upstream\'s changes.' : 'Done.' });
      }),
  );

  server.registerTool(
    'close_fork',
    { title: 'Close a fork', description: 'Close a fork you no longer use (after migrating to a release). It keeps resolving, so nothing breaks.', inputSchema: { fork: forkArg }, annotations: WRITES },
    ({ fork }) => withFork(fork, async (f) => json(brief(await closeFork(f, user)))),
  );
}
