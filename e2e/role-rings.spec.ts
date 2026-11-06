import type { BrowserContext, Locator, Page } from '@playwright/test';
import { test, expect, expectNoCrash, personas, settle, signIn, uniq } from './fixtures';

/**
 * Role rings: in an ontology's member avatars, owners, the steward (who chairs) and ODI
 * oversight get a coloured ring in their most senior role's colour, with a one-line key
 * under the avatars. Everyone else has no ring. The ring colours are each look's own tokens
 * (--role-owner, --role-steward, --role-odi in index.css); looks.spec.ts checks their contrast.
 *
 * It uses its own ontology, so changing roles doesn't touch the shared demo one.
 */

let ontologyId = '';
const owner = { name: `Ring owner ${uniq()}`, role: 'steward' };
let ownerCookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
const people: Record<'tom' | 'gareth' | 'daniel', string> = { tom: '', gareth: '', daniel: '' };

async function asOwner(page: Page) {
  if (!ownerCookies.length) {
    await signIn(page, owner);
    ownerCookies = await page.context().cookies();
  } else {
    await page.context().clearCookies();
    await page.context().addCookies(ownerCookies);
  }
}

const membersList = (page: Page) => page.getByRole('list', { name: 'Members' });
const legend = (page: Page) => page.getByRole('list', { name: 'Ring colours' });
const memberRow = (page: Page, name: string) => page.locator('#roles').locator('div.flex-wrap.items-start').filter({ hasText: name });

