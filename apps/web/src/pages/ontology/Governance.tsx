import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApprovalRule, ChangeLevel, GovernancePolicy, Role } from '@concord/shared';
import { ROLE_INFO } from '@concord/shared';
import { Crown, Pencil, Save, UserPlus, Users, Scale, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useAction, useAsync } from '../../lib/hooks';
import { pct, plural, roleLabel } from '../../lib/format';
import { LevelBadge, RoleChips } from '../../components/badges';
import { CollapsibleCard, Disclosure } from '../../components/Disclosure';
import { Avatar, Badge, Button, Card, CardHeader, Chip, ErrorCard, InlineError, Input, Loading, Select, Toggle, cx } from '../../components/ui';
import { useOntology } from './Layout';
import { alwaysRules, RuleList, ruleSummary } from '../../components/PolicyRules';

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

function RulesTable({
  rules,
  onChange,
  disabled,
  levels = LEVELS,
}: {
  rules: Record<ChangeLevel, ApprovalRule>;
  onChange: (r: Record<ChangeLevel, ApprovalRule>) => void;
  disabled?: boolean;
  /** Which levels to show as columns; one level at a time while editing, all three to compare. */
  levels?: ChangeLevel[];
}) {
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
      {levels.map((l) => (
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
            {levels.map((l) => (
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
          {row('Lazy consensus', 'Approved automatically if no objections by the end of the review period', (l, r) => <Toggle checked={r.lazyConsensus} onChange={(v) => set(l, { lazyConsensus: v })} disabled={disabled} ariaLabel={`Lazy consensus (${l})`} />)}
          {row('Vote', 'Also require a vote', (l, r) => (
            <div className="space-y-2">
              <Toggle checked={!!r.vote} onChange={(v) => (v ? setVote(l, {}) : set(l, { vote: undefined }))} label={r.vote ? 'On' : 'Off'} disabled={disabled} ariaLabel={`Vote (${l})`} />
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
          {row('Auto-merge', 'Merge as soon as approved', (l, r) => <Toggle checked={r.autoMerge} onChange={(v) => set(l, { autoMerge: v })} disabled={disabled} ariaLabel={`Auto-merge (${l})`} />)}
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
        <Disclosure className="border-t border-line px-5 py-4" title="Add a person" summary={candidates.length ? `${plural(candidates.length, 'person', 'people')} available` : 'everyone is a member'}>
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Person to add" value={adding} onChange={(e) => setAdding(e.target.value)} className="w-auto min-w-56" disabled={!candidates.length}>
              <option value="">{candidates.length ? 'Choose a person…' : 'Everyone is already a member'}</option>
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
        </Disclosure>
      )}
      <InlineError error={act.error || personas.error} />
      <Disclosure className="border-t border-line px-5 py-4" title="Transfer ownership">
        <p className="mb-3 text-xs text-muted">
          Under this policy: {ontology.governance.ownership.transfer === 'owner-decides' ? 'the owner decides' : ontology.governance.ownership.transfer === 'member-vote' ? 'voting members decide by vote' : 'ODI must approve the transfer'}.
        </p>
        <div className="flex flex-wrap gap-2">
          <Select aria-label="New owner" value={transferTo} onChange={(e) => setTransferTo(e.target.value)} className="w-auto min-w-56" disabled={!hasRole('owner')}>
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

function PolicySummary({ policy, preview }: { policy: GovernancePolicy; preview?: boolean }) {
  const always = alwaysRules(policy);
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs font-semibold tracking-wide text-muted uppercase">In short</div>
        {preview && <Badge tone="warn">Preview of unsaved changes</Badge>}
      </div>
      <p className="mt-1 text-sm">
        <strong className="font-medium">{policy.name}.</strong> <span className="text-muted">{policy.description}</span>
      </p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-1.5 text-sm font-semibold">Change requests</h3>
          <RuleList rules={policy.changes} policy={policy} label="What each kind of change needs" />
        </div>
        <div>
          <h3 className="mb-1.5 text-sm font-semibold">Releases</h3>
          <RuleList rules={policy.releases} policy={policy} label="What each kind of release needs" kind="release" />
        </div>
      </div>
      {always.length > 0 && (
        <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
          <span className="font-medium text-fg">Always: </span>
          {always.join('; ')}.
        </p>
      )}
    </Card>
  );
}

/** Read view: one line per level. Edit view: one level at a time, or all three side by side to compare. */
function RulesSection({
  rules,
  policy,
  editing,
  onChange,
  label,
  kind,
}: {
  rules: Record<ChangeLevel, ApprovalRule>;
  policy: GovernancePolicy;
  editing: boolean;
  onChange: (r: Record<ChangeLevel, ApprovalRule>) => void;
  label: string;
  kind: 'change' | 'release';
}) {
  const [level, setLevel] = useState<ChangeLevel | 'all'>('minor');
  if (!editing)
    return (
      <div className="space-y-4 p-5">
        <RuleList rules={rules} policy={policy} label={label} kind={kind} />
        <Disclosure tone="muted" title="Compare all levels" summary="every setting, side by side">
          <RulesTable rules={rules} onChange={onChange} disabled />
        </Disclosure>
      </div>
    );
  return (
    <div className="p-5">
      <div className="mb-4 flex flex-wrap items-center gap-1.5" role="group" aria-label="Level to edit">
        {LEVELS.map((l) => (
          <Chip key={l} active={level === l} onClick={() => setLevel(l)}>
            Edit {l}
          </Chip>
        ))}
        <Chip active={level === 'all'} onClick={() => setLevel('all')}>
          Compare all
        </Chip>
      </div>
      <RulesTable rules={rules} onChange={onChange} levels={level === 'all' ? LEVELS : [level]} />
      {level !== 'all' && <p className="mt-3 text-xs text-muted">In short: {ruleSummary(rules[level], level, policy, kind)}</p>}
    </div>
  );
}

const TRANSFER: Record<GovernancePolicy['ownership']['transfer'], string> = { 'owner-decides': 'The owner decides', 'member-vote': 'Voting members vote', 'odi-approval': 'ODI must approve' };

export function GovernanceTab() {
  const { id, ontology, hasRole, reload } = useOntology();
  const templates = useAsync(() => api.governanceTemplates(), []);
  const [policy, setPolicy] = useState<GovernancePolicy>(ontology.governance);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => setPolicy(ontology.governance), [ontology.governance]);
  const dirty = useMemo(() => JSON.stringify(policy) !== JSON.stringify(ontology.governance), [policy, ontology.governance]);
  // Only owners can save a policy (the server checks the same), so only they get the edit controls.
  const canEdit = hasRole('owner');
  const save = useAction(async () => {
    await api.setGovernance(id, policy);
    await reload();
    setEditing(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  });
  const discard = () => {
    setPolicy(ontology.governance);
    setEditing(false);
  };
  useEffect(() => {
    if (window.location.hash !== '#roles') return;
    // Move focus as well as the view, so keyboard and screen-reader users land on the members list too.
    const section = document.getElementById('roles');
    section?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    section?.querySelector<HTMLElement>('button[aria-expanded]')?.focus({ preventScroll: true });
  }, []);

  const edit = (p: Partial<GovernancePolicy>) => setPolicy((x) => ({ ...x, ...p, templateId: p.templateId ?? 'custom', name: p.name ?? (p.templateId ? x.name : x.templateId === 'custom' ? x.name : `${x.name} (customised)`) }));
  const automations = [policy.automation.autoTriage, policy.automation.autoDraftRelease, policy.automation.reminders, policy.requireValidation].filter(Boolean).length;

  const saveBar = editing && (
    <div className="flex flex-wrap items-center gap-2">
      {dirty ? <span className="text-sm text-warn">Unsaved changes</span> : <span className="text-sm text-muted">No changes yet</span>}
      <Button variant="ghost" onClick={discard}>
        {dirty ? 'Discard' : 'Cancel'}
      </Button>
      <Button variant="primary" icon={Save} disabled={!dirty} loading={save.pending} onClick={() => void save.run()}>
        Save policy
      </Button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Governance</h2>
          <p className="max-w-2xl text-sm text-muted">How changes and releases get approved — so decisions can happen asynchronously, without needing a meeting.</p>
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-sm text-ok">Saved</span>}
          {editing ? (
            saveBar
          ) : canEdit ? (
            <Button icon={Pencil} onClick={() => setEditing(true)}>
              Edit policy
            </Button>
          ) : null}
        </div>
      </div>
      {!canEdit && <p className="rounded-lg bg-surface-2 px-4 py-2.5 text-sm text-muted">You can read the policy; only the ontology’s owners can change it.</p>}
      {editing && <p className="rounded-lg bg-accent-soft px-4 py-2.5 text-sm">Editing the policy. Nothing changes for anyone until you save; the summary below previews your edits.</p>}
      <InlineError error={save.error} />

      <PolicySummary policy={policy} preview={editing && dirty} />

      <CollapsibleCard icon={Scale} title="Policy template" subtitle={editing ? 'Start from a template, then fine-tune the rules below.' : 'The template this policy started from.'} summary={<>Using <strong className="font-medium">{policy.name}</strong></>} defaultOpen={editing} openKey={editing || undefined}>
        <div className="p-5">
          {!editing ? (
            <div>
              <div className="text-sm font-semibold">{policy.name}</div>
              <p className="mt-1 text-sm text-muted">{policy.description}</p>
              {canEdit && <p className="mt-3 text-xs text-muted">Choose “Edit policy” to switch to another template, such as Lazy consensus or Steward-led.</p>}
            </div>
          ) : templates.error && !templates.data ? (
            <ErrorCard error={templates.error} onRetry={templates.reload} />
          ) : !templates.data ? (
            <Loading />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {templates.data.map((t) => (
                <button
                  key={t.templateId}
                  onClick={() => setPolicy(structuredClone(t))}
                  aria-pressed={policy.templateId === t.templateId}
                  className={cx('rounded-xl border p-4 text-left transition-colors', policy.templateId === t.templateId ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-line-strong')}
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
        <RulesSection rules={policy.changes} policy={policy} editing={editing} onChange={(changes) => edit({ changes })} label="Change request rules by level" kind="change" />
      </CollapsibleCard>

      <CollapsibleCard title="Release rules" subtitle="How a new version is approved, by release level.">
        <RulesSection rules={policy.releases} policy={policy} editing={editing} onChange={(releases) => edit({ releases })} label="Release rules by level" kind="release" />
      </CollapsibleCard>

      <CollapsibleCard
        title="Ownership, ODI and automation"
        subtitle="Who owns the ontology, what the ODI can do, and which steps run automatically."
        summary={`${OWNERSHIP[policy.ownership.model]} · ${ODI[policy.odiPrivilege]} · ${automations} of 4 automations on`}
      >
        {!editing ? (
          <dl className="grid gap-x-6 gap-y-2 p-5 text-sm sm:grid-cols-[12rem_1fr]">
            <dt className="text-muted">Ownership model</dt>
            <dd>{OWNERSHIP[policy.ownership.model]}</dd>
            <dt className="text-muted">Ownership transfer</dt>
            <dd>{TRANSFER[policy.ownership.transfer]}</dd>
            <dt className="text-muted">ODI privilege</dt>
            <dd>{ODI[policy.odiPrivilege].replace(/^./, (c) => c.toUpperCase())}</dd>
            <dt className="text-muted">Automation</dt>
            <dd>
              <ul className="space-y-0.5">
                <li>{policy.automation.autoTriage ? 'On' : 'Off'}: AI triage of every request on arrival</li>
                <li>{policy.automation.autoDraftRelease ? 'On' : 'Off'}: draft a release when approved changes accumulate</li>
                <li>{policy.automation.reminders ? 'On' : 'Off'}: nudge reviewers and voters</li>
                <li>{policy.requireValidation ? 'On' : 'Off'}: changes that fail validation can never be approved</li>
              </ul>
            </dd>
          </dl>
        ) : (
          <div className="grid md:grid-cols-2 md:divide-x divide-line">
            <div>
              <h4 className="px-5 pt-4 text-sm font-semibold">Ownership and ODI</h4>
              <div className="space-y-4 p-5 text-sm">
                <label className="block">
                  <span className="mb-1 block font-medium">Ownership model</span>
                  <Select value={policy.ownership.model} onChange={(e) => edit({ ownership: { ...policy.ownership, model: e.target.value as 'single' | 'group' } })}>
                    <option value="single">Single owner</option>
                    <option value="group">Group of owners</option>
                  </Select>
                </label>
                <label className="block">
                  <span className="mb-1 block font-medium">Ownership transfer</span>
                  <Select value={policy.ownership.transfer} onChange={(e) => edit({ ownership: { ...policy.ownership, transfer: e.target.value as GovernancePolicy['ownership']['transfer'] } })}>
                    <option value="owner-decides">The owner decides</option>
                    <option value="member-vote">Voting members vote</option>
                    <option value="odi-approval">ODI must approve</option>
                  </Select>
                </label>
                <label className="block">
                  <span className="mb-1 block font-medium">ODI privilege</span>
                  <Select value={policy.odiPrivilege} onChange={(e) => edit({ odiPrivilege: e.target.value as GovernancePolicy['odiPrivilege'] })}>
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
                <Toggle checked={policy.automation.autoTriage} onChange={(v) => edit({ automation: { ...policy.automation, autoTriage: v } })} label="AI triage: classify and validate every request on arrival" />
                <Toggle checked={policy.automation.autoDraftRelease} onChange={(v) => edit({ automation: { ...policy.automation, autoDraftRelease: v } })} label="Draft a release automatically when approved changes accumulate" />
                <Toggle checked={policy.automation.reminders} onChange={(v) => edit({ automation: { ...policy.automation, reminders: v } })} label="Nudge reviewers and voters when actions are pending" />
                <Toggle checked={policy.requireValidation} onChange={(v) => edit({ requireValidation: v })} label="Changes that fail validation can never be approved" />
              </div>
            </div>
          </div>
        )}
      </CollapsibleCard>

      {editing && <div className="flex justify-end">{saveBar}</div>}

      <Members />
    </div>
  );
}
