/**
 * A copy of a WebAssembly module whose own memory may grow only to `mib`
 * megabytes (WebAssembly's default ceiling is 4 GB). Past it, the engine's
 * allocations fail and it stops with an error, which the query worker reports.
 * Only a module that defines its memory (rather than importing it) is changed,
 * by rewriting the limits in its memory section; anything else is returned as is.
 */

const PAGE = 64 * 1024;

function readLeb(b: Uint8Array, at: number): [value: number, next: number] {
  let value = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = b[at++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [value, at];
}

function leb(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

export function withMemoryLimit(bytes: Uint8Array<ArrayBuffer>, mib: number): Uint8Array<ArrayBuffer> {
  const maxPages = Math.floor((mib * 1024 * 1024) / PAGE);
  let at = 8; // magic and version
  while (at < bytes.length) {
    const id = bytes[at];
    const [size, payload] = readLeb(bytes, at + 1);
    if (id === 5) {
      const [count, first] = readLeb(bytes, payload);
      const flags = bytes[first];
      // One plain 32-bit memory (not shared, not 64-bit): rewrite its limits as min and max.
      if (count !== 1 || flags > 1) return bytes;
      const [min, afterMin] = readLeb(bytes, first + 1);
      const end = flags & 1 ? readLeb(bytes, afterMin)[1] : afterMin;
      if (end !== payload + size) return bytes;
      const body = [...leb(1), 0x01, ...leb(min), ...leb(Math.max(min, maxPages))];
      return Uint8Array.from([...bytes.subarray(0, at), 5, ...leb(body.length), ...body, ...bytes.subarray(payload + size)]);
    }
    at = payload + size;
  }
  return bytes;
}
