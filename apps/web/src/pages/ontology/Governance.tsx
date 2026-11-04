import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApprovalRule, ChangeLevel, GovernancePolicy, Role } from '@concord/shared';
import { ROLE_INFO } from '@concord/shared';
import { ChevronDown, ChevronRight, Crown, Save, UserPlus, Users, Scale, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { pct, plural, roleLabel } from '../../lib/format';
import { LevelBadge, RoleChips } from '../../components/badges';
import { CollapsibleCard, Disclosure } from '../../components/Disclosure';
import { Avatar, Badge, Button, Card, CardHeader, Chip, ErrorCard, InlineError, Input, Loading, Select, Toggle, cx } from '../../components/ui';
import { useOntology } from './Layout';

const LEVELS: ChangeLevel[] = ['patch', 'minor', 'major'];
const ALL_ROLES = Object.keys(ROLE_INFO) as Role[];

function RolePicker({ value, onChange, disabled }: { value: Role[]; onChange: (r: Role[]) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1">
      {ALL_ROLES.filter((r) => r !== 'agent').map((r) => (
        <Chip key={r} active={value.includes(r)} disabled={disabled} onClick={() => onChange(value.includes(r) ? value.filter((x) => x !== r) : [...value, r])}>
          {roleLabel(r)}
        </Chip>
      ))}
    </div>
  );
}

function NumberInput({ value, onChange, min = 0, max, step = 1, suffix, disabled }: { value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; suffix?: string; disabled?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input type="number" style={{ width: 84 }} value={Number.isFinite(value) ? value : 0} min={min} max={max} step={step} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      {suffix && <span className="text-xs text-muted">{suffix}</span>}
    </span>
  );
}

function RulesTable({ rules, onChange, disabled }: { rules: Record<ChangeLevel, ApprovalRule>; onChange: (r: Record<ChangeLevel, ApprovalRule>) => void; disabled?: boolean }) {
  const set = (level: ChangeLevel, patch: Partial<ApprovalRule>) => onChange({ ...rules, [level]: { ...rules[level], ...patch } });
  const setVote = (level: ChangeLevel, patch: Partial<NonNullable<ApprovalRule['vote']>>) => {
    const v = rules[level].vote ?? { voterRoles: ['member'], quorum: 0.5, threshold: 0.66, durationDays: 7 };
    set(level, { vote: { ...v, ...patch } });
  };
  const row = (title: string, hint: string, cell: (l: ChangeLevel, r: ApprovalRule) => ReactNode) => (
    <tr className="border-t border-line align-top">
      <th className="w-48 py-3 pr-4 text-left font-normal">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted">{hint}</div>
      </th>
      {LEVELS.map((l) => (
        <td key={l} className="min-w-56 px-3 py-3">
          {cell(l, rules[l])}
        </td>
      ))}
    </tr>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th />
            {LEVELS.map((l) => (
              <th key={l} className="px-3 pb-2 text-left">
                <LevelBadge level={l} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {row('Approver roles', 'Whose approvals count', (l, r) => <RolePicker value={r.approverRoles} onChange={(v) => set(l, { approverRoles: v })} disabled={disabled} />)}
          {row('Minimum approvals', '0 = none needed', (l, r) => <NumberInput value={r.minApprovals} onChange={(n) => set(l, { minApprovals: n })} disabled={disabled} />)}
          {row('Review period', 'Open for comment before approval', (l, r) => <NumberInput value={r.reviewPeriodDays} onChange={(n) => set(l, { reviewPeriodDays: n })} suffix="days" disabled={disabled} />)}
          {row('Lazy consensus', 'Approved automatically if no objections by the end of the review period', (l, r) => <Toggle checked={r.lazyConsensus} onChange={(v) => set(l, { lazyConsensus: v })} disabled={disabled} />)}
          {row('Vote', 'Also require a vote', (l, r) => (
            <div className="space-y-2">
              <Toggle checked={!!r.vote} onChange={(v) => (v ? setVote(l, {}) : set(l, { vote: undefined }))} label={r.vote ? 'On' : 'Off'} disabled={disabled} />
              {r.vote && (
                <div className="space-y-2 rounded-lg bg-surface-2 p-2.5">
                  <div className="text-xs text-muted">Voters</div>
                  <RolePicker value={r.vote.voterRoles} onChange={(v) => setVote(l, { voterRoles: v })} disabled={disabled} />
                  <div className="grid grid-cols-1 gap-2 text-xs">
                    <label className="flex items-center justify-between gap-2">
                      Quorum <NumberInput value={Math.round(r.vote.quorum * 100)} onChange={(n) => setVote(l, { quorum: n / 100 })} max={100} suffix="%" disabled={disabled} />
                    </label>
                    <label className="flex items-center justify-between gap-2">
                      Threshold <NumberInput value={Math.round(r.vote.threshold * 100)} onChange={(n) => setVote(l, { threshold: n / 100 })} max={100} suffix="%" disabled={disabled} />
                    </label>
                    <label className="flex items-center justify-between gap-2">
                      Duration <NumberInput value={r.vote.durationDays} onChange={(n) => setVote(l, { durationDays: n })} min={1} suffix="days" disabled={disabled} />
                    </label>
                  </div>
                </div>
              )}
            </div>
          ))}
          {row('Veto roles', 'A single objection from these blocks it', (l, r) => <RolePicker value={r.vetoRoles} onChange={(v) => set(l, { vetoRoles: v })} disabled={disabled} />)}
          {row('Auto-merge', 'Merge as soon as approved', (l, r) => <Toggle checked={r.autoMerge} onChange={(v) => set(l, { autoMerge: v })} disabled={disabled} />)}
        </tbody>
      </table>
    </div>
  );
}

function Members() {
  const { id, ontology, hasRole, reload } = useOntology();
  const personas = useAsync(() => api.personas(), []);
  const [adding, setAdding] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [transferResult, setTransferResult] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const canManage = hasRole('owner', 'steward');
  const act = useAction(async (fn: () => Promise<unknown>) => {
    await fn();
    await reload();
  });
  const transfer = useAction(async () => {
    const r = await api.transferOwnership(id, transferTo);
    setTransferResult(r.status === 'pending-vote' || r.voteId ? 'A vote on the ownership transfer has been opened.' : `Ownership transfer: ${r.status}.`);
    await reload();
  });
  const memberIds = new Set(ontology.members.map((m) => m.userId));
  const candidates = (personas.data ?? []).filter((p) => !memberIds.has(p.id));

  return (
    <CollapsibleCard
      id="roles"
      icon={Users}
      title="Members and roles"
      subtitle="A person can hold several roles. Roles decide whose approvals and votes count."
      summary={`${plural(ontology.members.length, 'member')}: ${ontology.members.map((m) => m.user?.name ?? m.userId).join(', ')}`}
      defaultOpen={window.location.hash === '#roles'}
    >
      <div className="divide-y divide-line">
        {ontology.members.map((m) => (
          <div key={m.userId} className="flex flex-wrap items-start gap-3 px-5 py-3">
            <Avatar name={m.user?.name} src={m.user?.avatarUrl} simulated={m.user?.simulated} size={32} />
            <div className="min-w-44 flex-1">
              <div className="text-sm font-medium">
                {m.user?.name ?? m.userId} {ontology.ownerIds.includes(m.userId) && <Crown className="inline size-3.5 text-warn" />}
              </div>
              <div className="text-xs text-muted">{m.user?.organisation ?? m.user?.email}</div>
            </div>
            <div className="flex flex-[2] flex-wrap items-center gap-1">
              {editing === m.userId ? (
                ALL_ROLES.map((r) => (
                  <Chip
                    key={r}
                    active={m.roles.includes(r)}
                    disabled={!canManage || act.pending}
                    onClick={() => void act.run(() => api.setMemberRoles(id, m.userId, m.roles.includes(r) ? m.roles.filter((x) => x !== r) : [...m.roles, r]))}
                  >
                    {roleLabel(r)}
                  </Chip>
                ))
              ) : (
                <RoleChips roles={m.roles} />
              )}
              {canManage && (
                <button className="ml-1 text-xs font-medium text-accent hover:underline" onClick={() => setEditing(editing === m.userId ? undefined : m.userId)}>
                  {editing === m.userId ? 'Done' : 'Edit roles'}
                </button>
              )}
            </div>
            {canManage && !ontology.ownerIds.includes(m.userId) && (
              <button className="p-1 text-muted hover:text-danger" title="Remove member" onClick={() => confirm(`Remove ${m.user?.name}?`) && void act.run(() => api.removeMember(id, m.userId))}>
                <Trash2 className="size-4" />
              </button>
            )}
          </div>
        ))}
      </div>
      {canManage && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4">
          <Select value={adding} onChange={(e) => setAdding(e.target.value)} className="w-auto min-w-56" disabled={!candidates.length}>
            <option value="">{candidates.length ? 'Add a person…' : 'Everyone is already a member'}</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.organisation ? ` — ${p.organisation}` : ''}
              </option>
            ))}
          </Select>
          <Button
            icon={UserPlus}
            disabled={!adding}
            loading={act.pending}
            onClick={() =>
              void act.run(async () => {
                await api.setMemberRoles(id, adding, ['contributor']);
                setAdding('');
              })
            }
          >
            Add as contributor
          </Button>
        </div>
      )}
      <InlineError error={act.error || personas.error} />
      <Disclosure className="border-t border-line px-5 py-4" title="Transfer ownership">
        <p className="mb-3 text-xs text-muted">
          Under this policy: {ontology.governance.ownership.transfer === 'owner-decides' ? 'the owner decides' : ontology.governance.ownership.transfer === 'member-vote' ? 'voting members decide by vote' : 'ODI must approve the transfer'}.
        </p>
        <div className="flex flex-wrap gap-2">
          <Select value={transferTo} onChange={(e) => setTransferTo(e.target.value)} className="w-auto min-w-56" disabled={!hasRole('owner')}>
            <option value="">Choose the new owner…</option>
            {ontology.members
              .filter((m) => !ontology.ownerIds.includes(m.userId))
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.user?.name}
                </option>
              ))}
          </Select>
          <Button icon={Crown} disabled={!transferTo || !hasRole('owner')} loading={transfer.pending} onClick={() => void transfer.run()}>
            Transfer
          </Button>
        </div>
        {!hasRole('owner') && <p className="mt-2 text-xs text-muted">Only an owner can start a transfer.</p>}
        {transferResult && <p className="mt-2 text-sm text-ok">{transferResult}</p>}
        <InlineError error={transfer.error} />
      </Disclosure>
    </CollapsibleCard>
  );
}

