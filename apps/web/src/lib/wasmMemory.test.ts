import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { withMemoryLimit } from './wasmMemory';

const require = createRequire(import.meta.url);

describe('capping a WebAssembly module’s memory', () => {
  it('caps sparq’s engine, which otherwise may grow to 4 GB, and the result still compiles', () => {
    const bytes = new Uint8Array(readFileSync(require.resolve('@sparq-org/sparq/wasm/sparq_wasm_bg.wasm'))) as Uint8Array<ArrayBuffer>;
    const capped = withMemoryLimit(bytes, 64);
    expect(capped).not.toBe(bytes);
    expect(WebAssembly.validate(capped)).toBe(true);
  });

  it('rewrites the limits of a memory without a maximum, and leaves others alone', () => {
    // (module (memory 1)) and (module (memory 1 2)), hand-assembled.
    const open = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, 3, 1, 0, 1]);
    const capped = withMemoryLimit(open, 1);
    expect(WebAssembly.validate(capped)).toBe(true);
    const m = new WebAssembly.Instance(new WebAssembly.Module(capped)).exports;
    expect(m).toEqual({});
    expect([...capped.subarray(8)]).toEqual([5, 4, 1, 1, 1, 16]);
    const big = withMemoryLimit(open, 1024);
    expect([...big.subarray(8)]).toEqual([5, 6, 1, 1, 1, 0x80, 0x80, 0x01]);
    const shared = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, 4, 1, 3, 1, 2]);
    expect(withMemoryLimit(shared, 1)).toBe(shared);
  });
});
