import { afterEach, describe, expect, it } from 'vitest';
import { seal, sealingAvailable, unseal } from '../src/sealed.js';

/** Secrets kept in the database, sealed with CONCORD_ENCRYPTION_KEY (step 5: administrators' Solid logins). */
afterEach(() => {
  delete process.env.CONCORD_ENCRYPTION_KEY;
});

describe('sealed values', () => {
  it('opens only for the same purpose and key, and never once changed', () => {
    process.env.CONCORD_ENCRYPTION_KEY = '01'.repeat(32);
    expect(sealingAvailable()).toBe(true);
    const sealed = seal('admin-login', { refreshToken: 'rt-secret' });
    expect(sealed).not.toContain('rt-secret');
    expect(unseal('admin-login', sealed)).toEqual({ refreshToken: 'rt-secret' });
    expect(unseal('something-else', sealed)).toBeUndefined();
    const flipped = Buffer.from(sealed, 'base64url');
    flipped[flipped.length - 1] ^= 1;
    expect(unseal('admin-login', flipped.toString('base64url'))).toBeUndefined();
    process.env.CONCORD_ENCRYPTION_KEY = '02'.repeat(32);
    expect(unseal('admin-login', sealed)).toBeUndefined();
  });

  it('opens only for what it was bound to, and never with a cut-off tag', () => {
    process.env.CONCORD_ENCRYPTION_KEY = '01'.repeat(32);
    const sealed = seal('user-login', { refreshToken: 'rt' }, 'account a');
    expect(unseal('user-login', sealed, 'account a')).toEqual({ refreshToken: 'rt' });
    expect(unseal('user-login', sealed, 'account b')).toBeUndefined();
    expect(unseal('user-login', sealed)).toBeUndefined();
    const raw = Buffer.from(sealed, 'base64url');
    expect(unseal('user-login', raw.subarray(0, 20).toString('base64url'), 'account a')).toBeUndefined();
  });

  it('seals nothing without a key of the right length', () => {
    expect(sealingAvailable()).toBe(false);
    expect(() => seal('admin-login', {})).toThrow(/CONCORD_ENCRYPTION_KEY/);
    process.env.CONCORD_ENCRYPTION_KEY = 'too-short';
    expect(sealingAvailable()).toBe(false);
  });
});

describe('an administrator’s Solid login across instances', () => {
  it('is found by any instance for the session that signed in, and gone after sign-out', async () => {
    // Step 5 (Vercel): the login was in the memory of the instance that handled the sign-in only.
    process.env.CONCORD_ENCRYPTION_KEY = '03'.repeat(32);
    const oauth = await import('oauth4webapi');
    const { exportLogin, sessionKey } = await import('../src/solidOidc.js');
    const { adminLoginFor, endAdminLogin, SESSION_COOKIE } = await import('../src/auth.js');
    const { get, put } = await import('../src/db.js');
    const { seal } = await import('../src/sealed.js');
    const token = `session-${Date.now()}`;
    const login = { webId: 'https://admin.example/profile#me', as: { issuer: 'https://idp.example' }, client: { client_id: 'concord' }, keys: await oauth.generateKeyPair('ES256', { extractable: true }), accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 60_000 };
    // Signed in through another instance.
    await put('kv', { id: `admin-login:${sessionKey(token)}`, sealed: seal('admin-login', await exportLogin(login)), adminLoginExpires: Date.now() + 60_000 });
    const req = { cookies: { [SESSION_COOKIE]: token } } as never;
    expect(await adminLoginFor(req)).toMatchObject({ webId: login.webId, accessToken: 'at-1', sharedId: sessionKey(token) });
    expect(await adminLoginFor({ cookies: { [SESSION_COOKIE]: 'another-session' } } as never)).toBeUndefined();
    await endAdminLogin(token);
    expect(await get('kv', `admin-login:${sessionKey(token)}`)).toBeUndefined();
    expect(await adminLoginFor(req)).toBeUndefined();
  });
});

describe('an administrator’s Solid login without CONCORD_ENCRYPTION_KEY', () => {
  it('isn’t kept on a server with several instances, and reading pods says why', async () => {
    // Step 5 r1: on Vercel without the key, the login stayed in one instance's memory, so reading testers' pods
    // worked or failed depending on which instance answered. Now it's off, and says so.
    const oauth = await import('oauth4webapi');
    const { config } = await import('../src/config.js');
    const { adminLoginFor, adminLoginsKept, keepAdminLogin, SESSION_COOKIE } = await import('../src/auth.js');
    const login = { webId: 'https://admin.example/profile#me', as: { issuer: 'https://idp.example' }, client: { client_id: 'concord' }, keys: await oauth.generateKeyPair('ES256', { extractable: true }), accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 60_000 } as never;
    const saved = config.adminLoginsInMemory;
    try {
      config.adminLoginsInMemory = false;
      const token = `session-multi-${Date.now()}`;
      expect(adminLoginsKept()).toBe(false);
      expect(await keepAdminLogin(token, login)).toBe(false);
      expect(await adminLoginFor({ cookies: { [SESSION_COOKIE]: token } } as never)).toBeUndefined();
      // One long-running server keeps it in memory, as before.
      config.adminLoginsInMemory = true;
      const single = `session-single-${Date.now()}`;
      expect(await keepAdminLogin(single, login)).toBe(true);
      expect(await adminLoginFor({ cookies: { [SESSION_COOKIE]: single } } as never)).toMatchObject({ accessToken: 'at-1' });
    } finally {
      config.adminLoginsInMemory = saved;
    }
  });
});
