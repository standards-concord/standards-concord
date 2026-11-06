import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { listRoles, ringRoles } from './format';
import { RoleRingLegend } from '../components/badges';

describe('ringRoles', () => {
  it('keeps only owner, steward and ODI oversight, most senior first', () => {
    expect(ringRoles(['odi', 'editor', 'steward', 'member'])).toEqual(['steward', 'odi']);
    expect(ringRoles(['reviewer', 'member', 'contributor', 'agent'])).toEqual([]);
    expect(ringRoles(undefined)).toEqual([]);
  });

  it('counts someone listed only in ownerIds as an owner, once', () => {
    expect(ringRoles(['editor'], true)).toEqual(['owner']);
    expect(ringRoles(['owner', 'steward'], true)).toEqual(['owner', 'steward']);
  });
});

describe('listRoles', () => {
  it('joins role labels in plain English', () => {
    expect(listRoles([])).toBe('');
    expect(listRoles(['owner'])).toBe('Owner');
    expect(listRoles(['owner', 'steward'])).toBe('Owner and Steward');
    expect(listRoles(['owner', 'steward', 'odi'])).toBe('Owner, Steward and ODI oversight');
  });
});

describe('RoleRingLegend', () => {
  it('shows nothing when no rings are on show', () => {
    expect(renderToStaticMarkup(<RoleRingLegend roles={[]} />)).toBe('');
  });

  it('lists each ring colour on show once, in seniority order', () => {
    const html = renderToStaticMarkup(<RoleRingLegend roles={['odi', 'owner', 'odi']} />);
    expect([...html.matchAll(/<\/span>([^<]+)<\/li>/g)].map((m) => m[1])).toEqual(['Owner', 'ODI oversight']);
  });
});