const OWNERSHIP: Record<GovernancePolicy['ownership']['model'], string> = { single: 'Single owner', group: 'Group of owners' };
const ODI: Record<GovernancePolicy['odiPrivilege'], string> = { none: 'no ODI privilege', veto: 'ODI can veto', 'final-say': 'ODI has the final say' };

/** One plain-language line per rule, e.g. "2 sign-offs from Steward or Editor · 7 days open for comment". */
export function ruleSummary(r: ApprovalRule): string {
  const parts: string[] = [];
  parts.push(r.minApprovals > 0 ? `${plural(r.minApprovals, 'sign-off')} from ${r.approverRoles.map(roleLabel).join(' or ') || 'anyone'}` : 'no sign-off needed');
  if (r.reviewPeriodDays > 0) parts.push(`${plural(r.reviewPeriodDays, 'day')} open for comment`);
  if (r.lazyConsensus) parts.push('accepted if nobody objects');
  if (r.vote) parts.push(`a vote (${pct(r.vote.threshold)} in favour, ${pct(r.vote.quorum)} turnout)`);
  if (r.vetoRoles.length) parts.push(`${r.vetoRoles.map(roleLabel).join(' or ')} can block it`);
  if (r.autoMerge) parts.push('merged automatically');
  return parts.join(' · ');
}

