import { test, expect, settle, signIn, signInAsPersona, uniq } from './fixtures';

const SOURCE = 'http://www.w3.org/ns/auth/acl';
const LICENCE = 'https://www.w3.org/copyright/software-license-2023/';
const ACL = 'http://www.w3.org/ns/auth/acl#';

test('a tester finds compact sample standards after the demo, reads attribution and browses ACL terms', async ({ page }) => {
  await signIn(page, { name: 'Sample reader', role: 'contributor' });
  await page.goto('/');
  const samples = page.getByRole('region', { name: 'Sample standards', exact: true });
  await expect(samples.getByRole('heading', { name: 'Sample standards' })).toBeVisible();
  const toggle = samples.getByRole('button', { name: 'Sample standards', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const sampleLink = samples.getByRole('link', { name: 'Web Access Control', exact: true });
  // Samples belong to their own section; the volunteering demo remains before it.
  const demo = page.getByRole('link').filter({ has: page.getByRole('heading', { name: 'Volunteering opportunities', exact: true }) });
  expect(await demo.evaluate((el, section) => Boolean(el.compareDocumentPosition(section!) & Node.DOCUMENT_POSITION_FOLLOWING), await samples.elementHandle())).toBe(true);
  await sampleLink.click();
  const notice = page.getByRole('region', { name: 'About this sample', exact: true });
  await expect(notice).toContainText('sample copy for trying Concord');
  await expect(notice).toContainText('W3C');
  await expect(notice.getByRole('link', { name: 'Web Access Control', exact: true })).toHaveAttribute('href', SOURCE);
  await expect(notice.getByRole('link', { name: 'W3C Software and Document License' })).toHaveAttribute('href', LICENCE);
  await notice.getByRole('link', { name: 'What the conversion changed' }).click();
  await expect(notice.getByText(/Promoted RDFS classes and properties/)).toBeVisible();
  const ontologyPath = new URL(page.url()).pathname;
  await page.goto(`${ontologyPath}/browse?term=${encodeURIComponent(ACL + 'Authorization')}`);
  await expect(page.getByRole('heading', { name: 'authorization', exact: true })).toBeVisible();
  await page.goto(`${ontologyPath}/browse?term=${encodeURIComponent(ACL + 'agent')}`);
  await expect(page.getByRole('heading', { name: 'agent', exact: true })).toBeVisible();
});

test('an anonymous visitor reads the released public sample with source, licence and conversion details', async ({ page }) => {
  // A real public release: a reader does not need a session.
  await page.goto('/def/acl/1.0.0');
  await expect(page.getByRole('heading', { name: 'Web Access Control', exact: true, level: 1 })).toBeVisible();
  const notice = page.getByRole('region', { name: 'About this sample', exact: true });
  await expect(notice).toContainText('sample copy for trying Concord');
  await expect(notice.getByRole('link', { name: 'Web Access Control', exact: true })).toHaveAttribute('href', SOURCE);
  await expect(notice.getByRole('link', { name: 'W3C Software and Document License' })).toHaveAttribute('href', LICENCE);
  await notice.getByRole('link', { name: 'What the conversion changed' }).click();
  await expect(notice.getByText(/Promoted RDFS classes and properties/)).toBeVisible();
  await page.goto('/def/acl/1.0.0#Authorization');
  await expect(page.getByRole('heading', { name: /authorization$/, level: 3 })).toBeVisible();
});

test('a tester who stewards the demo can propose a sample edit but cannot change its policy or merge directly', async ({ page }) => {
  await signIn(page, { name: 'Sample proposer', role: 'steward' });
  const list = await (await page.request.get('/api/ontologies')).json() as { id: string; slug: string }[];
  const acl = list.find((p) => p.slug === 'acl')!;
  await page.goto(`/o/${acl.id}/governance`);
  await settle(page);
  await expect(page.getByRole('button', { name: 'Edit policy', exact: true })).toHaveCount(0);
  await expect(page.getByText('You can read the policy; only the ontology’s owners can change it.')).toBeVisible();
  await page.goto(`/o/${acl.id}/browse?term=${encodeURIComponent(ACL + 'agent')}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = page.getByRole('form', { name: /^Edit / });
  const comment = `A proposed clarification ${uniq()}`;
  await form.getByLabel('Comment', { exact: true }).fill(comment);
  await expect(form).toContainText('proposed as a change request');
  await form.getByRole('button', { name: 'Save as draft', exact: true }).click();
  await expect(form).toHaveCount(0);
  const crs = await (await page.request.get(`/api/ontologies/${acl.id}/change-requests`)).json() as { id: string; ops: unknown }[];
  const proposal = crs.find((cr) => JSON.stringify(cr.ops).includes(comment))!;
  expect(proposal).toBeTruthy();
  await page.goto(`/o/${acl.id}/changes/${proposal.id}`);
  await expect(page.getByRole('button', { name: /^Merge/ })).toHaveCount(0);
  const term = await (await page.request.get(`/api/ontologies/${acl.id}/terms/${encodeURIComponent(ACL + 'agent')}`)).json();
  expect(JSON.stringify(term)).not.toContain(comment);
});

test('the sample owner can open its policy editor', async ({ page }) => {
  await signInAsPersona(page, 'Priya Shah');
  const list = await (await page.request.get('/api/ontologies')).json() as { id: string; slug: string }[];
  const acl = list.find((p) => p.slug === 'acl')!;
  await page.goto(`/o/${acl.id}/governance`);
  await page.getByRole('button', { name: 'Edit policy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save policy', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
});
