import { test, expect, settle, signIn, signInAsPersona, uniq } from './fixtures';

const SOURCE = 'http://www.w3.org/ns/auth/acl';
const LICENCE = 'https://www.w3.org/Consortium/Legal/2015/copyright-software-and-document';
const ACL = 'http://www.w3.org/ns/auth/acl#';
const HEALTH_NOTE = "Concord's checks flag some wording inherited from the original; it is kept as published so the copy stays faithful.";

test('the public catalogue groups sample copies after ordinary standards and marks their machine-readable entries', async ({ page }) => {
  // The new public catalogue used to list sample copies as ordinary standards.
  await page.goto('/def');
  const samples = page.getByRole('region', { name: 'Sample standards', exact: true });
  const sampleLink = samples.getByRole('link', { name: 'Web Access Control', exact: true });
  await expect(sampleLink).toBeHidden();
  await samples.locator('summary').click();
  await expect(sampleLink).toBeVisible();
  await expect(samples.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Web Access Control', exact: true }) })).toContainText('Sample copy');
  const standards = page.getByRole('list', { name: 'Standards', exact: true });
  await expect(standards.getByRole('link', { name: 'Volunteering opportunities', exact: true })).toBeVisible();
  await expect(standards.getByRole('link', { name: 'Web Access Control', exact: true })).toHaveCount(0);
  expect(await standards.evaluate((el, section) => Boolean(el.compareDocumentPosition(section!) & Node.DOCUMENT_POSITION_FOLLOWING), await samples.elementHandle())).toBe(true);
  const json = await (await page.request.get('/def.jsonld')).json();
  expect(json.hasPart.find((part: { url: string }) => part.url.endsWith('/acl'))).toMatchObject({ keywords: ['Sample standard'], isBasedOn: SOURCE, license: LICENCE });
  await sampleLink.click();
  await expect(page.getByRole('region', { name: 'About this sample', exact: true })).toBeVisible();
});

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
  await expect(notice).toContainText(HEALTH_NOTE);
  await expect(notice.getByRole('link', { name: 'Web Access Control', exact: true })).toHaveAttribute('href', SOURCE);
  await expect(notice.getByRole('link', { name: 'W3C Software and Document License (2015)' })).toHaveAttribute('href', LICENCE);
  await expect(notice.getByRole('link', { name: 'Full licence notice' })).toHaveAttribute('href', '/licences/W3C-20150513');
  await expect(notice).toContainText('Copyright (c) W3C® (MIT, ERCIM, Keio, Beihang).');
  await notice.locator('summary', { hasText: 'What the conversion changed' }).click();
  await expect(notice.getByText(/Promoted RDFS classes and properties/)).toBeVisible();
  const health = page.getByRole('button', { name: /^Health:/ });
  await health.click();
  await expect(page.getByRole('dialog', { name: /^Health:/ })).toContainText(HEALTH_NOTE);
  await page.keyboard.press('Escape');
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
  const thisVersion = page.locator('.row').filter({ has: page.locator('dt', { hasText: /^This version$/ }) }).locator('dd');
  await expect(thisVersion).toContainText('/def/acl/1.0.0');
  await expect(thisVersion).not.toContainText('w3.org');
  const notice = page.getByRole('region', { name: 'About this sample', exact: true });
  await expect(notice).toContainText('sample copy for trying Concord');
  await expect(notice).toContainText(HEALTH_NOTE);
  await expect(notice.getByRole('link', { name: 'Web Access Control', exact: true })).toHaveAttribute('href', SOURCE);
  await expect(notice.getByRole('link', { name: 'W3C Software and Document License (2015)' })).toHaveAttribute('href', LICENCE);
  await expect(notice.getByRole('link', { name: 'Full licence notice' })).toHaveAttribute('href', '/licences/W3C-20150513');
  await expect(notice).toContainText('Copyright (c) W3C® (MIT, ERCIM, Keio, Beihang).');
  await notice.locator('summary', { hasText: 'What the conversion changed' }).click();
  await expect(notice.getByText(/Promoted RDFS classes and properties/)).toBeVisible();
  await notice.getByRole('link', { name: 'Full licence notice' }).click();
  await expect(page.getByText('COPYRIGHT HOLDERS WILL NOT BE LIABLE', { exact: false })).toBeVisible();
  await page.goto('/def/acl/1.0.0#Authorization');
  await expect(page.getByRole('heading', { name: /authorization$/, level: 3 })).toBeVisible();
});

