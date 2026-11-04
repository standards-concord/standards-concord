import { compactIRI, expandIRI, FORMAT_INFO, serialize } from '@concord/core';
import type { OutputFormat } from '@concord/core/types';
import type { OntologyProject, User } from '@concord/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import * as z from 'zod';
import { config } from './config.js';
import { list } from './db.js';
import { reportGap, sparql, validateData } from './services/agents.js';
import { createChangeRequest, detail, getCR } from './services/changeRequests.js';
import { findProject } from './services/ontologies.js';
import { ontologyStore } from './services/ontologyStore.js';
import { authenticateMcp, publicOrigin, resourceMetadataUrlFor } from './oauth.js';

/**
 * MCP connector for coding agents (Claude Code, Codex, Cursor…).
 *
 *   claude mcp add --transport http concord https://<host>/mcp
 *
 * The client signs the person in with OAuth (see oauth.ts); a personal token
 * in an Authorization header also works for headless agents.
 *
 * Agents can read ontologies in any format (including LinkML), query them,
 * check their data, and report missing or ill-fitting concepts. Reports are
 * triaged immediately and the answer is returned to the agent; if the ontology
 * should change, a change request enters the governance lifecycle.
 */

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

const link = (path: string) => `${config.webUrl}${path}`;

function resolve(ref: string): OntologyProject | undefined {
  return findProject(ref) ?? list<OntologyProject>('ontologies').find((o) => o.prefix === ref || o.ontologyIRI === ref || o.title.toLowerCase() === ref.toLowerCase());
}

