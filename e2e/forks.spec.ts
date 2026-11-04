import { test, expect, expectNoCrash, settle, signIn, demoOntology } from './fixtures';

/**
 * Development forks in Concord: a developer forks the volunteering
 * standard, adds the term their app needs, imports the fork's URL, and
 * proposes the term upstream. Coding agents do the same over MCP (covered by
 * apps/server/test/forks.test.ts).
 */

test('the Forks page lists the demo fork, and its page shows how to use it', async ({ page, request }) => {
  await demoOntology(request);
  await signIn(page, { name: 'Fork viewer', role: 'reviewer' });
  await page.goto('/o/volunteering/forks');
  await settle(page);
  await expectNoCrash(page);
  await expect(page.getByRole('navigation', { name: 'Changes pages' }).getByRole('link', { name: 'Forks', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: /CharityBase recurring shifts/ }).click();
  await expect(page).toHaveURL(/\/o\/volunteering\/forks\/charitybase-recurring-shifts$/);
  await settle(page);
  await expect(page.getByRole('heading', { name: 'CharityBase recurring shifts' })).toBeVisible();
  await expect(page.getByText('Gareth Lewis').first()).toBeVisible();
  await expect(page.getByText('vol:recurrenceRule')).toBeVisible();
  await expect(page.getByText('Only in this fork')).toBeVisible();
  await expect(page.getByText(/\/def\/volunteering\/forks\/charitybase-recurring-shifts$/).first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'What to do next' })).toContainText(/propose/i);
  // Someone else's fork: no editing.
  await expect(page.getByRole('textbox', { name: 'Terms to add' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Propose upstream' })).toHaveCount(0);
});

test('a developer forks the standard, adds a term, imports it and proposes it upstream', async ({ page, request }) => {
  await demoOntology(request);
  await signIn(page, { name: 'Dev Dana', role: 'contributor' });
  const name = `Volunteer hours ${Date.now().toString(36)}`;

  await page.goto('/o/volunteering/forks');
  await settle(page);
  await page.getByRole('button', { name: 'New fork' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
  await dialog.getByRole('textbox', { name: /What is it for/ }).fill('Logging the hours volunteers give in the Helping Hands app');
  await dialog.getByRole('button', { name: 'Create fork' }).click();
  await expect(page).toHaveURL(/\/o\/volunteering\/forks\/volunteer-hours-[a-z0-9]+$/);
  const slug = page.url().split('/').pop()!;
  await settle(page);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText('In development')).toBeVisible();

  await page.getByRole('textbox', { name: 'Terms to add' }).fill('Add a class called Volunteering Activity as a subclass of vol:Session');
  await page.getByRole('button', { name: 'Add to fork' }).click();
  await expect(page.getByText(/Added vol:VolunteeringActivity/)).toBeVisible();
  await expect(page.getByText('vol:VolunteeringActivity', { exact: true })).toBeVisible();
  await expect(page.getByText(`1.0.0-fork.${slug}.1`).first()).toBeVisible();

  // The fork resolves as RDF for applications, and the main ontology is untouched.
  const ttl = await page.request.get(`/def/volunteering/forks/${slug}.ttl`);
  expect(ttl.ok()).toBeTruthy();
  expect(await ttl.text()).toContain('vol:VolunteeringActivity');
  const main = await page.request.get('/api/ontologies/volunteering/source?format=turtle');
  expect(await main.text()).not.toContain('vol:VolunteeringActivity');

  await page.getByRole('button', { name: 'Propose upstream' }).click();
  await expect(page.getByRole('status')).toContainText(/Opened change request #\d+/);
  await expect(page.getByText('Proposed', { exact: true })).toBeVisible();
  await expect(page.getByText('In review').first()).toBeVisible();
  await page.getByRole('link', { name: /#\d+ Add vol:VolunteeringActivity/ }).click();
  await expect(page).toHaveURL(/\/o\/volunteering\/changes\/cr_/);
  await settle(page);
  await expect(page.getByText(`From the fork ${slug}`)).toBeVisible();
  await page.getByRole('link', { name: 'view fork' }).click();
  await expect(page).toHaveURL(new RegExp(`/forks/${slug}$`));
  await settle(page);
  // Nothing new to send upstream until the fork changes again.
  await expect(page.getByRole('button', { name: /Update #\d+/ })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Terms to add' }).fill('Add a property called hours given');
  await page.getByRole('button', { name: 'Add to fork' }).click();
  await expect(page.getByText('vol:hoursGiven', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Update #\d+/ }).click();
  await expect(page.getByRole('status')).toContainText(/Updated #\d+ with the fork's latest edits/);
  await expect(page.getByRole('button', { name: /Update #\d+/ })).toHaveCount(0);
});

test('opening a fork IRI in a browser lands on its page in the hub', async ({ page, request }) => {
  await demoOntology(request);
  await signIn(page, { name: 'Fork visitor', role: 'reviewer' });
  await page.goto('/def/volunteering/forks/charitybase-recurring-shifts');
  await expect(page).toHaveURL(/\/o\/volunteering\/forks\/charitybase-recurring-shifts$/);
  await settle(page);
  await expect(page.getByRole('heading', { name: 'CharityBase recurring shifts' })).toBeVisible();
});
