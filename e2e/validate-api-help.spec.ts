import type { Locator, Page } from '@playwright/test';
import { test, expect, signIn, settle } from './fixtures';

/**
 * "Validate from your own code" on the Validate data page: the curl examples are
 * syntax-highlighted like every other code view, and the section's text and code line
 * up with the card's title instead of running into the card's edges.
 *
 * What used to go wrong: the examples were rendered with no highlighting (as plain text),
 * each one a box nested inside another box, and the section body had no padding, so its
 * text and code sat flush against the card's left edge, out of line with the title.
 */

const TOLERANCE = 1;
const EXAMPLES = ['Validate a file (JSON report)', 'Get a SHACL validation report in Turtle', 'Get the SHACL shapes by content negotiation'];

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error(`no bounding box for ${l}`);
  return b;
}

async function openHelp(page: Page) {
  await page.goto('/o/volunteering/validate');
  await settle(page);
  const toggle = page.getByRole('button', { name: /Validate from your own code/ });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return page.locator('#validate-api');
}

async function expectHighlightedAndAligned(page: Page, baseURL: string) {
  const card = await openHelp(page);
  const title = card.getByRole('button', { name: /Validate from your own code/ });
  const intro = card.getByText('POST RDF to the ontology’s address');

  // The key facts are a list of terms, not one long paragraph.
  const facts = card.getByTestId('validate-api-facts');
  for (const term of ['Address', 'Body', 'Answer', 'Status', 'Limits']) await expect(facts.getByRole('term').filter({ hasText: new RegExp(`^${term}$`) })).toBeVisible();
  await expect(facts).toContainText(`${baseURL}/def/volunteering/1.0.0`);

  for (const name of EXAMPLES) {
    const example = card.getByRole('region', { name });
    await expect(example).toBeVisible();
    await expect(card.getByRole('heading', { level: 4, name })).toBeVisible();
    // Highlighted as shell: the command, its flags and the URL each get a colour.
    await expect(example.locator('.tok-func', { hasText: /^curl$/ })).toHaveCount(1);
    await expect(example.locator('.tok-attr', { hasText: /^-H$/ }).first()).toBeVisible();
    await expect(example.locator('.tok-iri', { hasText: `${baseURL}/def/volunteering/1.0.0` })).toBeVisible();
    await expect(example.locator('.tok-string').first()).toBeVisible();
    // One box per example, not a box inside a box: between the code and its example's section, only one element has a border.
    const bordered = await example.evaluate((el) => {
      const out: string[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const css = getComputedStyle(n);
        if (parseFloat(css.borderTopWidth) > 0 || parseFloat(css.borderLeftWidth) > 0) out.push(n.tagName);
        if (n.tagName === 'SECTION') break;
      }
      return out;
    });
    expect(bordered, `bordered boxes around "${name}"`).toEqual(['DIV']);
  }
  await expect(card.getByRole('region', { name: EXAMPLES[0] }).locator('.tok-keyword', { hasText: /^POST$/ })).toBeVisible();
  await expect(card.getByRole('region', { name: EXAMPLES[0] }).locator('.tok-variable', { hasText: /^@data\.ttl$/ })).toBeVisible();

  // The text and the code start in the same column as the card's title, inset from the card's edge.
  const [bCard, bTitle, bIntro] = [await box(card), await box(title), await box(intro)];
  expect(bTitle.x - bCard.x, 'title is inset from the card edge').toBeGreaterThan(8);
  expect(Math.abs(bIntro.x - bTitle.x), `intro at ${bIntro.x}, title at ${bTitle.x}`).toBeLessThanOrEqual(TOLERANCE);
  for (const name of EXAMPLES) {
    const bCode = await box(card.getByRole('region', { name }).locator('xpath=..'));
    expect(Math.abs(bCode.x - bTitle.x), `${name}: code box at ${bCode.x}, title at ${bTitle.x}`).toBeLessThanOrEqual(TOLERANCE);
    expect(bCard.x + bCard.width - (bCode.x + bCode.width), `${name}: code box is inset from the right edge too`).toBeGreaterThan(8);
  }
}

test.describe('Validate from your own code', () => {
  test('an editor sees highlighted curl examples that line up with the card title', async ({ page, baseURL }) => {
    await signIn(page, { name: 'API help editor', role: 'editor' });
    await expectHighlightedAndAligned(page, baseURL!);
  });

  // The API needs no sign-in, so its help isn't limited to members either.
  test('a contributor sees the same help, and Copy gives a one-line command', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signIn(page, { name: 'API help contributor', role: 'contributor' });
    await expectHighlightedAndAligned(page, baseURL!);
    const iri = `${baseURL}/def/volunteering/1.0.0`;
    const oneLine = [
      `curl -X POST ${iri} -H 'Content-Type: text/turtle' --data-binary @data.ttl`,
      `curl -X POST ${iri} -H 'Content-Type: application/ld+json' -H 'Accept: text/turtle' --data-binary @data.jsonld`,
      `curl ${iri} -H 'Accept-Profile: <http://www.w3.org/ns/shacl#>'`,
    ];
    for (const [i, name] of EXAMPLES.entries()) {
      await page.getByRole('region', { name }).locator('xpath=..').getByRole('button', { name: 'Copy' }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { message: name }).toBe(oneLine[i]);
    }
  });
});
