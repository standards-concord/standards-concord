import type { Page } from '@playwright/test';
import { test, expect, settle, signIn, demoOntology } from './fixtures';

/**
 * A decided release shows a read-only record of its approval: the outcome, the rules that applied
 * and the votes, never "what happens next" or a running countdown. Where the record comes from
 * (saved at the decision, or re-checked against today's policy) is always labelled, published or
 * rejected. The demo only has its set-up release, so these tests serve variants of it.
 */
type Detail = Record<string, unknown> & { id: string; governance: Record<string, unknown> & { rule: Record<string, unknown> } };

test.describe('release approval history', () => {
  let demo: { id: string };
  let base: Detail;
  let memberId: string;
  let memberName: string;

  test.beforeEach(async ({ page, request }) => {
    demo = await demoOntology(request);
    await signIn(page, { name: 'History reader', role: 'member' });
    const releases = (await (await page.request.get(`/api/ontologies/${demo.id}/releases`)).json()) as { id: string; version: string }[];
    const first = releases.find((r) => r.version === '1.0.0') ?? releases[0];
    base = (await (await page.request.get(`/api/releases/${first.id}`)).json()) as Detail;
    const o = (await (await page.request.get(`/api/ontologies/${demo.id}`)).json()) as { members: { userId: string; user?: { name: string } }[] };
    const m = o.members.find((x) => x.user?.name)!;
    memberId = m.userId;
    memberName = m.user!.name;
  });

  const serve = async (page: Page, detail: Detail) => {
    await page.route(new RegExp(`/api/releases/${detail.id}$`), (route) => route.fulfill({ json: detail }));
    await page.goto(`/o/${demo.id}/releases/${detail.id}`);
    await settle(page);
  };
  const future = () => new Date(Date.now() + 5 * 86_400_000).toISOString();
  const past = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const noLiveWording = async (page: Page) => {
    await expect(page.getByText('Next:', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/closes in|left · ends|Still needed|Not open yet/)).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Your actions' })).toHaveCount(0);
  };

  // A release the policy's automation drafted (createdBy "system") used to say "Drafted by someone".
  test('a release drafted by the policy’s automation says it was drafted automatically', async ({ page }) => {
    await serve(page, { ...base, createdBy: 'system' });
    await expect(page.getByText(/^Drafted automatically on /)).toBeVisible();
    await expect(page.getByText(/Drafted by/)).toHaveCount(0);
  });

  test('a release a person drafted names them', async ({ page }) => {
    await serve(page, { ...base, createdBy: memberId });
    await expect(page.getByText(new RegExp(`^Drafted by ${memberName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} on `))).toBeVisible();
  });

  test('a published release without a vote shows the recorded rules, not a next step', async ({ page }) => {
    await serve(page, {
      ...base,
      status: 'published',
      changeRequestIds: ['cr_x'],
      publishedAt: past(2),
      approvalSource: 'recorded',
      votes: [],
      governance: {
        ...base.governance,
        level: 'minor',
        rule: { ...base.governance.rule, vote: undefined, minApprovals: 0, reviewPeriodDays: 0 },
        requiredApprovals: 0,
        approvals: 0,
        vote: undefined,
        // What the live evaluation said just before publishing: it must not be shown as history.
        next: 'The author needs to submit this for review.',
        unmet: ['Submit for review'],
        outcome: 'review',
      },
    });
    await page.getByRole('button', { name: /How this was approved/ }).click();
    await expect(page.getByTestId('approval-source')).toContainText('Later changes to the policy or members don’t change this record');
    const record = page.getByTestId('approval-record');
    await expect(record).toContainText('Approved');
    await expect(record).toContainText('None needed at this level');
    await expect(page.getByText('The author needs to submit this for review.')).toHaveCount(0);
    await noLiveWording(page);
  });

  test('a published release after a vote shows the result and who voted, with no countdown', async ({ page }) => {
    const voteAt = past(3);
    await serve(page, {
      ...base,
      status: 'published',
      changeRequestIds: ['cr_x'],
      publishedAt: past(1),
      approvalSource: 'recorded',
      votes: [
        // The same person changed their mind: only the last vote before the decision is theirs.
        { id: 'v0', subjectType: 'release', subjectId: base.id, userId: memberId, roles: ['member'], choice: 'no', at: past(3.5) },
        { id: 'v1', subjectType: 'release', subjectId: base.id, userId: memberId, roles: ['member'], choice: 'yes', at: voteAt },
        // Cast after the decision: not part of it.
        { id: 'v2', subjectType: 'release', subjectId: base.id, userId: 'late', roles: ['member'], choice: 'no', at: future() },
      ],
      governance: {
        ...base.governance,
        rule: { ...base.governance.rule, vote: { voterRoles: ['member'], quorum: 0.5, threshold: 0.66, durationDays: 7 } },
        vote: { open: true, opensAt: past(4), closesAt: future(), eligible: 2, cast: 1, yes: 1, no: 0, abstain: 0, quorumMet: true, thresholdMet: true },
        vetoedBy: [],
        next: 'Voting is open.',
        unmet: [],
        outcome: 'voting',
      },
    });
    await page.getByRole('button', { name: /How this was approved/ }).click();
    const record = page.getByTestId('approval-record');
    await expect(record).toContainText('1 yes, 0 no, 0 abstain');
    await expect(record).toContainText('1 of 2 eligible (quorum met)');
    const voters = record.getByRole('list', { name: 'Who voted' }).getByRole('listitem');
    await expect(voters).toHaveCount(1);
    await expect(voters.first()).toContainText(`${memberName} voted yes`);
    await expect(record.getByText('Open', { exact: true })).toHaveCount(0);
    await noLiveWording(page);
  });

  test('a rejected release with no saved record says it is checked against today’s policy', async ({ page }) => {
    await serve(page, {
      ...base,
      status: 'rejected',
      changeRequestIds: ['cr_x'],
      publishedAt: undefined,
      statusSince: past(2),
      approvalSource: 'current-policy',
      votes: [],
    });
    await expect(page.getByText('This release attempt was rejected. Draft a new release to try again.')).toBeVisible();
    // The decision is the point of a rejected release's page, so its record starts open.
    const history = page.getByRole('button', { name: /Rejection, checked against today’s policy/ });
    await expect(history).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('approval-source')).toContainText('apply today’s policy and members');
    await expect(page.getByTestId('approval-record')).toContainText('Rejected');
    await expect(page.getByRole('button', { name: /Publish v/ })).toHaveCount(0);
    await noLiveWording(page);
  });

  test('a rejected release with a saved record shows that record', async ({ page }) => {
    await serve(page, { ...base, status: 'rejected', changeRequestIds: ['cr_x'], publishedAt: undefined, statusSince: past(2), approvalSource: 'recorded', votes: [] });
    await expect(page.getByRole('button', { name: /Why this was rejected/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('approval-source')).toContainText('as they stood when this release was rejected');
    await noLiveWording(page);
  });

  test('a published release with no saved record is labelled as checked against today’s policy', async ({ page }) => {
    await serve(page, { ...base, status: 'published', changeRequestIds: ['cr_x'], publishedAt: past(2), approvalSource: 'current-policy', votes: [] });
    await page.getByRole('button', { name: /Approval, checked against today’s policy/ }).click();
    await expect(page.getByTestId('approval-source')).toContainText('may not match what was required at the time');
    await expect(page.getByTestId('approval-record')).toContainText('Approved');
    await noLiveWording(page);
  });

  test('a recorded rejection says why, in the past tense, even when the vote itself passed', async ({ page }) => {
    await serve(page, {
      ...base,
      status: 'rejected',
      changeRequestIds: ['cr_x'],
      publishedAt: undefined,
      statusSince: past(1),
      approvalSource: 'recorded',
      votes: [],
      governance: {
        ...base.governance,
        level: 'major',
        rule: { ...base.governance.rule, minApprovals: 0, reviewPeriodDays: 3, vote: { voterRoles: ['member'], quorum: 0.5, threshold: 0.5, durationDays: 7 } },
        requiredApprovals: 0,
        approvals: 0,
        reviewPeriodOver: true,
        reviewPeriodEndsAt: past(2),
        vote: { open: false, eligible: 2, cast: 2, yes: 2, no: 0, abstain: 0, quorumMet: true, thresholdMet: true },
        vetoedBy: [],
        unmet: ['ODI oversight must approve major changes.'],
        next: 'Waiting for ODI oversight.',
        outcome: 'rejected',
      },
    });
    const reasons = page.getByRole('list', { name: 'Why it was rejected' });
    await expect(reasons.getByRole('listitem')).toHaveText(['ODI oversight had to approve major changes.']);
    const record = page.getByTestId('approval-record');
    await expect(record).toContainText('quorum met');
    await expect(record).toContainText('3 days, ended');
    await noLiveWording(page);
  });

  test('the review period is only “ended” if it was over at the decision, and has no dates without a record', async ({ page }) => {
    const governance = { ...base.governance, rule: { ...base.governance.rule, reviewPeriodDays: 3 }, reviewPeriodOver: false, reviewPeriodEndsAt: future() };
    await serve(page, { ...base, status: 'published', changeRequestIds: ['cr_x'], publishedAt: past(1), approvalSource: 'recorded', votes: [], governance });
    await page.getByRole('button', { name: /How this was approved/ }).click();
    const record = page.getByTestId('approval-record');
    await expect(record).toContainText('3 days, not over at the decision');
    await expect(record).not.toContainText('ended');

    await page.unrouteAll();
    await serve(page, { ...base, status: 'published', changeRequestIds: ['cr_x'], publishedAt: past(1), approvalSource: 'current-policy', votes: [], governance: { ...governance, reviewPeriodOver: true } });
    await page.getByRole('button', { name: /Approval, checked against today’s policy/ }).click();
    await expect(page.getByTestId('approval-record')).toContainText('3 days (the actual review dates weren’t recorded)');
    await expect(page.getByTestId('approval-record')).not.toContainText('Voting opened');
  });
});
