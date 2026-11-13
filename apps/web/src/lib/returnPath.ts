/** A sign-in destination stays on this site, including after browser URL normalisation. */
export function returnPath(value: string | null): string {
  if (!value?.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return '/';
  return value;
}
