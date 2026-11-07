/**
 * Content hashes for pinning ontology versions: the graph is canonicalised with RDFC-1.0 (W3C RDF
 * Dataset Canonicalization, run by sparq's Rust engine over WebAssembly), then hashed with SHA-256.
 * Two serialisations of the same graph (any syntax, prefixes, order or blank node labels) get the
 * same hash, so a federation release can pin exactly what each member said.
 */
import type { Quad } from 'n3';
import type { OntologyGraph } from './graph.js';

type SparqModule = {
  init: () => Promise<void>;
  Dataset: { fromQuads(quads: Iterable<Quad>): Promise<{ toCanonical(): string; free(): void }> };
};
let sparq: Promise<SparqModule> | undefined;
const load = () => (sparq ??= import('@sparq-org/sparq').then(async (m) => (await m.init(), m as unknown as SparqModule)));

/** The RDFC-1.0 canonical N-Quads of a set of quads. */
export async function canonicalNQuads(quads: Iterable<Quad>): Promise<string> {
  const m = await load();
  const ds = await m.Dataset.fromQuads(quads);
  try {
    return ds.toCanonical();
  } finally {
    ds.free();
  }
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** SHA-256 of a string, as lowercase hex (Web Crypto, so it runs in browsers and Node alike). */
export async function sha256Hex(text: string): Promise<string> {
  return hex(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** The graph's content hash: SHA-256 over its RDFC-1.0 canonical form, written `sha256:<hex>`. */
export async function rdfcHash(graph: OntologyGraph | Iterable<Quad>): Promise<string> {
  const quads = 'store' in graph ? graph.store.getQuads(null, null, null, null) : graph;
  return `sha256:${await sha256Hex(await canonicalNQuads(quads))}`;
}