test('a tester who stewards the demo can propose a sample edit but cannot change its policy or merge directly', async ({ page }) => {
  await signIn(page, { name: 'Sample proposer', role: 'steward' });
  const list = await (await page.request.get('/api/ontologies')).json() as { id: string; slug: string }[];
  const acl = list.find((p) => p.slug === 'acl')!;
  await page.goto(`/o/${acl.id}/governance`);
  await settle(page);
  const banner = page.getByText('Viewing as Sample proposer');
  await expect(banner).toContainText('(participant)');
  await expect(banner).not.toContainText('Owner');
  await expect(page.getByRole('button', { name: 'Edit policy', exact: true })).toHaveCount(0);
  await expect(page.getByText('You can read the policy; only the ontology’s owners can change it.')).toBeVisible();
  await page.goto(`/o/${acl.id}/browse?term=${encodeURIComponent(ACL + 'agent')}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = page.getByRole('form', { name: /^Edit / });
  const comment = `A proposed clarification ${uniq()}`;
  // Field wraps the textarea in its label: exact label text also includes its initial value.
  await form.getByRole('textbox', { name: 'Comment', exact: true }).fill(comment);
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
  await expect(page.getByText('Viewing as Priya Shah')).toContainText('(Owner, Steward, Editor, Voting member)');
  await page.getByRole('button', { name: 'Edit policy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save policy', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
});

test('sample notices link to their shapes in the Solid Shapes Catalogue, and the Schedule sample is there', async ({ page }) => {
  await signIn(page, { name: 'Shapes reader', role: 'contributor' });
  await page.goto('/');
  const samples = page.getByRole('region', { name: 'Sample standards', exact: true });
  await samples.getByRole('button', { name: 'Sample standards', exact: true }).click();
  await samples.getByRole('link', { name: 'vCard', exact: true }).click();
  const notice = page.getByRole('region', { name: 'About this sample', exact: true });
  await expect(notice.getByRole('link', { name: 'Solid Shapes Catalogue', exact: true })).toHaveAttribute('href', 'https://github.com/solid/shapes');
  await expect(notice.getByRole('link', { name: 'address_book.ttl', exact: true })).toHaveAttribute('href', 'https://github.com/solid/shapes/blob/ccbccdb208091e0e822aaa4b14250315cd6f014d/shapes/address_book.ttl');
  // Web Access Control has no shapes in the catalogue, so its notice has no shapes line.
  await page.goto('/');
  await samples.getByRole('button', { name: 'Sample standards', exact: true }).click();
  await samples.getByRole('link', { name: 'Web Access Control', exact: true }).click();
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('link', { name: 'Solid Shapes Catalogue', exact: true })).toHaveCount(0);
  // The scheduler's vocabulary is public with the same notice.
  await page.goto('/def/schedule/1.0.0');
  await expect(page.getByRole('heading', { name: 'Schedule', exact: true, level: 1 })).toBeVisible();
  const publicNotice = page.getByRole('region', { name: 'About this sample', exact: true });
  await expect(publicNotice).toContainText('SolidOS scheduler pane');
  await expect(publicNotice.getByRole('link', { name: 'event.ttl', exact: true })).toHaveAttribute('href', 'https://github.com/solid/shapes/blob/ccbccdb208091e0e822aaa4b14250315cd6f014d/shapes/event.ttl');
});
