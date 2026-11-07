import crypto from 'node:crypto';

/**
 * Secrets Concord keeps in its database, sealed (AES-256-GCM) with a key only the servers have:
 * `CONCORD_ENCRYPTION_KEY`, 32 bytes as 64 hex characters (or base64). Each use derives a key of its own (HKDF), so
 * one kind of sealed value can't be passed off as another. Without the key, nothing is sealed, and callers keep
 * such secrets in memory instead (one process: the VM).
 */
const master = (): Buffer | undefined => {
  const k = process.env.CONCORD_ENCRYPTION_KEY?.trim();
  if (!k) return undefined;
  const b = /^[0-9a-f]{64}$/i.test(k) ? Buffer.from(k, 'hex') : Buffer.from(k, 'base64');
  return b.length === 32 ? b : undefined;
};
export const sealingAvailable = () => !!master();

const keyFor = (purpose: string) => Buffer.from(crypto.hkdfSync('sha256', master()!, Buffer.alloc(0), `concord sealed: ${purpose}`, 32));

/**
 * Seals `value` (as JSON) for `purpose`. Throws without a key: check `sealingAvailable()` first. `boundTo` (additional
 * authenticated data, not stored) ties the sealed value to what it belongs to, such as an account: it only opens with
 * the same `boundTo`, so a sealed value copied to another record doesn't.
 */
export function seal(purpose: string, value: unknown, boundTo?: string): string {
  if (!master()) throw new Error('CONCORD_ENCRYPTION_KEY is not set');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  if (boundTo !== undefined) cipher.setAAD(Buffer.from(boundTo, 'utf8'));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** Opens what `seal` made for the same purpose (and `boundTo`); undefined if it was sealed otherwise, changed, or there's no key. */
export function unseal<T>(purpose: string, sealed: string, boundTo?: string): T | undefined {
  if (!master()) return undefined;
  try {
    const raw = Buffer.from(sealed, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), raw.subarray(0, 12));
    if (boundTo !== undefined) decipher.setAAD(Buffer.from(boundTo, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}
