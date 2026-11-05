// Starts a validation worker process (validationWorker.ts). The worker is
// TypeScript, so tsx's loader is registered here rather than relying on flags
// passed down from the server (`--import tsx` in a worker thread's execArgv
// doesn't install the loader on every Node version: 22.21 fails).
import { register } from 'tsx/esm/api';

register();
await import('./validationWorker.ts');
