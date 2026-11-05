import express, { Router, type Request } from 'express';
import { compactIRI, expandIRI, FORMAT_INFO, serialize, validate } from '@concord/core';
import type { OutputFormat, TermView } from '@concord/core/types';
import type { ChangeRequestKind, GovernancePolicy, Meeting, OntologySummary, Role, SessionInfo, User } from '@concord/shared';
import { PUBLIC_NOTICE_VERSION, ROLE_INFO } from '@concord/shared';
import { providers, requireUser, SESSION_COOKIE, setSessionCookie } from '../auth.js';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { get, HttpError, list, put } from '../db.js';
import { newId } from '../ids.js';
import { llm } from '../llm/provider.js';
import { getAgentReport, listAgentReports, reportGap, sparql } from '../services/agents.js';
import * as crs from '../services/changeRequests.js';
import { proposeTermEdit } from '../services/termEdits.js';
import { withTriageBudget } from '../services/budget.js';
import { feedbackChat, listFeedback, questionsFor, submitFeedback, summariseFeedback, transcribe, type Pathway } from '../services/feedback.js';
import { alphaMe, clearTesterCookie, recordVersion, rememberTester, testerFor, testerForSaving } from '../services/alpha.js';
import {
  checkPublicSummary,
  issuesEnabled,
  processWithin,
  publicationFor,
  publicationsNeedingAdmin,
  queuePublication,
  resolvePublication,
  status,
  triageEnabled,
  triagePublication,
  triageQueue,
  triageTokenMatches,
  withdrawPublication,
  type AdminAction,
} from '../services/feedbackIssues.js';
import { listTemplates } from '../services/governance.js';
import * as meetBot from '../services/meetBot.js';
import * as meetings from '../services/meetings.js';
import {
  competencyTests,
  createProject,
  membersWithUsers,
  mustFindProject,
  removeMember,
  requireRole,
  rolesFor,
  setGovernance,
  setRoles,
  summary,
  updateProject,
  workingValidation,
} from '../services/ontologies.js';
import { ontologyStore } from '../services/ontologyStore.js';
import { PERSONAS } from '../services/personas.js';
import * as releases from '../services/releases.js';
import { fairContext } from '../services/fairResolution.js';
import { advanceClock, DEMO_SLUG, resetAll, seedDemo, step } from '../services/simulation.js';
import * as useCases from '../services/useCases.js';
import { approveRequest, denyRequest, describeRequest, disconnect, listConnections } from '../oauth.js';
import { createAgentToken, createUser, deleteAgentToken, destroySession, getUser, listActivity, listAgentTokens, personas, publicReporter } from '../services/users.js';
import { claimPublicReport, convertPublicReport, dismissPublicReport, getPublicReport, listPublicReports, releasePublicReport, removePublicReport } from '../public/report.js';
import { approveHold, isHeld, listHolds, readOntology } from '../public/holds.js';

const ROLES = Object.keys(ROLE_INFO) as Role[];
const FORMATS = Object.keys(FORMAT_INFO) as OutputFormat[];

