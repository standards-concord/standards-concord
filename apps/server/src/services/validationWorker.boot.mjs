// Starts the validation worker (validationWorker.ts). The worker is TypeScript,
// so tsx's loader is registered here, in the worker's own thread, rather than
// relying on flags passed down from the parent: `--import tsx` in a worker's
// execArgv doesn't install the loader on every Node version (22.21 fails).
import { register } from 'tsx/esm/api';

register();
await import('./validationWorker.ts');
