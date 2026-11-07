import type { Page } from '@playwright/test';
import { test, expect, demoOntology, expectNoCrash, signIn, uniq } from './fixtures';

/**
 * Federations (an Advanced feature): ontologies meant to be used together, each at a chosen version.
 * Concord checks them alone and together, and checks every change to a member that follows its
 * working draft against the federation ("Across federations"): advice, unless the member's owners
 * committed it to the federation.
 */

const VOL = 'https://w3id.org/odi/volunteering';

async function newOntology(page: Page, title: string) {
  const res = await page.request.post('/api/ontologies', { data: { title, description: 'Agents that work with volunteering organisations.', prefix: `fd${uniq()}` } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; namespace: string; title: string };
}

test.describe('federations', () => {
  test('the hub links to federations only with Advanced features on', async ({ page }) => {
    await signIn(page, { name: `Hub reader ${uniq()}`, role: 'contributor' });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Ontologies', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Federations' })).toHaveCount(0);
    await page.goto('/settings');
    await page.getByRole('switch', { name: 'Show advanced features' }).click();
    await page.goto('/');
    await page.getByRole('link', { name: 'Federations' }).click();
    await expect(page).toHaveURL(/\/f$/);
    await expect(page.getByRole('heading', { name: 'Federations', level: 1 })).toBeVisible();
  });

  test('someone starts a federation, adds ontologies, commits theirs, and sees what a change does to it', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: `Federation owner ${uniq()}`, role: 'owner' });
    const mine = await newOntology(page, `Volunteer agents ${uniq()}`);
    const name = `Agents together ${uniq()}`;

    await page.goto('/f');
    await page.getByRole('button', { name: 'New federation' }).click();
    const dialog = page.getByRole('dialog', { name: 'New federation' });
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByRole('button', { name: 'Create federation' }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await expect(page.getByText('Add ontologies to check them together.')).toBeVisible();

    // Add the demo ontology, pinned at its release, and my own, following its working draft.
    for (const title of [demo.title, mine.title]) {
      await page.getByLabel('Add an ontology').selectOption({ label: title });
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByRole('link', { name: title })).toBeVisible();
    }
    await page.getByLabel(`Version of ${demo.title}`).selectOption({ label: 'Release 1.0.0' });
    await expect(page.getByLabel(`Version of ${demo.title}`)).toHaveValue('1.0.0');
    await expect(page.getByText('They can be used together.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('list', { name: 'Each ontology on its own' }).getByRole('listitem')).toHaveCount(2);

    // I own my ontology, so I can commit it to the federation.
    const commit = page.getByRole('button', { name: `${mine.title} committed to this federation` });
    await expect(commit).toHaveAttribute('aria-pressed', 'false');
    await commit.click();
    await expect(page.getByRole('button', { name: `${mine.title} committed to this federation` })).toHaveAttribute('aria-pressed', 'true');

    // A change that makes a class impossible alongside the demo ontology breaks the federation.
    const res = await page.request.post(`/api/ontologies/${mine.id}/change-requests`, {
      data: {
        title: 'Something both a person and an organisation',
        description: 'Reuse the volunteering agents.',
        kind: 'feature',
        ops: [
          { op: 'addImport', iri: VOL },
          { op: 'addClass', localName: 'Hybrid', label: 'hybrid agent', definition: 'Something said to be both a person and an organisation.', subClassOf: [`${VOL}#Person`, `${VOL}#Organisation`] },
        ],
      },
    });
    expect(res.status()).toBe(201);
    const cr = (await res.json()) as { id: string };
    await page.goto(`/o/${mine.id}/changes/${cr.id}?view=checks`);
    const across = page.getByRole('button', { name: /Across federations/ });
    await expect(across).toContainText('breaks 1 of 1', { timeout: 30_000 });
    const impacts = page.getByRole('list', { name: 'Federations this change affects' });
    await expect(impacts).toContainText(name);
    await expect(impacts).toContainText('committed: breaking it fails this change');
    await expect(impacts).toContainText('With this change, hybrid agent can never have members there.');

    // The ontology's Overview says which federations it is in.
    await page.goto(`/o/${mine.id}`);
    await expect(page.getByTestId('federations-line')).toContainText(`${name} (committed)`);
    await expectNoCrash(page);
  });

  test("someone else can read a federation but not change it, or commit an ontology they don't run", async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: `Federation starter ${uniq()}`, role: 'owner' });
    const name = `Read only ${uniq()}`;
    const created = await page.request.post('/api/federations', { data: { title: name, members: [{ ontologyId: demo.id, version: '1.0.0' }] } });
    expect(created.status()).toBe(201);
    const { slug } = (await created.json()) as { slug: string };

    await signIn(page, { name: `Federation reader ${uniq()}`, role: 'contributor' });
    await page.goto(`/f/${slug}`);
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: demo.title })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Release 1.0.0' })).toBeVisible();
    await expect(page.getByLabel('Add an ontology')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /committed to this federation/ })).toHaveCount(0);
    expect((await page.request.patch(`/api/federations/${slug}`, { data: { title: 'Taken over' } })).status()).toBe(403);
    await expectNoCrash(page);
  });

  test('an owner publishes a release that pins every ontology to its content hash, at a public address', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: `Release owner ${uniq()}`, role: 'owner' });
    const mine = await newOntology(page, `Unreleased ${uniq()}`);
    const name = `Pinned set ${uniq()}`;
    const created = await page.request.post('/api/federations', { data: { title: name, members: [{ ontologyId: demo.id, version: '1.0.0' }, { ontologyId: mine.id, version: 'draft' }] } });
    const { slug } = (await created.json()) as { slug: string };

    await page.goto(`/f/${slug}`);
    const releases = page.getByRole('region', { name: 'Releases' });
    // A member following its working draft can't be pinned.
    await expect(releases.getByRole('list', { name: 'What stands in the way of a release' })).toContainText(`${mine.title} follows its working draft`, { timeout: 30_000 });
    await page.getByRole('button', { name: `Remove ${mine.title}` }).click();
    await expect(page.getByRole('link', { name: mine.title })).toHaveCount(0);

    await expect(releases.getByText(/Suggested: 1\.0\.0/)).toBeVisible({ timeout: 30_000 });
    await releases.getByLabel('Notes (optional)').fill('First pinned set');
    await releases.getByRole('button', { name: 'Publish release' }).click();
    const list = releases.getByRole('list', { name: 'Federation releases' });
    await expect(list.getByRole('link', { name: '1.0.0' })).toBeVisible();
    await expect(list).toContainText('First pinned set');
    await expect(list).toContainText(`${demo.title} 1.0.0`);

    // The manifest is public Turtle: an ontology that imports the frozen closure, listing the pinned version and its hash.
    const manifest = await request.get(`/def/fed/${slug}/1.0.0`);
    expect(manifest.status()).toBe(200);
    expect(manifest.headers()['content-type']).toContain('text/turtle');
    const ttl = await manifest.text();
    expect(ttl).toMatch(new RegExp(`owl:imports <[^>]*/def/fed/${slug}/1\\.0\\.0/closure>`));
    expect(ttl).toContain('dcterms:hasPart <https://w3id.org/odi/volunteering/1.0.0>');
    expect(ttl).toMatch(/spdx:checksumValue "[0-9a-f]{64}"/);
    expect((await request.get(`/def/fed/${slug}/1.0.0/shapes`)).status()).toBe(200);
    await expect(list.getByRole('link', { name: 'frozen closure' })).toHaveAttribute('href', `/def/fed/${slug}/1.0.0/closure`);
    const closure = await request.get(`/def/fed/${slug}/1.0.0/closure`);
    expect(closure.status()).toBe(200);
    expect(await closure.text()).not.toContain('owl:imports');

    // Someone else sees the releases but can't publish one.
    await signIn(page, { name: `Release reader ${uniq()}`, role: 'contributor' });
    await page.goto(`/f/${slug}`);
    await expect(page.getByRole('region', { name: 'Releases' }).getByRole('link', { name: '1.0.0' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish release' })).toHaveCount(0);
    await expectNoCrash(page);
  });

  test('a federation extends another and is compared with it term by term', async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: `Sub-federation owner ${uniq()}`, role: 'owner' });
    const mine = await newOntology(page, `Financial agents ${uniq()}`);
    const parentName = `Government ${uniq()}`;
    const childName = `Financial services ${uniq()}`;
    const parent = (await (await page.request.post('/api/federations', { data: { title: parentName, members: [{ ontologyId: demo.id, version: '1.0.0' }] } })).json()) as { slug: string };
    const child = (await (await page.request.post('/api/federations', { data: { title: childName, members: [{ ontologyId: demo.id, version: '1.0.0' }, { ontologyId: mine.id, version: 'draft' }] } })).json()) as { slug: string };

    await page.goto(`/f/${child.slug}`);
    await page.getByLabel('Extends (optional)').selectOption({ label: parentName });
    await expect(page.getByTestId('federation-family')).toContainText(`Extends ${parentName}.`);
    // Compare starts with the parent: every shared term is kept as it is.
    await expect(page.getByLabel('Compare with')).toHaveValue(parent.slug);
    await expect(page.getByTestId('agreement')).toContainText(`${childName} agrees with ${parentName} on`, { timeout: 30_000 });
    await expect(page.getByTestId('agreement')).toContainText('data written for one is right for the other on all of them');
    await page.getByRole('button', { name: /^The same/ }).click();
    await expect(page.getByRole('list', { name: 'The same' }).getByText('https://w3id.org/odi/volunteering#Person', { exact: true })).toBeVisible();

    // The parent lists what extends it; someone else can't change what it extends.
    await signIn(page, { name: `Sub-federation reader ${uniq()}`, role: 'contributor' });
    await page.goto(`/f/${parent.slug}`);
    await expect(page.getByTestId('federation-family')).toContainText(`Extended by ${childName}.`);
    await expect(page.getByLabel('Extends (optional)')).toHaveCount(0);
    await expectNoCrash(page);
  });

  test("a development fork's choices are proposed back, and only the original's owners accept them", async ({ page, request }) => {
    const demo = await demoOntology(request);
    await signIn(page, { name: `Original owner ${uniq()}`, role: 'owner' });
    const ownerCookies = await page.context().cookies();
    const name = `Shared agents ${uniq()}`;
    const original = (await (await page.request.post('/api/federations', { data: { title: name, members: [{ ontologyId: demo.id, version: '1.0.0' }] } })).json()) as { slug: string };

    // Someone else forks it to try adding their ontology, then proposes that back.
    await signIn(page, { name: `Forker ${uniq()}`, role: 'contributor' });
    const theirs = await newOntology(page, `Lending agents ${uniq()}`);
    await page.goto(`/f/${original.slug}`);
    await page.getByRole('button', { name: 'Fork', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Fork this federation' });
    await expect(dialog.getByLabel('Kind of fork')).toHaveValue('development');
    await dialog.getByRole('button', { name: 'Create fork' }).click();
    await expect(page.getByRole('heading', { name: `${name} (fork)`, level: 1 })).toBeVisible();
    await expect(page.getByTestId('federation-family')).toContainText(`A development fork of ${name}.`);
    await page.getByLabel('Add an ontology').selectOption({ label: theirs.title });
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('link', { name: theirs.title })).toBeVisible();
    await page.getByLabel('Note for its owners (optional)').fill('Lenders use these agents too');
    await page.getByRole('button', { name: 'Propose back' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Proposed.' })).toBeVisible();

    // A third person sees the proposal on the original, but can't decide it.
    await signIn(page, { name: `Onlooker ${uniq()}`, role: 'contributor' });
    await page.goto(`/f/${original.slug}`);
    const proposals = page.getByRole('list', { name: 'Proposals from forks' });
    await expect(proposals).toContainText(`adds ${theirs.title} (its working draft)`);
    await expect(proposals).toContainText('Lenders use these agents too');
    await expect(proposals.getByRole('button', { name: 'Accept' })).toHaveCount(0);

    // The original's owner accepts it, and the ontology joins the original.
    await page.context().clearCookies();
    await page.context().addCookies(ownerCookies);
    await page.goto(`/f/${original.slug}`);
    await page.getByRole('list', { name: 'Proposals from forks' }).getByRole('button', { name: 'Accept' }).click();
    await expect(page.getByRole('list', { name: 'Proposals from forks' })).toContainText('Accepted');
    await expect(page.getByRole('link', { name: theirs.title })).toBeVisible();
    await expectNoCrash(page);
  });

  // The UK financial services / UK government example: a sub-federation tries a term in an ontology's
  // development fork, then hands it upstream to an ontology of the federation it extends.
  test('a sub-federation hands a settled term upstream as a change request, and only its owners can', async ({ page }) => {
    await signIn(page, { name: `Upstream owner ${uniq()}`, role: 'owner' });
    const gov = await newOntology(page, `Government agents ${uniq()}`);
    const fin = await newOntology(page, `Finance agents ${uniq()}`);
    const fork = (await (await page.request.post(`/api/ontologies/${fin.id}/forks`, { data: { name: 'lenders' } })).json()) as { slug: string };
    const edit = await page.request.post(`/api/ontologies/${fin.id}/forks/${fork.slug}/edits`, {
      data: { ops: [{ op: 'addClass', localName: 'Lender', label: 'lender', definition: 'An organisation that lends money to good causes.' }] },
    });
    expect(edit.status()).toBe(200);
    const parentName = `Government ${uniq()}`;
    const childName = `Financial services ${uniq()}`;
    const parent = (await (await page.request.post('/api/federations', { data: { title: parentName, members: [{ ontologyId: gov.id, version: 'draft' }] } })).json()) as { id: string };
    const child = (await (await page.request.post('/api/federations', { data: { title: childName, parentId: parent.id, members: [{ ontologyId: gov.id, version: 'draft' }, { ontologyId: fin.id, version: 'draft' }] } })).json()) as { slug: string };

    await page.goto(`/f/${child.slug}`);
    const upstream = page.getByRole('region', { name: 'Hand terms upstream' });
    await expect(upstream.getByText(`Every term here is already in ${parentName}.`)).toBeVisible({ timeout: 30_000 });
    // Use the finance ontology's fork, where the new term is being tried.
    await page.getByLabel(`Version of ${fin.title}`).selectOption({ label: 'Fork lenders' });
    await expect(page.getByLabel(`Version of ${fin.title}`)).toHaveValue(`fork:${fork.slug}`);
    await upstream.getByRole('checkbox', { name: /lender/ }).check({ timeout: 30_000 });
    await upstream.getByLabel('Propose to').selectOption({ label: gov.title });
    await upstream.getByRole('button', { name: 'Propose upstream' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${gov.id}/changes/`));
    await expect(page.getByRole('heading', { name: `Adopt a term from ${childName}` })).toBeVisible();
    await expect(page.getByRole('link', { name: 'view federation' })).toBeVisible();

    // Someone else sees what was handed up, but can't hand anything up themselves.
    await signIn(page, { name: `Upstream onlooker ${uniq()}`, role: 'contributor' });
    await page.goto(`/f/${child.slug}`);
    const handed = page.getByRole('list', { name: 'Terms handed upstream' });
    await expect(handed).toContainText('Lender');
    await expect(handed.getByRole('link', { name: new RegExp(gov.title) })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Fork lenders' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Propose upstream' })).toHaveCount(0);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    expect((await page.request.post(`/api/federations/${child.slug}/upstream`, { data: { ontologyId: gov.id, terms: [`${fin.namespace}Lender`] } })).status()).toBe(403);
    await expectNoCrash(page);
  });
});