function PolicySummary({ policy }: { policy: GovernancePolicy }) {
  return (
    <Card className="p-5">
      <div className="text-xs font-semibold tracking-wide text-muted uppercase">In short</div>
      <p className="mt-1 text-sm">
        <strong className="font-medium">{policy.name}.</strong> <span className="text-muted">{policy.description}</span>
      </p>
      <ul className="mt-3 space-y-1.5 text-sm" aria-label="What each kind of change needs">
        {LEVELS.map((l) => (
          <li key={l} className="flex items-start gap-2">
            <LevelBadge level={l} className="mt-0.5 w-14 justify-center" />
            <span>{ruleSummary(policy.changes[l])}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function GovernanceTab() {
  const { id, ontology, hasRole, reload } = useOntology();
  const templates = useAsync(() => api.governanceTemplates(), []);
  const [policy, setPolicy] = useState<GovernancePolicy>(ontology.governance);
  const [saved, setSaved] = useState(false);
  useEffect(() => setPolicy(ontology.governance), [ontology.governance]);
  const dirty = useMemo(() => JSON.stringify(policy) !== JSON.stringify(ontology.governance), [policy, ontology.governance]);
  const canEdit = hasRole('owner', 'steward');
  const save = useAction(async () => {
    await api.setGovernance(id, policy);
    await reload();
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  });
  useEffect(() => {
    if (window.location.hash === '#roles') document.getElementById('roles')?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const edit = (p: Partial<GovernancePolicy>) => setPolicy((x) => ({ ...x, ...p, templateId: p.templateId ?? 'custom', name: p.name ?? (p.templateId ? x.name : x.templateId === 'custom' ? x.name : `${x.name} (customised)`) }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Governance</h2>
          <p className="max-w-2xl text-sm text-muted">How changes and releases get approved — so decisions can happen asynchronously, without needing a meeting.</p>
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-sm text-ok">Saved</span>}
          {dirty && (
            <Button variant="ghost" onClick={() => setPolicy(ontology.governance)}>
              Discard
            </Button>
          )}
          <Button variant="primary" icon={Save} disabled={!dirty || !canEdit} loading={save.pending} onClick={() => void save.run()}>
            Save policy
          </Button>
        </div>
      </div>
      {!canEdit && <p className="rounded-lg bg-surface-2 px-4 py-2.5 text-sm text-muted">You can view the policy; only owners and stewards can change it.</p>}
      <InlineError error={save.error} />

      <PolicySummary policy={policy} />

      <CollapsibleCard icon={Scale} title="Policy template" subtitle="Start from a template, then fine-tune the rules below." summary={<>Using <strong className="font-medium">{policy.name}</strong></>}>
        <div className="p-5">
          {templates.error && !templates.data ? (
            <ErrorCard error={templates.error} onRetry={templates.reload} />
          ) : !templates.data ? (
            <Loading />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {templates.data.map((t) => (
                <button
                  key={t.templateId}
                  disabled={!canEdit}
                  onClick={() => setPolicy(structuredClone(t))}
                  className={cx('rounded-xl border p-4 text-left transition-colors disabled:cursor-default', policy.templateId === t.templateId ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-line-strong')}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{t.name}</span>
                    {policy.templateId === t.templateId && <Badge tone="accent">Selected</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted">{t.description}</p>
                </button>
              ))}
              {policy.templateId === 'custom' && (
                <div className="rounded-xl border border-accent bg-accent-soft/50 p-4">
                  <div className="text-sm font-semibold">{policy.name}</div>
                  <p className="mt-1 text-xs text-muted">A customised policy.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </CollapsibleCard>

      <CollapsibleCard title="Change request rules" subtitle="Rules by semantic version level. Patch = editorial, minor = backwards-compatible additions, major = breaking.">
        <div className="p-5">
          <RulesTable rules={policy.changes} onChange={(changes) => edit({ changes })} disabled={!canEdit} />
        </div>
      </CollapsibleCard>

      <CollapsibleCard title="Release rules" subtitle="How a new version is approved, by release level.">
        <div className="p-5">
          <RulesTable rules={policy.releases} onChange={(releases) => edit({ releases })} disabled={!canEdit} />
        </div>
      </CollapsibleCard>

      <CollapsibleCard
        title="Ownership, ODI and automation"
        subtitle="Who owns the ontology, what the ODI can do, and which steps run automatically."
        summary={`${OWNERSHIP[policy.ownership.model]} · ${ODI[policy.odiPrivilege]} · ${[policy.automation.autoTriage, policy.automation.autoDraftRelease, policy.automation.reminders, policy.automation.appAutopilot !== false, policy.requireValidation].filter(Boolean).length} of 5 automations on`}
      >
        <div className="grid md:grid-cols-2 md:divide-x divide-line">
          <div>
            <h4 className="px-5 pt-4 text-sm font-semibold">Ownership and ODI</h4>
            <div className="space-y-4 p-5 text-sm">
              <label className="block">
                <span className="mb-1 block font-medium">Ownership model</span>
                <Select value={policy.ownership.model} disabled={!canEdit} onChange={(e) => edit({ ownership: { ...policy.ownership, model: e.target.value as 'single' | 'group' } })}>
                  <option value="single">Single owner</option>
                  <option value="group">Group of owners</option>
                </Select>
              </label>
              <label className="block">
                <span className="mb-1 block font-medium">Ownership transfer</span>
                <Select value={policy.ownership.transfer} disabled={!canEdit} onChange={(e) => edit({ ownership: { ...policy.ownership, transfer: e.target.value as GovernancePolicy['ownership']['transfer'] } })}>
                  <option value="owner-decides">The owner decides</option>
                  <option value="member-vote">Voting members vote</option>
                  <option value="odi-approval">ODI must approve</option>
                </Select>
              </label>
              <label className="block">
                <span className="mb-1 block font-medium">ODI privilege</span>
                <Select value={policy.odiPrivilege} disabled={!canEdit} onChange={(e) => edit({ odiPrivilege: e.target.value as GovernancePolicy['odiPrivilege'] })}>
                  <option value="none">None — ODI participates like anyone else</option>
                  <option value="veto">Veto — ODI oversight can block any change</option>
                  <option value="final-say">Final say — ODI oversight decides</option>
                </Select>
              </label>
            </div>
          </div>
          <div>
            <h4 className="px-5 pt-4 text-sm font-semibold">Automation</h4>
            <div className="space-y-4 p-5">
              <Toggle checked={policy.automation.autoTriage} disabled={!canEdit} onChange={(v) => edit({ automation: { ...policy.automation, autoTriage: v } })} label="AI triage: classify and validate every request on arrival" />
              <Toggle checked={policy.automation.autoDraftRelease} disabled={!canEdit} onChange={(v) => edit({ automation: { ...policy.automation, autoDraftRelease: v } })} label="Draft a release automatically when approved changes accumulate" />
              <Toggle checked={policy.automation.reminders} disabled={!canEdit} onChange={(v) => edit({ automation: { ...policy.automation, reminders: v } })} label="Nudge reviewers and voters when actions are pending" />
              <Toggle
                checked={policy.automation.appAutopilot !== false}
                disabled={!canEdit}
                onChange={(v) => edit({ automation: { ...policy.automation, appAutopilot: v } })}
                label="Autopilot: members can have Concord approve or vote yes for them when their apps pass a change"
              />
              <Toggle checked={policy.requireValidation} disabled={!canEdit} onChange={(v) => edit({ requireValidation: v })} label="Changes that fail validation can never be approved" />
            </div>
          </div>
        </div>
      </CollapsibleCard>

      <Members />
    </div>
  );
}
