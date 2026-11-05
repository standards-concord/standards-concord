// Worker entry: registers tsx in the worker itself (`--import tsx` in a worker's execArgv fails on Node 22.21).
import { register } from 'tsx/esm/api';

register();
await import('./worker.ts');
