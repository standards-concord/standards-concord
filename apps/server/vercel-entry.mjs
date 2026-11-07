// The Vercel function's entry (scripts/vercel-build.mjs packages it). Plain JavaScript: it registers tsx, which
// loads Concord's TypeScript at run time, as `node --import tsx` does on the VM, then hands each request to the app.
import { register } from 'tsx/esm/api';

register();
const { waitUntil } = await import('@vercel/functions');
const { createHandler } = await import('./src/vercel.ts');

export default createHandler({ waitUntil });