const str = (v: unknown, name: string, max = 20000) => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${name} is required`);
  if (v.length > max) throw new HttpError(400, `${name} is too long`);
  return v.trim();
};
const optStr = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function sessionInfo(user?: User): SessionInfo {
  return {
    user,
    providers: providers(),
    llm: { provider: llm.provider, model: llm.model },
    solid: { enabled: !!config.solid.serverUrl, serverUrl: config.solid.serverUrl },
    meetBot: meetBot.meetBotInfo(),
    clockOffsetMs: clock.offsetMs,
    now: clock.iso(),
  };
}

const demoOnly = () => {
  if (!config.demoMode) throw new HttpError(403, 'Only available in demo mode');
};

/** Terms that refer to a given IRI (superclass, restriction, domain, range, type). */
function usedBy(all: TermView[], iri: string, c: (i: string) => string) {
  const out: { iri: string; label?: string; via: string }[] = [];
  for (const t of all) {
    if (t.iri === iri) continue;
    if (t.kind === 'class') {
      if (t.superClasses.includes(iri)) out.push({ iri: t.iri, label: t.label, via: 'subclass of' });
      if (t.disjointWith.includes(iri)) out.push({ iri: t.iri, label: t.label, via: 'disjoint with' });
      for (const r of t.restrictions) if (r.property === iri || r.filler === iri) out.push({ iri: t.iri, label: t.label, via: `restriction ${c(r.property)} ${r.kind}` });
    } else if (t.kind === 'individual') {
      if (t.types.includes(iri)) out.push({ iri: t.iri, label: t.label, via: 'instance of' });
    } else {
      if (t.domain.includes(iri)) out.push({ iri: t.iri, label: t.label, via: 'domain' });
      if (t.range.includes(iri)) out.push({ iri: t.iri, label: t.label, via: 'range' });
      if (t.superProperties.includes(iri)) out.push({ iri: t.iri, label: t.label, via: 'subproperty of' });
    }
  }
  return out;
}

const project = (req: Request) => mustFindProject(String(req.params.id));

/** GET routes anyone may call without signing in. */
const PUBLIC_READS = [
  /^\/ontologies$/,
  /^\/ontologies\/[^/]+$/,
  // Not validation: it runs the use cases' competency questions over their private example data.
  /^\/ontologies\/[^/]+\/(view|search|source)$/,
  /^\/ontologies\/[^/]+\/terms\/.+$/,
  /^\/governance\/templates$/,
  /^\/feedback\/questions$/,
  /^\/alpha\/me$/,
  /^\/feedback\/publishing$/,
  // Checks the triage routine's own bearer token.
  /^\/feedback\/triage\/queue$/,
  /^\/oauth\/requests\/[^/]+$/,
];

export function apiRouter(): Router {
  const r = Router();
  r.use(express.json({ limit: '5mb' }));

  /* ------------------------------ auth ------------------------------ */
  r.get('/session', (req, res) => res.json(sessionInfo(req.user)));

  r.get('/personas', async (_req, res) => {
    await seedDemo();
    const ps = personas();
    res.json(
      PERSONAS.map((spec) => ({ ...ps.find((u) => u.name === spec.name), roles: spec.roles, playable: spec.playable, key: spec.key })).filter((p) => p.id),
    );
  });

  /**
   * Demo sign-in: either act as a simulated persona (userId), or create your own
   * tester account (name + role) that joins the demo ontology with that role.
   */
  r.post('/auth/demo', async (req, res) => {
    demoOnly();
    const { userId, name, role } = req.body ?? {};
    const testerBefore = testerFor(req);
    let user: User | undefined;
    if (userId) {
      user = getUser(String(userId));
      if (!user?.simulated) throw new HttpError(404, 'No such persona');
    } else {
      const demo = await seedDemo();
      user = await createUser({ name: optStr(name) ?? 'Alpha tester', provider: 'demo', subject: newId('tester') });
      const chosen: Role = ROLES.includes(role) ? role : 'contributor';
      const roles: Role[] =
        chosen === 'steward' ? ['steward', 'editor', 'member'] : chosen === 'editor' ? ['editor', 'reviewer', 'member'] : chosen === 'reviewer' ? ['reviewer', 'member'] : [chosen, ...(chosen === 'contributor' ? [] : (['member'] as Role[]))];
      if (demo) setRoles(demo.id, user.id, [...new Set(roles)]);
    }
    setSessionCookie(res, user.id, 'demo');
    rememberTester(req, res, testerBefore, user);
    res.json(sessionInfo(user));
  });

  r.post('/auth/logout', (req, res) => {
    clearTesterCookie(req, res);
    destroySession(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: '/' }).json({});
  });

  /*
   * Reads below need a signed-in user, except the ontologies themselves (also
   * public at /def/<slug>) and a few public lists. Use cases, interviews,
   * meeting transcripts, change requests, releases, agent reports, activity
   * and feedback can all hold material that isn't public, so an anonymous GET
   * for them gets 401. Writes check the user themselves (a few, like feedback
   * and webhooks, are meant to work without one).
   */
  r.use((req, _res, next) => {
    if (req.user || (req.method !== 'GET' && req.method !== 'HEAD') || PUBLIC_READS.some((re) => re.test(req.path))) return next();
    // Unknown paths still 404 (clients probe for optional features that way).
    const known = (r.stack as unknown as { route?: { methods?: Record<string, boolean> }; match: (path: string) => boolean }[]).some((l) => l.route?.methods?.get && l.match(req.path));
    next(known ? new HttpError(401, 'Sign in first') : undefined);
  });

  /* --------------------------- ontologies --------------------------- */
  /**
   * The summary a caller may see. For someone signed out, whether the working draft is held is decided before it is
   * read: a summary read first and checked after could count a draft that was replaced and approved meanwhile.
   */
  const summaryFor = async (req: Request, p: import('@concord/shared').OntologyProject) => forCaller(req, await summary(p, { withGraph: !!req.user || !isHeld(p, 'draft') }));
  /** Owners and activity counts are for signed-in users: owner ids lead to names, and counts reveal private work. */
  const forCaller = (req: Request, s: OntologySummary) => {
    if (req.user) return s;
    const { useCases: _u, openChangeRequests: _c, members: _m, ...stats } = s.stats;
    // Counted from the working draft: while that waits for approval, nothing about it is public (see readOntology).
    // (summaryFor doesn't read it then; this also covers a hold that began while the summary was being made.)
    if (isHeld(s, 'draft')) {
      const { classes: _cl, properties: _p, individuals: _i, ...rest } = stats;
      return { ...s, ownerIds: [], stats: rest, health: undefined };
    }
    return { ...s, ownerIds: [], stats };
  };

  r.get('/ontologies', async (req, res) => {
    const all = list<import('@concord/shared').OntologyProject>('ontologies');
    res.json(await Promise.all(all.map((p) => summaryFor(req, p))));
  });

  r.post('/ontologies', async (req, res) => {
    const user = requireUser(req);
    const b = req.body ?? {};
    const p = await createProject(
      { title: str(b.title, 'title', 200), description: optStr(b.description) ?? '', prefix: str(b.prefix, 'prefix', 20), namespace: optStr(b.namespace), domain: optStr(b.domain), governanceTemplate: b.governanceTemplate, creditCreator: b.creditCreator === true },
      user,
    );
    // Without its health: validating a new ontology (the OWL reasoner's first run) can take a while, and nothing
    // waits on it here; the ontology's own page asks for it.
    res.status(201).json(await summary(p, { withHealth: false }));
  });

  r.get('/ontologies/:id', async (req, res) => {
    const p = project(req);
    // Who is in the working group, and who made each commit, is for signed-in users.
    const signedIn = !!req.user;
    res.json({ ...(await summaryFor(req, p)), members: signedIn ? membersWithUsers(p.id) : [], versions: ontologyStore.versions(p), history: signedIn ? crs.withRequesters(p.id, ontologyStore.log(p, 30)) : [] });
  });

  r.get('/ontologies/:id/view', async (req, res) => {
    res.json((await readOntology(project(req), optStr(req.query.ref), req.user)).view());
  });

  r.get('/ontologies/:id/terms/:iri', async (req, res) => {
    const p = project(req);
    const g = await readOntology(p, optStr(req.query.ref), req.user);
    const iri = expandIRI(String(req.params.iri), g.prefixes);
    const t = g.term(iri);
    if (!t) throw new HttpError(404, `No term ${req.params.iri}`);
    const v = g.view();
    const all: TermView[] = [...v.classes, ...v.objectProperties, ...v.datatypeProperties, ...v.annotationProperties, ...v.individuals];
    res.json({ ...t, usedBy: usedBy(all, iri, (i) => compactIRI(i, g.prefixes)) });
  });

  r.get('/ontologies/:id/search', async (req, res) => {
    res.json((await readOntology(project(req), 'working', req.user)).search(String(req.query.q ?? ''), 30));
  });

  r.get('/ontologies/:id/source', async (req, res) => {
    const p = project(req);
    const format = (FORMATS.includes(req.query.format as OutputFormat) ? req.query.format : 'turtle') as OutputFormat;
    const ref = optStr(req.query.ref);
    const text = await serialize(await readOntology(p, ref, req.user), format, { name: p.slug });
    const info = FORMAT_INFO[format];
    res.type(`${info.mediaType}; charset=utf-8`);
    if (req.query.download) res.attachment(`${p.slug}-${ref && ref !== 'working' ? ref : 'working'}.${info.extension}`);
    res.send(text);
  });

  r.get('/ontologies/:id/validation', async (req, res) => {
    const p = project(req);
    const ref = optStr(req.query.ref);
    if (!ref || ref === 'working') return void res.json(await workingValidation(p));
    const graph = await ontologyStore.at(p, ref);
    res.json(await validate(graph, { cqs: competencyTests(p.id), reasoner: 'owl', fair: await fairContext(graph.ontologyIRI) }));
  });

  r.post('/ontologies/:id/sparql', async (req, res) => {
    const out = await sparql(project(req), str(req.body?.query, 'query'), optStr(req.body?.ref), req.user);
    if (out.error) throw new HttpError(400, out.error);
    res.json(out);
  });

  /* ------------------------ members & governance --------------------- */
  r.put('/ontologies/:id/members/:userId', (req, res) => {
    const p = project(req);
    requireRole(p.id, req.user, ['owner', 'steward'], 'manage members');
    const roles = (Array.isArray(req.body?.roles) ? req.body.roles : []).filter((x: Role) => ROLES.includes(x)) as Role[];
    if (roles.includes('owner') && !rolesFor(p.id, req.user!.id).includes('owner') && !req.user!.isPlatformAdmin) throw new HttpError(403, 'Only an owner can make someone an owner; use ownership transfer');
    if (!getUser(String(req.params.userId))) throw new HttpError(404, 'No such user');
    res.json(setRoles(p.id, String(req.params.userId), roles));
  });

  r.delete('/ontologies/:id/members/:userId', (req, res) => {
    const p = project(req);
    requireRole(p.id, req.user, ['owner', 'steward'], 'manage members');
    removeMember(p.id, String(req.params.userId));
    res.status(204).end();
  });

  r.get('/governance/templates', (_req, res) => res.json(listTemplates()));

  r.put('/ontologies/:id/governance', async (req, res) => {
    const p = project(req);
    const user = requireUser(req);
    requireRole(p.id, user, ['owner'], 'change the governance policy');
    const policy = req.body?.policy as GovernancePolicy;
    if (!policy?.changes?.major || !policy.releases?.major) throw new HttpError(400, 'policy is incomplete');
    res.json(await summary(setGovernance(p, policy, user)));
  });

  r.post('/ontologies/:id/ownership-transfer', async (req, res) => {
    const p = project(req);
    const user = requireUser(req);
    requireRole(p.id, user, ['owner'], 'transfer ownership');
    const to = getUser(str(req.body?.toUserId, 'toUserId'));
    if (!to) throw new HttpError(404, 'No such user');
    const transfer = p.governance.ownership.transfer;
    if (transfer === 'owner-decides' || user.isPlatformAdmin) {
      const keepGroup = p.governance.ownership.model === 'group';
      p.ownerIds = keepGroup ? [...new Set([...p.ownerIds, to.id])] : [to.id];
      if (!keepGroup) setRoles(p.id, user.id, rolesFor(p.id, user.id).filter((x) => x !== 'owner'));
      setRoles(p.id, to.id, [...rolesFor(p.id, to.id), 'owner']);
      updateProject(p);
      return void res.json({ status: 'transferred' });
    }
    const id = newId('xfer');
    put('kv', { id, kind: 'ownership-transfer', ontologyId: p.id, from: user.id, to: to.id, needs: transfer, at: clock.iso() });
    res.json({ status: transfer === 'member-vote' ? 'vote-opened' : 'awaiting-odi-approval', voteId: id });
  });

  /* ------------------------- use cases & interviews ------------------ */
  r.get('/ontologies/:id/use-cases', (req, res) => res.json(useCases.listUseCases(project(req).id)));
  r.get('/use-cases/:id', (req, res) => res.json(useCases.getUseCase(String(req.params.id))));
  r.patch('/use-cases/:id', (req, res) => {
    const u = useCases.getUseCase(String(req.params.id));
    res.json(useCases.updateUseCase(u, requireUser(req), req.body ?? {}));
  });

  r.post('/ontologies/:id/interviews', async (req, res) => {
    res.status(201).json(await useCases.startInterview(project(req), requireUser(req), optStr(req.body?.useCaseId)));
  });
  r.get('/interviews/:id', (req, res) => {
    const s = useCases.getInterview(String(req.params.id));
    if (s.userId !== req.user?.id) throw new HttpError(403, 'Interviews are private to the person interviewed');
    res.json({ ...s, useCase: useCases.getUseCase(s.useCaseId) });
  });
  r.post('/interviews/:id/messages', async (req, res) => {
    const s = useCases.getInterview(String(req.params.id));
    res.json(await useCases.interviewTurn(s, requireUser(req), str(req.body?.content, 'content', 8000)));
  });
  r.post('/interviews/:id/finish', async (req, res) => {
    res.json(await useCases.finishInterview(useCases.getInterview(String(req.params.id)), requireUser(req)));
  });
  r.post('/ontologies/:id/synthesise', async (req, res) => {
    const p = project(req);
    const user = requireUser(req);
    const cr = await useCases.synthesise(p, user, Array.isArray(req.body?.useCaseIds) ? req.body.useCaseIds : undefined);
    res.status(201).json(crs.detail(cr));
  });

  /* ------------------------------ meetings --------------------------- */
  // Meetings are for signed-in people; pending invites, Meet links and organisers for facilitators only.
  r.get('/ontologies/:id/meetings', (req, res) => {
    if (!req.user) return void res.json([]);
    res.json(meetings.listMeetings(project(req).id).flatMap((m) => meetings.visibleMeeting(m, req.user) ?? []));
  });
  r.post('/ontologies/:id/meetings/upload', async (req, res) => {
    res.status(201).json(await meetings.uploadTranscript(project(req), requireUser(req), optStr(req.body?.title) ?? 'Uploaded call', str(req.body?.transcript, 'transcript', 2_000_000)));
  });
  r.post('/ontologies/:id/meetings/bot', async (req, res) => {
    requireRole(project(req).id, requireUser(req), meetings.FACILITATOR_ROLES, 'send the co-lead bot into a call');
    res
      .status(201)
      .json(
        await meetings.inviteBot(project(req), requireUser(req), optStr(req.body?.title) ?? 'Working group call', str(req.body?.meetingUrl, 'meetingUrl', 300), {
          postPromptsToChat: req.body?.postPromptsToChat === true,
        }),
      );
  });
  r.post('/ontologies/:id/meetings/calendar', async (req, res) => {
    requireRole(project(req).id, requireUser(req), meetings.FACILITATOR_ROLES, 'schedule the co-lead bot');
    res.status(201).json(await meetBot.scheduleFromInvite(project(req), requireUser(req), str(req.body?.ics, 'ics', 2_000_000), { postPromptsToChat: req.body?.postPromptsToChat === true }));
  });
  r.get('/meet-bot', (_req, res) => res.json(meetBot.meetBotInfo()));
  r.post('/meet-bot/sync', async (req, res) => {
    const user = requireUser(req);
    const anywhere = user.isPlatformAdmin || list<{ ontologyId: string; userId: string; roles: Role[] }>('memberships').some((ms) => ms.userId === user.id && ms.roles.some((x) => meetings.FACILITATOR_ROLES.includes(x)));
    if (!anywhere) throw new HttpError(403, 'Only owners, stewards and editors can re-read the bot’s calendar');
    await meetBot.syncCalendar();
    await meetBot.dispatchDue();
    res.json(meetBot.meetBotInfo());
  });
  r.post('/ontologies/:id/meetings/simulate', async (req, res) => {
    const delay = Number(req.query.delayMs ?? req.body?.delayMs);
    res.status(201).json(
      await meetings.simulateCall(project(req), requireUser(req), optStr(req.body?.title) ?? '', {
        ...(Number.isFinite(delay) ? { delayMs: delay } : {}),
        postPromptsToChat: req.body?.postPromptsToChat === true,
      }),
    );
  });
  const visible = (req: Request) => {
    const user = requireUser(req);
    const m = meetings.visibleMeeting(meetings.getMeeting(String(req.params.id)), user);
    if (!m) throw new HttpError(404, 'No such meeting');
    return m;
  };
  r.get('/meetings/:id', (req, res) => res.json(visible(req)));
  r.patch('/meetings/:id', async (req, res) => {
    const b = req.body ?? {};
    const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    res.json(await meetings.updateMeeting(String(req.params.id), requireUser(req), { postPromptsToChat: bool(b.postPromptsToChat), skip: bool(b.skip), approve: bool(b.approve) }));
  });
  r.post('/meetings/:id/bot/dismiss', async (req, res) => {
    res.json(await meetings.dismissBooking(String(req.params.id), requireUser(req)));
  });
  r.post('/meetings/:id/prompts/:index/post', async (req, res) => {
    const m = meetings.getMeeting(String(req.params.id));
    meetings.requireFacilitator(m, requireUser(req), 'post in the call’s chat');
    res.json(await meetings.postPrompt(m.id, Number(req.params.index)));
  });
  r.post('/meetings/:id/analyse', async (req, res) => {
    const m = meetings.getMeeting(String(req.params.id));
    meetings.requireAnalyst(m, requireUser(req));
    res.json(await meetings.analyseMeeting(m));
  });
  r.post('/meetings/:id/end', async (req, res) => {
    const m = meetings.getMeeting(String(req.params.id));
    meetings.requireFacilitator(m, requireUser(req), 'end this call');
    meetings.stopSimulation(m.id);
    res.json(await meetings.endLiveMeeting(m.id));
  });
  r.post('/meetings/:id/propose', async (req, res) => {
    const user = requireUser(req);
    const m = meetings.getMeeting(String(req.params.id));
    if (!meetings.visibleMeeting(m, user)) throw new HttpError(404, 'No such meeting');
    // Analysing first is only for those who may analyse it.
    if (!m.analysis) meetings.requireAnalyst(m, user);
    const out = await meetings.proposeFromMeeting(m, user);
    res.json({ useCases: out.useCases, changeRequest: out.changeRequest ? crs.detail(out.changeRequest) : undefined });
  });
  r.get('/meetings/:id/stream', (req, res) => {
    const user = requireUser(req);
    const m = visible(req);
    const show = (x: Meeting) => meetings.visibleMeeting(x, user);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    send('meeting', { type: 'meeting', meeting: m });
    const onEvent = (e: { type: string } & Record<string, unknown>) => {
      if (e.type === 'status') send('status', { type: 'status', status: e.status, meeting: show(meetings.getMeeting(m.id)) });
      else if (e.type === 'meeting') {
        const x = show(e.meeting as Meeting);
        if (x) send('meeting', { type: 'meeting', meeting: x });
      } else send(e.type, e);
    };
    meetings.meetingEvents.on(m.id, onEvent);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      meetings.meetingEvents.off(m.id, onEvent);
    });
  });
  r.post('/webhooks/recall', async (req, res) => {
    await meetings.recallWebhook(String(req.query.meeting), String(req.query.secret), req.body);
    res.json({ ok: true });
  });

  /* ------------------- reports from the public page ------------------ */
  // Held for review: only editors, stewards and owners see them, and nothing happens until one of them acts.
  const moderator = (req: Request) => {
    const p = project(req);
    const user = requireUser(req);
    requireRole(p.id, user, ['editor', 'steward', 'owner'], 'review reports from the public page');
    return { p, user };
  };
  r.get('/ontologies/:id/public-reports', (req, res) => {
    res.json(listPublicReports(moderator(req).p.id));
  });
  r.post('/ontologies/:id/public-reports/:reportId/accept', async (req, res) => {
    const { p, user } = moderator(req);
    const reportId = String(req.params.reportId);
    const opened = () => crs.listCRs(p.id).find((c) => c.origin.type === 'public-report' && c.origin.reportId === reportId);
    const already = opened();
    if (already) {
      removePublicReport(reportId);
      return void res.json(crs.detail(already));
    }
    if (!getPublicReport(p.id, reportId)) throw new HttpError(404, 'That report has already been reviewed');
    const mine = claimPublicReport(p.id, reportId);
    if (!mine) throw new HttpError(409, 'Someone is opening this report right now');
    const report = mine.report;
    let cr;
    try {
      cr = await crs.createChangeRequest(p, await publicReporter(), {
        title: report.title || `Problem with ${report.termName}`,
        description: `${report.description}\n\nTerm: <${report.termIri}>\n\nReported by a member of the public from the public page (${report.version === 'draft' ? 'working draft' : `version ${report.version}`}) and opened for discussion by ${user.name}. No edits were drafted from it.`,
        kind: 'bug',
        origin: { type: 'public-report', termIri: report.termIri, version: report.version, reportId },
        ops: [],
        // Saved only if this claim still holds the report, and the report leaves the queue in the same step.
        atSave: () => convertPublicReport(mine),
      });
    } catch (err) {
      releasePublicReport(mine);
      throw err;
    }
    res.status(201).json(crs.detail(cr));
  });
  r.post('/ontologies/:id/public-reports/:reportId/dismiss', (req, res) => {
    const { p } = moderator(req);
    dismissPublicReport(p.id, String(req.params.reportId));
    res.json({ ok: true });
  });

  /* --------------- versions waiting for publication approval ------------- */
  // Published before anyone approved what goes public: owners and stewards review each and approve exactly what it publishes.
  const steward = (req: Request) => {
    const p = project(req);
    const user = requireUser(req);
    requireRole(p.id, user, ['owner', 'steward'], 'review versions waiting for approval');
    return { p, user };
  };
  r.get('/ontologies/:id/public-holds', async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await listHolds(steward(req).p));
  });

  r.post('/ontologies/:id/public-holds/:version/approve', (req, res) => {
    const { p, user } = steward(req);
    approveHold(p, user, String(req.params.version), req.body?.fingerprint);
    res.json({ ok: true });
  });

  /* ---------------------------- change requests ---------------------- */
  r.get('/ontologies/:id/change-requests', (req, res) => {
    const status = optStr(req.query.status);
    res.json(crs.listCRs(project(req).id).filter((c) => !status || c.status === status));
  });

  // A request drafted from use cases is published only as an editor approved it: what it would publish, then the approval of exactly that.
  r.get('/change-requests/:id/publication', async (req, res) => {
    requireUser(req);
    const cr = crs.getCR(String(req.params.id));
    if (!crs.needsPublicationApproval(cr)) throw new HttpError(404, 'This request doesn’t need its publication approved');
    res.set('Cache-Control', 'no-store').json(await crs.publicationPreview(cr));
  });
  r.post('/change-requests/:id/approve-publication', async (req, res) => {
    const cr = await crs.approvePublication(crs.getCR(String(req.params.id)), requireUser(req), req.body?.fingerprint);
    res.json(crs.detail(cr));
  });

  r.post('/ontologies/:id/change-requests', async (req, res) => {
    const p = project(req);
    const user = requireUser(req);
    const b = req.body ?? {};
    const kind: ChangeRequestKind = ['feature', 'bug', 'gap', 'editorial', 'deprecation'].includes(b.kind) ? b.kind : 'feature';
    if (!rolesFor(p.id, user.id).length) setRoles(p.id, user.id, ['contributor']);
    const cr = await crs.createChangeRequest(p, user, {
      title: optStr(b.title) ?? '',
      description: optStr(b.description) ?? '',
      kind,
      origin: { type: 'direct' },
      ops: Array.isArray(b.ops) ? b.ops : undefined,
      naturalLanguage: Array.isArray(b.ops) ? undefined : (optStr(b.naturalLanguage) ?? [optStr(b.title), optStr(b.description)].filter(Boolean).join('\n\n')),
      submit: !!b.submit,
    });
    res.status(201).json(crs.detail(cr));
  });

  r.post('/ontologies/:id/bug-reports', async (req, res) => {
    const p = project(req);
    const user = requireUser(req);
    if (!rolesFor(p.id, user.id).length) setRoles(p.id, user.id, ['contributor']);
    const title = str(req.body?.title, 'title', 300);
    const description = optStr(req.body?.description) ?? '';
    const termIri = optStr(req.body?.termIri);
    const cr = await crs.createChangeRequest(p, user, {
      title,
      description: termIri ? `${description}\n\nTerm: <${termIri}>` : description,
      kind: 'bug',
      origin: { type: 'bug-report' },
      naturalLanguage: `Bug report${termIri ? ` about <${termIri}>` : ''}: ${title}\n\n${description}`,
    });
    res.status(201).json(crs.detail(cr));
  });

  r.post('/ontologies/:id/term-edits', async (req, res) => {
    const cr = await proposeTermEdit(project(req), requireUser(req), req.body ?? {});
    res.status(201).json(crs.detail(cr));
  });

  const cr = (req: Request) => crs.getCR(String(req.params.id));
  r.get('/change-requests/:id', (req, res) => res.json(crs.detail(cr(req))));
  r.patch('/change-requests/:id', async (req, res) => res.json(crs.detail(await crs.updateOps(cr(req), requireUser(req), req.body ?? {}))));
  r.post('/change-requests/:id/submit', async (req, res) => res.json(crs.detail(await crs.submit(cr(req), requireUser(req)))));
  r.post('/change-requests/:id/reviews', async (req, res) => {
    const decision = req.body?.decision;
    if (!['approve', 'request-changes', 'object', 'comment'].includes(decision)) throw new HttpError(400, 'decision must be approve, request-changes, object or comment');
    res.json(crs.detail(await crs.addReview(cr(req), requireUser(req), decision, optStr(req.body?.comment))));
  });
  r.post('/change-requests/:id/votes', async (req, res) => {
    const choice = req.body?.choice;
    if (!['yes', 'no', 'abstain'].includes(choice)) throw new HttpError(400, 'choice must be yes, no or abstain');
    res.json(crs.detail(await crs.addVote(cr(req), requireUser(req), choice, optStr(req.body?.comment))));
  });
  r.post('/change-requests/:id/merge', async (req, res) => res.json(crs.detail(await crs.merge(cr(req), requireUser(req)))));
  r.post('/change-requests/:id/withdraw', async (req, res) => res.json(crs.detail(await crs.withdraw(cr(req), requireUser(req)))));
  r.post('/change-requests/:id/revise', async (req, res) => res.json(crs.detail(await crs.revise(cr(req), requireUser(req), str(req.body?.instruction, 'instruction', 4000)))));
  r.post('/change-requests/:id/retriage', async (req, res) => {
    const user = requireUser(req);
    res.json(crs.detail(await withTriageBudget(user, async () => crs.advance(await crs.triage(cr(req))))));
  });

  /* ------------------------------ releases --------------------------- */
  r.get('/ontologies/:id/releases', (req, res) => res.json(releases.listReleases(project(req).id)));
  r.post('/ontologies/:id/releases', async (req, res) => {
    res.status(201).json(releases.releaseDetail(await releases.draftRelease(project(req), requireUser(req), optStr(req.body?.notes))));
  });
  r.get('/releases/:id', (req, res) => res.json(releases.releaseDetail(releases.getRelease(String(req.params.id)))));
  r.post('/releases/:id/votes', async (req, res) => {
    const choice = req.body?.choice;
    if (!['yes', 'no', 'abstain'].includes(choice)) throw new HttpError(400, 'choice must be yes, no or abstain');
    res.json(releases.releaseDetail(await releases.voteOnRelease(releases.getRelease(String(req.params.id)), requireUser(req), choice, optStr(req.body?.comment))));
  });
  r.post('/releases/:id/publish', async (req, res) => {
    res.json(releases.releaseDetail(await releases.publishRelease(releases.getRelease(String(req.params.id)), requireUser(req))));
  });

  /* ------------------------------- agents ---------------------------- */
  /* ----------------------- OAuth for MCP clients ----------------------- */
  // The consent page: an MCP client sent the person here to approve the connection.
  r.get('/oauth/requests/:id', async (req, res) => res.json(await describeRequest(String(req.params.id))));
  r.post('/oauth/requests/:id/approve', (req, res) => {
    // A JSON body forces a CORS preflight, so another site can't approve on someone's behalf with a form post.
    if (!req.is('application/json')) throw new HttpError(415, 'Send JSON');
    res.json(approveRequest(String(req.params.id), requireUser(req)));
  });
  r.post('/oauth/requests/:id/deny', (req, res) => res.json(denyRequest(String(req.params.id))));
  r.get('/oauth/connections', (req, res) => res.json(listConnections(requireUser(req).id)));
  r.delete('/oauth/connections/:id', (req, res) => {
    disconnect(requireUser(req).id, String(req.params.id));
    res.status(204).end();
  });

  r.get('/agent-tokens', (req, res) => res.json(listAgentTokens(requireUser(req).id)));
  r.post('/agent-tokens', (req, res) => res.status(201).json(createAgentToken(requireUser(req).id, optStr(req.body?.name) ?? 'My agent')));
  r.delete('/agent-tokens/:id', (req, res) => {
    deleteAgentToken(requireUser(req).id, String(req.params.id));
    res.status(204).end();
  });
  r.get('/ontologies/:id/agent-reports', (req, res) => res.json(listAgentReports(project(req).id)));
  r.get('/agent-reports/:id', (req, res) => res.json(getAgentReport(String(req.params.id))));
  r.post('/ontologies/:id/agent-reports', async (req, res) => {
    const b = req.body ?? {};
    const kind = ['missing-concept', 'does-not-fit', 'bug', 'question'].includes(b.kind) ? b.kind : 'missing-concept';
    res.status(201).json(
      await reportGap(project(req), requireUser(req), { agentName: optStr(b.agentName) ?? 'Web form', kind, summary: str(b.summary, 'summary', 300), details: optStr(b.details) ?? '', context: optStr(b.context) }),
    );
  });

  /* ------------------------------ simulation ------------------------- */
  r.post('/simulation/step', async (req, res) => {
    demoOnly();
    // It acts as simulated members and returns their activity, so only for signed-in testers.
    requireUser(req);
    const id = optStr(req.body?.ontologyId) ?? DEMO_SLUG;
    res.json({ events: await step(mustFindProject(id).id, req.user?.id) });
  });
  r.post('/simulation/clock', async (req, res) => {
    demoOnly();
    requireUser(req);
    const days = Number(req.body?.advanceDays);
    if (!Number.isFinite(days) || days <= 0 || days > 60) throw new HttpError(400, 'advanceDays must be between 0 and 60');
    await advanceClock(days);
    res.json(sessionInfo(req.user));
  });
  r.post('/simulation/reset', async (req, res) => {
    demoOnly();
    if (!req.user?.isPlatformAdmin && !['1', 'true'].includes(process.env.ALLOW_PUBLIC_RESET ?? '')) throw new HttpError(403, 'Only an administrator can reset the shared demo');
    await resetAll();
    res.clearCookie(SESSION_COOKIE, { path: '/' }).json({});
  });

  /* ------------------------------ activity --------------------------- */
  r.get('/activity', (req, res) => {
    const id = optStr(req.query.ontologyId);
    const all = listActivity(id ? mustFindProject(id).id : undefined, 100);
    // Meetings are for signed-in people, and so is what happens to them; a call waiting for
    // approval (and what's been said about it) is for facilitators only.
    const hidden = (a: (typeof all)[number]) => {
      if (!a.type.startsWith('meeting.')) return false;
      if (!req.user) return true;
      const mid = /\/meetings\/(mtg_[\w-]+)/.exec(a.link ?? '')?.[1];
      const m = mid ? get<Meeting>('meetings', mid) : undefined;
      if (m) return !meetings.visibleMeeting(m, req.user);
      // A call that's gone (withdrawn, perhaps while it waited for approval): only facilitators see what happened to it.
      return !!mid && !meetings.canFacilitate({ ontologyId: a.ontologyId ?? '' }, req.user);
    };
    res.json(all.filter((a) => !hidden(a)));
  });

  /* ------------------------------ feedback --------------------------- */
  const pathwayOf = (p: unknown): Pathway => (p === 'general' || p === 'changes' ? p : 'structured');
  r.get('/feedback/questions', (req, res) =>
    res.json(questionsFor({ pathway: pathwayOf(req.query.pathway), since: optStr(req.query.since), role: optStr(req.query.role), version: optStr(req.query.version) })),
  );
  r.post('/feedback/chat', async (req, res) => {
    const b = req.body ?? {};
    res.json(
      await feedbackChat({
        pathway: pathwayOf(b.pathway),
        messages: Array.isArray(b.messages) ? b.messages.slice(-60) : [],
        answers: b.answers ?? {},
        currentQuestionId: optStr(b.currentQuestionId),
        since: optStr(b.since),
        role: optStr(b.role),
        version: optStr(b.version),
      }),
    );
  });
  r.get('/feedback/publishing', (_req, res) => res.json({ enabled: issuesEnabled(), noticeVersion: PUBLIC_NOTICE_VERSION }));
  r.post('/feedback', async (req, res) => {
    const b = req.body ?? {};
    // An opt-in public summary is checked before anything is stored, so the tester can fix it.
    const summary: string | undefined = b.publish && typeof b.publish === 'object' ? b.publish.summary : undefined;
    if (b.publish) checkPublicSummary(summary);
    const sub = await submitFeedback(
      req.user,
      {
        pathway: pathwayOf(b.pathway),
        answers: b.answers ?? {},
        transcript: Array.isArray(b.transcript) ? b.transcript.slice(-200) : [],
        usedVoice: !!b.usedVoice,
        name: optStr(b.name),
        email: optStr(b.email),
        role: optStr(b.role),
        themes: Array.isArray(b.themes) ? b.themes.filter((t: unknown) => typeof t === 'string').slice(0, 20) : undefined,
        appVersion: optStr(b.appVersion),
        appCommit: optStr(b.appCommit),
        sinceVersion: optStr(b.sinceVersion),
      },
      testerForSaving(req, res),
    );
    if (summary === undefined) return void res.status(201).json(sub);
    // Posted as a GitHub issue; the tester is told the number if GitHub answers quickly.
    const { withdrawToken } = queuePublication(sub.id, summary);
    await processWithin(sub.id);
    res.status(201).json({ ...sub, publication: { ...status(publicationFor(sub.id)!), withdrawToken } });
  });
  r.post('/feedback/:id/publication/withdraw', async (req, res) => {
    res.json(await withdrawPublication(String(req.params.id), req.body?.token));
  });
  r.post('/feedback/:id/publication/resolve', async (req, res) => {
    feedbackAdmin(req);
    const { action, issue, comment, ref } = req.body ?? {};
    if (typeof ref !== 'string' || !ref) throw new HttpError(400, 'ref (from the list of summaries waiting for you) is required');
    let a: AdminAction;
    if (action === 'adopt') {
      if (!Number.isSafeInteger(issue) || issue <= 0) throw new HttpError(400, 'issue must be an issue number');
      a = { action, issue };
    } else if (action === 'comment') {
      if (!Number.isSafeInteger(comment) || comment <= 0) throw new HttpError(400, 'comment must be a comment id');
      a = { action, comment };
    } else if (action === 'check' || action === 'repost' || action === 'confirm') a = { action };
    else throw new HttpError(400, 'action must be check, adopt, repost, confirm or comment');
    res.json(await resolvePublication(String(req.params.id), a, ref));
  });
  // Public summaries waiting for an administrator, listed apart from feedback (whose row may be deleted).
  r.get('/feedback/publications/attention', (req, res) => {
    feedbackAdmin(req);
    res.json(publicationsNeedingAdmin());
  });
  // The hourly triage routine: reads its queue and writes only through these, with its own token.
  const triageAuth = (req: Request) => {
    if (!triageEnabled()) throw new HttpError(404, 'Triage is not switched on');
    if (!triageTokenMatches(req.header('authorization'))) throw new HttpError(401, 'Triage token required');
  };
  r.get('/feedback/triage/queue', (req, res) => {
    triageAuth(req);
    res.json(triageQueue());
  });
  r.post('/feedback/triage/:issue', async (req, res) => {
    triageAuth(req);
    const n = Number(req.params.issue);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Not an issue number');
    res.json(await triagePublication(n, req.body ?? {}));
  });

  /* ------------------------------ alpha testing ------------------------ */
  r.get('/alpha/me', async (req, res) => res.json(await alphaMe(req)));
  r.post('/alpha/visit', async (req, res) => {
    const tester = testerForSaving(req, res);
    if (!tester) throw new HttpError(401, 'Sign in to save the version you tested');
    const b = req.body ?? {};
    res.json(await recordVersion(tester, { version: b.version, commit: b.commit, role: b.role }));
  });
  const feedbackAdmin = (req: Request) => {
    // Only deployment administrators (ADMIN_WEBIDS or ADMIN_EMAILS, in a session signed in with Google or GitHub). Ontology roles
    // don't count: in demo mode anyone can give themselves one, or play a persona who has one.
    const user = requireUser(req);
    if (!user.isPlatformAdmin || user.simulated) throw new HttpError(403, 'Only administrators of this deployment can read feedback');
  };
  r.get('/feedback', (req, res) => {
    feedbackAdmin(req);
    res.json(
      listFeedback().map((s) => {
        const pub = publicationFor(s.id);
        return pub ? { ...s, publication: { ...status(pub), id: pub.id, summary: pub.summary, adminNeeded: pub.adminNeeded } } : s;
      }),
    );
  });
  r.get('/feedback/summary', async (req, res) => {
    feedbackAdmin(req);
    res.json(await summariseFeedback());
  });
  r.post('/transcribe', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Send audio as the request body');
    res.json({ text: await transcribe(req.body, req.header('content-type') ?? 'audio/webm') });
  });

  /* ------------------------------- profile --------------------------- */
  r.get('/me/storage', async (req, res) => {
    const user = requireUser(req);
    res.json({ webId: user.webId, podUrl: user.podUrl, solid: !!config.solid.serverUrl });
  });

  return r;
}