/** The avatar's outline colour, and the colour its role token resolves to, as computed rgb() strings. */
async function ringColour(avatar: Locator) {
  return avatar.evaluate((el) => {
    const ring = el.getAttribute('data-role-ring');
    const probe = document.createElement('span');
    probe.style.color = `var(--role-${ring})`;
    document.body.appendChild(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    const cs = getComputedStyle(el);
    return { ring, outline: cs.outlineColor, style: cs.outlineStyle, width: cs.outlineWidth, token };
  });
}

// These share one ontology and build on each other, so they run in order.
test.describe('rings on an ontology', () => {
  test.describe.configure({ mode: 'serial' });

  test('setup: an owner makes an ontology with an editor and someone from ODI oversight', async ({ page }) => {
    await asOwner(page);
    const created = await page.request.post('/api/ontologies', { data: { title: `Ring test ${uniq()}`, prefix: `rg${uniq()}`, description: 'Role rings on member avatars' } });
    expect(created.ok(), await created.text()).toBeTruthy();
    ontologyId = ((await created.json()) as { id: string }).id;
    const all = await personas(page.request);
    const id = (name: string) => all.find((p) => p.name === name)!.id;
    people.tom = id('Tom Okafor');
    people.gareth = id('Gareth Lewis');
    people.daniel = id('Daniel Brooks');
    for (const [userId, roles] of [
      [people.tom, ['editor', 'reviewer']],
      [people.gareth, ['reviewer', 'member']],
      [people.daniel, ['odi', 'reviewer']],
    ] as const) {
      const r = await page.request.put(`/api/ontologies/${ontologyId}/members/${userId}`, { data: { roles } });
      expect(r.ok(), await r.text()).toBeTruthy();
    }
  });

  test('owners and ODI oversight get a coloured ring with a key; other members get none', async ({ page }) => {
    await asOwner(page);
    await page.goto(`/o/${ontologyId}`);
    await settle(page);
    await expectNoCrash(page);
    const list = membersList(page);

    // The owner holds owner and steward: the ring is the owner's colour, and the name (the tooltip) says both.
    const me = list.getByRole('img', { name: `${owner.name}, Owner and Steward` });
    await expect(me).toHaveAttribute('data-role-ring', 'owner');
    await expect(me).toHaveAttribute('title', `${owner.name}, Owner and Steward`);
    const mine = await ringColour(me);
    expect(mine.style).toBe('solid');
    expect(mine.width).toBe('2px');
    expect(mine.outline).toBe(mine.token);

    const daniel = list.getByRole('img', { name: 'Daniel Brooks (simulated), ODI oversight' });
    await expect(daniel).toHaveAttribute('data-role-ring', 'odi');
    const odi = await ringColour(daniel);
    expect(odi.outline).toBe(odi.token);
    expect(odi.outline).not.toBe(mine.outline);

    // Editors, reviewers and voting members have no ring of any kind and no roles in their name. (Simulated
    // members used to keep a thin grey box-shadow ring, which in the Civic look is the steward's colour.)
    for (const look of ['odi', 'civic']) {
      await page.goto(`/o/${ontologyId}?look=${look}`);
      await settle(page);
      for (const name of ['Tom Okafor (simulated)', 'Gareth Lewis (simulated)']) {
        const avatar = list.getByRole('img', { name, exact: true });
        await expect(avatar).toBeVisible();
        await expect(avatar).not.toHaveAttribute('data-role-ring');
        const cs = await avatar.evaluate((el) => ({ outline: getComputedStyle(el).outlineStyle, shadow: getComputedStyle(el).boxShadow }));
        expect(cs, `${name} in ${look}`).toEqual({ outline: 'none', shadow: 'none' });
      }
    }
    await page.goto(`/o/${ontologyId}?look=odi`);
    await settle(page);

    // The key lists only the ring colours on show: no steward ring is shown, since the owner's ring wins.
    await expect(legend(page).getByRole('listitem')).toHaveText(['Owner', 'ODI oversight']);
    await expect(legend(page).getByRole('listitem').first()).toHaveAttribute('title', /Accountable for the ontology/);
  });

  test('the owner makes someone steward, and their ring appears in the steward colour', async ({ page }) => {
    await asOwner(page);
    await page.goto(`/o/${ontologyId}/governance#roles`);
    await settle(page);
    const row = memberRow(page, 'Gareth Lewis');
    await row.getByRole('button', { name: 'Edit roles' }).click();
    await row.getByRole('button', { name: 'Steward', exact: true }).click();
    // Here the name and role chips are written out beside the avatar, so screen readers skip it; the tooltip stays.
    const avatar = row.locator('[data-avatar]');
    await expect(avatar).toHaveAttribute('data-role-ring', 'steward');
    await expect(avatar).toHaveAttribute('aria-hidden', 'true');
    await expect(avatar).toHaveAttribute('title', 'Gareth Lewis (simulated), Steward');
    await row.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('link', { name: 'Overview' }).first().click();
    await settle(page);
    const gareth = membersList(page).getByRole('img', { name: 'Gareth Lewis (simulated), Steward' });
    await expect(gareth).toHaveAttribute('data-role-ring', 'steward');
    const steward = await ringColour(gareth);
    expect(steward.outline).toBe(steward.token);
    const ownerRing = await ringColour(membersList(page).getByRole('img', { name: `${owner.name}, Owner and Steward` }));
    expect(steward.outline).not.toBe(ownerRing.outline);
    await expect(legend(page).getByRole('listitem')).toHaveText(['Owner', 'Steward', 'ODI oversight']);
  });

  test('a contributor sees the same rings but cannot change anyone’s role', async ({ page }) => {
    await signIn(page, { name: `Ring viewer ${uniq()}`, role: 'contributor' });
    await page.goto(`/o/${ontologyId}`);
    await settle(page);
    await expect(membersList(page).getByRole('img', { name: /^Ring owner .*, Owner and Steward$/ })).toHaveAttribute('data-role-ring', 'owner');
    await expect(membersList(page).getByRole('img', { name: 'Gareth Lewis (simulated), Steward' })).toHaveAttribute('data-role-ring', 'steward');
    await expect(legend(page).getByRole('listitem')).toHaveText(['Owner', 'Steward', 'ODI oversight']);
    await expect(page.getByRole('link', { name: 'View members' })).toBeVisible();

    await page.goto(`/o/${ontologyId}/governance#roles`);
    await settle(page);
    await expect(memberRow(page, 'Daniel Brooks').locator('[data-avatar]')).toHaveAttribute('data-role-ring', 'odi');
    await expect(page.getByRole('button', { name: 'Edit roles' })).toHaveCount(0);
    // The role chips use the ring colours, so a ring and its chip read the same. (ODI oversight's chip
    // used to be amber, the owner ring's colour.)
    const chipAndToken = (row: Locator, text: string, token: string) =>
      row.getByText(text, { exact: true }).evaluate((el, t) => {
        const probe = document.createElement('span');
        probe.style.color = `var(--${t})`;
        document.body.appendChild(probe);
        const want = getComputedStyle(probe).color;
        probe.remove();
        return [getComputedStyle(el).color, want];
      }, token);
    for (const [row, chip, token] of [
      [memberRow(page, owner.name), 'Owner', 'role-owner'],
      [memberRow(page, owner.name), 'Steward', 'role-steward'],
      [memberRow(page, 'Daniel Brooks'), 'ODI oversight', 'role-odi'],
    ] as const) {
      const [colour, ring] = await chipAndToken(row, chip, token);
      expect(colour, chip).toBe(ring);
    }
    const r = await page.request.put(`/api/ontologies/${ontologyId}/members/${people.tom}`, { data: { roles: ['steward'] } });
    expect(r.status()).toBe(403);
  });

  test('taking away someone’s last ring role takes away their ring and its entry in the key', async ({ page }) => {
    await asOwner(page);
    await page.goto(`/o/${ontologyId}/governance#roles`);
    await settle(page);
    const row = memberRow(page, 'Gareth Lewis');
    await row.getByRole('button', { name: 'Edit roles' }).click();
    await row.getByRole('button', { name: 'Steward', exact: true }).click();
    await expect(row.locator('[data-avatar]')).not.toHaveAttribute('data-role-ring');
    await row.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('link', { name: 'Overview' }).first().click();
    await settle(page);
    await expect(membersList(page).getByRole('img', { name: 'Gareth Lewis (simulated)', exact: true })).not.toHaveAttribute('data-role-ring');
    await expect(legend(page).getByRole('listitem')).toHaveText(['Owner', 'ODI oversight']);
  });
});

test('the three ring colours are told apart in every look, light and dark', async ({ page }) => {
  await page.goto('/login');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const look of ['odi', 'spec', 'civic', 'workbench', 'classic']) {
      await page.evaluate((l) => (document.documentElement.dataset.look = l), look);
      const colours = await page.evaluate(() =>
        ['owner', 'steward', 'odi'].map((role) => {
          const probe = document.createElement('span');
          probe.style.color = `var(--role-${role})`;
          document.body.appendChild(probe);
          const [r, g, b] = getComputedStyle(probe).color.match(/[\d.]+/g)!.map((n) => Number(n) / 255);
          probe.remove();
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const d = max - min;
          const l = (max + min) / 2;
          const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
          const hue = d === 0 ? 0 : max === r ? (((g - b) / d) % 6) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
          const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
          return { hue: (hue + 360) % 360, sat, lum: 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) };
        }),
      );
      // Each pair differs clearly in hue (both coloured, at least 40° apart) or in lightness (civic's black steward ring).
      for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++) {
          const [a, b] = [colours[i], colours[j]];
          const hueGap = Math.min(Math.abs(a.hue - b.hue), 360 - Math.abs(a.hue - b.hue));
          const bothColoured = a.sat > 0.25 && b.sat > 0.25;
          const [hi, lo] = [a.lum, b.lum].sort((x, y) => y - x);
          const contrast = (hi + 0.05) / (lo + 0.05);
          expect(bothColoured ? hueGap >= 40 || contrast >= 1.5 : contrast >= 1.5, `${look} ${scheme}: rings ${i} and ${j} (${JSON.stringify([a, b])})`).toBe(true);
        }
    }
  }
});
