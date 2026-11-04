import express, { Router, type Request } from 'express';
import { compactIRI, expandIRI, FORMAT_INFO, serialize, validate } from '@concord/core';
import type { OutputFormat, TermView } from '@concord/core/types';
import type { ChangeRequestKind, GovernancePolicy, Meeting, Role, SessionInfo, User } from '@concord/shared';
import { ROLE_INFO } from '@concord/shared';
import { providers, requireUser, SESSION_COOKIE, setSessionCookie } from '../auth.js';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { HttpError, list, put } from '../db.js';
import { newId } from '../ids.js';
import { llm } from '../llm/provider.js';
import { getAgentReport, listAgentReports, reportGap, sparql } from '../services/agents.js';
import * as crs from '../services/changeRequests.js';
import { feedbackChat, FEEDBACK_QUESTIONS, listFeedback, submitFeedback, summariseFeedback, transcribe } from '../services/feedback.js';
import { listTemplates } from '../services/governance.js';
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
import { advanceClock, DEMO_SLUG, resetAll, seedDemo, step } from '../services/simulation.js';
import * as useCases from '../services/useCases.js';
import { approveRequest, denyRequest, describeRequest, disconnect, listConnections } from '../oauth.js';
import { createAgentToken, createUser, deleteAgentToken, destroySession, getUser, listActivity, listAgentTokens, personas } from '../services/users.js';

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
    meetBot: { provider: config.meetBot.recallApiKey ? 'recall' : 'simulated' },
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
    setSessionCookie(res, user.id);
    res.json(sessionInfo(user));
  });

  r.post('/auth/logout', (req, res) => {
    destroySession(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: '/' }).json({});
  });

  /* --------------------------- ontologies --------------------------- */
  r.get('/ontologies', async (_req, res) => {
    const all = list<import('@concord/shared').OntologyProject>('ontologies');
    res.json(await Promise.all(all.map((p) => summary(p))));
  });

  r.post('/ontologies', async (req, res) => {
    const user = requireUser(req);
    const b = req.body ?? {};
    const p = await createProject(
      { title: str(b.title, 'title', 200), description: optStr(b.description) ?? '', prefix: str(b.prefix, 'prefix', 20), namespace: optStr(b.namespace), domain: optStr(b.domain), governanceTemplate: b.governanceTemplate },
      user,
    );
    res.status(201).json(await summary(p));
  });

  r.get('/ontologies/:id', async (req, res) => {
    const p = project(req);
    res.json({ ...(await summary(p)), members: membersWithUsers(p.id), versions: ontologyStore.versions(p), history: ontologyStore.log(p, 30) });
  });

  r.get('/ontologies/:id/view', async (req, res) => {
    res.json((await ontologyStore.at(project(req), optStr(req.query.ref))).view());
  });

  r.get('/ontologies/:id/terms/:iri', async (req, res) => {
    const p = project(req);
    const g = await ontologyStore.at(p, optStr(req.query.ref));
    const iri = expandIRI(String(req.params.iri), g.prefixes);
    const t = g.term(iri);
    if (!t) throw new HttpError(404, `No term ${req.params.iri}`);
    const v = g.view();
    const all: TermView[] = [...v.classes, ...v.objectProperties, ...v.datatypeProperties, ...v.annotationProperties, ...v.individuals];
    res.json({ ...t, usedBy: usedBy(all, iri, (i) => compactIRI(i, g.prefixes)) });
  });

  r.get('/ontologies/:id/search', async (req, res) => {
    res.json((await ontologyStore.working(project(req))).search(String(req.query.q ?? ''), 30));
  });

  r.get('/ontologies/:id/source', async (req, res) => {
    const p = project(req);
    const format = (FORMATS.includes(req.query.format as OutputFormat) ? req.query.format : 'turtle') as OutputFormat;
    const ref = optStr(req.query.ref);
    const text = await serialize(await ontologyStore.at(p, ref), format);
    const info = FORMAT_INFO[format];
    res.type(`${info.mediaType}; charset=utf-8`);
    if (req.query.download) res.attachment(`${p.slug}-${ref && ref !== 'working' ? ref : 'working'}.${info.extension}`);
    res.send(text);
  });

  r.get('/ontologies/:id/validation', async (req, res) => {
    const p = project(req);
    const ref = optStr(req.query.ref);
    if (!ref || ref === 'working') return void res.json(await workingValidation(p));
    res.json(await validate(await ontologyStore.at(p, ref), { cqs: competencyTests(p.id), reasoner: 'owl' }));
  });

  r.post('/ontologies/:id/sparql', async (req, res) => {
    const out = await sparql(project(req), str(req.body?.query, 'query'), optStr(req.body?.ref));
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
  r.get('/ontologies/:id/meetings', (req, res) => res.json(meetings.listMeetings(project(req).id)));
  r.post('/ontologies/:id/meetings/upload', async (req, res) => {
    res.status(201).json(await meetings.uploadTranscript(project(req), requireUser(req), optStr(req.body?.title) ?? 'Uploaded call', str(req.body?.transcript, 'transcript', 2_000_000)));
  });
  r.post('/ontologies/:id/meetings/bot', async (req, res) => {
    res.status(201).json(await meetings.inviteBot(project(req), requireUser(req), optStr(req.body?.title) ?? 'Working group call', str(req.body?.meetingUrl, 'meetingUrl', 300)));
  });
  r.post('/ontologies/:id/meetings/simulate', async (req, res) => {
    const delay = Number(req.query.delayMs ?? req.body?.delayMs);
    res.status(201).json(await meetings.simulateCall(project(req), requireUser(req), optStr(req.body?.title) ?? '', Number.isFinite(delay) ? { delayMs: delay } : {}));
  });
  r.get('/meetings/:id', (req, res) => res.json(meetings.getMeeting(String(req.params.id))));
  r.post('/meetings/:id/analyse', async (req, res) => {
    requireUser(req);
    res.json(await meetings.analyseMeeting(meetings.getMeeting(String(req.params.id))));
  });
  r.post('/meetings/:id/end', async (req, res) => {
    requireUser(req);
    const m = meetings.getMeeting(String(req.params.id));
    meetings.stopSimulation(m.id);
    res.json(await meetings.endLiveMeeting(m));
  });
  r.post('/meetings/:id/propose', async (req, res) => {
    const out = await meetings.proposeFromMeeting(meetings.getMeeting(String(req.params.id)), requireUser(req));
    res.json({ useCases: out.useCases, changeRequest: out.changeRequest ? crs.detail(out.changeRequest) : undefined });
  });
  r.get('/meetings/:id/stream', (req, res) => {
    const m = meetings.getMeeting(String(req.params.id));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    send('meeting', { type: 'meeting', meeting: m });
    const onEvent = (e: { type: string } & Record<string, unknown>) => {
      if (e.type === 'prompt') send('prompt', { type: 'prompt', prompt: { at: clock.iso(), t: e.t, text: e.text, posted: false } });
      else if (e.type === 'status') send('status', { type: 'status', status: e.status, meeting: meetings.getMeeting(m.id) as Meeting });
      else send(e.type, e);
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

  /* ---------------------------- change requests ---------------------- */
  r.get('/ontologies/:id/change-requests', (req, res) => {
    const status = optStr(req.query.status);
    res.json(crs.listCRs(project(req).id).filter((c) => !status || c.status === status));
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
    requireUser(req);
    res.json(crs.detail(await crs.advance(await crs.triage(cr(req)))));
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
    const id = optStr(req.body?.ontologyId) ?? DEMO_SLUG;
    res.json({ events: await step(mustFindProject(id).id, req.user?.id) });
  });
  r.post('/simulation/clock', async (req, res) => {
    demoOnly();
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
    res.json(listActivity(id ? mustFindProject(id).id : undefined, 100));
  });

  /* ------------------------------ feedback --------------------------- */
  r.get('/feedback/questions', (_req, res) => res.json(FEEDBACK_QUESTIONS));
  r.post('/feedback/chat', async (req, res) => {
    const b = req.body ?? {};
    res.json(await feedbackChat({ pathway: b.pathway === 'general' ? 'general' : 'structured', messages: Array.isArray(b.messages) ? b.messages.slice(-60) : [], answers: b.answers ?? {}, currentQuestionId: optStr(b.currentQuestionId) }));
  });
  r.post('/feedback', async (req, res) => {
    const b = req.body ?? {};
    res.status(201).json(
      await submitFeedback(req.user, {
        pathway: b.pathway === 'general' ? 'general' : 'structured',
        answers: b.answers ?? {},
        transcript: Array.isArray(b.transcript) ? b.transcript.slice(-200) : [],
        usedVoice: !!b.usedVoice,
        name: optStr(b.name),
        email: optStr(b.email),
        role: optStr(b.role),
        themes: Array.isArray(b.themes) ? b.themes : undefined,
      }),
    );
  });
  const feedbackAdmin = (req: Request) => {
    const user = requireUser(req);
    const odi = list<import('@concord/shared').Membership>('memberships').some((m) => m.userId === user.id && (m.roles.includes('odi') || m.roles.includes('owner')));
    if (!user.isPlatformAdmin && !odi) throw new HttpError(403, 'Only ODI staff and ontology owners can read feedback');
  };
  r.get('/feedback', (req, res) => {
    feedbackAdmin(req);
    res.json(listFeedback());
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