function buildServer(user: User, agentName: string) {
  const server = new McpServer(
    { name: 'concord', version: '0.1.0' },
    {
      instructions:
        'Concord hosts the Open Data Institute ontologies (strict OWL 2). Use list_ontologies and search_terms before inventing your own terms. When the ontology lacks something you need, or a term does not fit your data, call report_gap: you get an answer straight away (use these existing terms / define a local extension / a change request was opened), and the community decides on any change.',
    },
  );
  const ontologyArg = z.string().describe('Ontology slug, prefix or IRI, from list_ontologies');
  const withProject = async <T>(ref: string, fn: (p: OntologyProject) => Promise<T>) => {
    const p = resolve(ref);
    if (!p) return fail(`No ontology called "${ref}". Call list_ontologies to see what exists.`);
    try {
      return (await fn(p)) as never;
    } catch (err) {
      return fail((err as Error).message);
    }
  };

  server.registerTool(
    'list_ontologies',
    { title: 'List ontologies', description: 'List the ontologies on Concord with their prefix, namespace, version and size.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      const rows = await Promise.all(
        list<OntologyProject>('ontologies').map(async (p) => {
          const v = (await ontologyStore.working(p)).view();
          return { slug: p.slug, title: p.title, prefix: p.prefix, namespace: p.namespace, version: p.currentVersion, stage: p.stage, classes: v.classes.length, properties: v.objectProperties.length + v.datatypeProperties.length, url: link(`/o/${p.id}`) };
        }),
      );
      return json(rows);
    },
  );

  server.registerTool(
    'get_ontology',
    {
      title: 'Get ontology source',
      description: `Get an ontology in a given format. Formats: ${Object.keys(FORMAT_INFO).join(', ')}. LinkML is useful for generating code (pydantic, TypeScript, JSON Schema).`,
      inputSchema: { ontology: ontologyArg, format: z.enum(Object.keys(FORMAT_INFO) as [OutputFormat, ...OutputFormat[]]).default('turtle'), version: z.string().optional().describe('Released version such as 1.2.0; default is the working draft') },
      annotations: { readOnlyHint: true },
    },
    ({ ontology, format, version }) => withProject(ontology, async (p) => text(await serialize(await ontologyStore.at(p, version), format))),
  );

  server.registerTool(
    'search_terms',
    { title: 'Search terms', description: 'Find classes and properties by label, synonym, definition or name.', inputSchema: { ontology: ontologyArg, query: z.string(), limit: z.number().int().min(1).max(50).default(10) }, annotations: { readOnlyHint: true } },
    ({ ontology, query, limit }) =>
      withProject(ontology, async (p) => {
        const g = await ontologyStore.working(p);
        const c = (i: string) => compactIRI(i, g.prefixes);
        return json(
          g.search(query, limit).map((t) => ({
            id: c(t.iri),
            iri: t.iri,
            kind: t.kind,
            label: t.label,
            definition: t.definition,
            deprecated: t.deprecated || undefined,
            replacedBy: t.replacedBy ? c(t.replacedBy) : undefined,
          })),
        );
      }),
  );

  server.registerTool(
    'get_term',
    { title: 'Get term', description: 'Full details of one term (CURIE such as vol:Volunteer, or full IRI): definition, superclasses, restrictions, domain and range.', inputSchema: { ontology: ontologyArg, term: z.string() }, annotations: { readOnlyHint: true } },
    ({ ontology, term }) =>
      withProject(ontology, async (p) => {
        const g = await ontologyStore.working(p);
        const t = g.term(expandIRI(term, g.prefixes)) ?? g.search(term, 1)[0];
        return t ? json(t) : fail(`No term ${term}. Try search_terms.`);
      }),
  );

  server.registerTool(
    'sparql_query',
    { title: 'SPARQL query', description: 'Run a read-only SPARQL query over the ontology itself (not instance data).', inputSchema: { ontology: ontologyArg, query: z.string(), version: z.string().optional() }, annotations: { readOnlyHint: true } },
    ({ ontology, query, version }) => withProject(ontology, async (p) => json(await sparql(p, query, version))),
  );

  server.registerTool(
    'validate_data',
    {
      title: 'Validate instance data',
      description: 'Check Turtle instance data against the ontology: undefined or deprecated terms, and logical contradictions (e.g. disjoint types, wrong ranges).',
      inputSchema: { ontology: ontologyArg, turtle: z.string().describe('Instance data in Turtle, with prefixes') },
      annotations: { readOnlyHint: true },
    },
    ({ ontology, turtle }) => withProject(ontology, async (p) => json(await validateData(p, turtle))),
  );

  server.registerTool(
    'report_gap',
    {
      title: 'Report a missing concept or misfit',
      description:
        'Tell the standard\'s maintainers that the ontology is missing something you need, does not fit your data, or has a bug. Returns an immediate recommendation and, when the ontology should change, a change request link. Include concrete context: what you were building, sample data, the fields you could not map.',
      inputSchema: {
        ontology: ontologyArg,
        kind: z.enum(['missing-concept', 'does-not-fit', 'bug', 'question']),
        summary: z.string().max(200).describe('One line, e.g. "No way to say an opportunity reimburses travel expenses"'),
        details: z.string().describe('What you need and why'),
        context: z.string().optional().describe('Code, schema or sample data that shows the problem'),
      },
      // Adds a report (and maybe a change request) for maintainers to review; never edits the ontology directly.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      withProject(args.ontology, async (p) => {
        const r = await reportGap(p, user, { agentName, kind: args.kind, summary: args.summary, details: args.details, context: args.context });
        return json({
          recommendation: r.analysis?.recommendation,
          answer: r.analysis?.summary,
          rationale: r.analysis?.rationale,
          existingTerms: r.analysis?.existingTerms,
          changeRequest: r.changeRequestId ? { id: r.changeRequestId, url: link(`/o/${p.id}/changes/${r.changeRequestId}`) } : undefined,
        });
      }),
  );

  server.registerTool(
    'propose_change',
    {
      title: 'Propose a change',
      description: 'Propose a specific change to the ontology in plain language ("add a datatype property expensesReimbursed on VolunteeringOpportunity"). It is drafted into structured edits, classified as patch/minor/major, validated and opened for review under the ontology\'s governance policy.',
      inputSchema: { ontology: ontologyArg, title: z.string(), description: z.string() },
      // Opens a change request for review under the ontology's governance; nothing changes until it is approved.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ ontology, title, description }) =>
      withProject(ontology, async (p) => {
        const cr = await createChangeRequest(p, user, { title, description, naturalLanguage: `${title}\n\n${description}`, kind: 'feature', origin: { type: 'agent', agentName }, submit: true });
        return json(summariseCR(cr.id, p));
      }),
  );

  server.registerTool(
    'get_change_request',
    { title: 'Get change request', description: 'Status, classification, validation and governance state of a change request.', inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ id }) => {
      try {
        const cr = getCR(id);
        return json(summariseCR(cr.id, resolve(cr.ontologyId)!));
      } catch {
        return fail(`No change request ${id}`);
      }
    },
  );

  return server;
}

function summariseCR(id: string, p: OntologyProject) {
  const d = detail(getCR(id));
  return {
    id: d.id,
    number: d.number,
    title: d.title,
    status: d.status,
    level: d.classification?.level,
    reasons: d.classification?.reasons.map((r) => `[${r.level}] ${r.message}`),
    validationPassed: d.validation?.passed,
    errors: d.validation?.lint.filter((i) => i.severity === 'error').map((i) => i.message),
    next: d.governance.next,
    url: link(`/o/${p.id}/changes/${d.id}`),
  };
}

export async function mcpHandler(req: Request, res: Response) {
  const who = await authenticateMcp(req);
  if (who.error) {
    // Per the MCP authorization spec: point the client at our Protected Resource Metadata so it can start the OAuth flow.
    const origin = publicOrigin(req);
    const challenge = `Bearer resource_metadata="${resourceMetadataUrlFor(origin)}"${who.error === 'invalid' ? ', error="invalid_token", error_description="The access token is invalid or expired"' : ''}`;
    res
      .status(401)
      .set('WWW-Authenticate', challenge)
      .json({ jsonrpc: '2.0', error: { code: -32001, message: `Sign in to connect: your MCP client should open a browser window. Setup help: ${origin}/connect` }, id: null });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    return;
  }
  const agentName = req.header('x-agent-name') ?? (req.body?.params?.clientInfo?.name as string | undefined) ?? who.agentName;
  const server = buildServer(who.user, agentName);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
