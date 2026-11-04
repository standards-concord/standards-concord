/**
 * Reading JSON-LD and YAML-LD safely.
 *
 * JSON-LD processing never touches the network here: remote contexts and
 * `@import` are refused, so a submitted document can't make the server fetch
 * URLs. YAML-LD is read under the W3C YAML-LD draft's core requirements: YAML
 * 1.2 with the Core schema only (no 1.1 booleans, timestamps or merge keys), no
 * custom tags, string mapping keys, finite numbers, an object, array or null at
 * the top, and the first document of a stream unless all are asked for (the
 * whole stream must be well formed either way). Input size in bytes, and the
 * nesting and JSON size of the value with its aliases resolved, are bounded
 * while it is built.
 */
import YAML, { isAlias, isMap, isPair, isScalar, isSeq, type Document, type Node } from 'yaml';

/** A JSON-LD document loader that loads nothing: every remote context or `@import` is an error. */
export const noRemoteDocuments = async (url: string): Promise<never> => {
  throw new Error(`Remote JSON-LD documents are not loaded (${url}). Put the context inline.`);
};

export interface YamlLdOptions {
  /** Read every document in a stream, as one array (JSON-LD's extractAllScripts). Otherwise only the first. */
  extractAllScripts?: boolean;
  /** Largest input, in bytes. */
  maxBytes?: number;
  /** Deepest nesting of mappings and sequences. */
  maxDepth?: number;
  /** Largest JSON the documents may expand to (aliases repeat their anchors' content). */
  maxExpandedBytes?: number;
}

const DEFAULTS = { maxBytes: 10_000_000, maxDepth: 64, maxExpandedBytes: 50_000_000 };

/** The YAML 1.2 Core schema's tags: anything else (`!!timestamp`, `!custom`) is refused. */
const CORE_TAGS = new Set(['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map((t) => `tag:yaml.org,2002:${t}`));

export class YamlLdError extends Error {}

const utf8 = new TextEncoder();
const bytes = (s: string) => utf8.encode(s).length;

/**
 * The JSON-LD a YAML-LD text stands for, checked against the core requirements
 * and the budgets. An empty stream is `null` (`[]` when reading all
 * documents), as is a document whose content is null.
 */
export function yamlLdToJson(text: string, opts: YamlLdOptions = {}): unknown {
  const o = { ...DEFAULTS, ...opts };
  if (bytes(text) > o.maxBytes) throw new YamlLdError(`YAML-LD input is over ${o.maxBytes} bytes.`);
  const docs = YAML.parseAllDocuments(text, { version: '1.2', schema: 'core', merge: false, uniqueKeys: true, customTags: [], strict: true, prettyErrors: false });
  if (!Array.isArray(docs)) throw new YamlLdError('YAML-LD stream could not be read.');
  // A malformed stream is rejected as a whole, even where only its first document is read.
  for (const doc of docs) {
    const problem = doc.errors[0] ?? doc.warnings[0];
    if (problem) throw new YamlLdError(`YAML-LD isn't valid: ${problem.message}`);
    if (doc.directives?.yaml.explicit && doc.directives.yaml.version !== '1.2') throw new YamlLdError(`YAML-LD must be YAML 1.2, not ${doc.directives.yaml.version}.`);
  }
  const budget = { left: o.maxExpandedBytes };
  if (!o.extractAllScripts) return docs.length ? construct(docs[0], o, budget) : null;
  // Every document, as one array: arrays are spliced in, and empty documents add nothing.
  return docs.flatMap((doc) => {
    const v = construct(doc, o, budget);
    return v === null ? [] : Array.isArray(v) ? v : [v];
  });
}

/**
 * Builds a document's JSON value from its syntax tree, resolving aliases.
 * Depth and output size are counted as it goes (an alias counts as everything
 * it repeats), so a small input can't build a huge value or nest past the
 * limit through aliases before it is refused.
 */
function construct(doc: Document.Parsed, o: typeof DEFAULTS, budget: { left: number }): unknown {
  const root = doc.contents;
  const spend = (n: number) => {
    budget.left -= n;
    if (budget.left < 0) throw new YamlLdError(`YAML-LD expands to over ${o.maxExpandedBytes} bytes of JSON.`);
  };
  let aliases = 0;
  const build = (node: unknown, depth: number): unknown => {
    if (node === null || node === undefined) return spend(4), null;
    if (depth > o.maxDepth) throw new YamlLdError(`YAML-LD is nested more than ${o.maxDepth} levels deep.`);
    if (isAlias(node)) {
      if (++aliases > 10_000) throw new YamlLdError('YAML-LD uses too many aliases.');
      const target = node.resolve(doc);
      if (!target) throw new YamlLdError(`YAML-LD alias *${node.source} has no anchor.`);
      // The alias stands where it is, so its content counts at this depth.
      return build(target, depth);
    }
    const n = node as Node;
    if (n.tag && !CORE_TAGS.has(n.tag)) throw new YamlLdError(`YAML-LD can't use the tag ${n.tag}.`);
    if (isScalar(n)) {
      const v = n.value;
      if (typeof v === 'number' && !Number.isFinite(v)) throw new YamlLdError(`YAML-LD can't hold ${String(n.source ?? v)}: JSON has no such number.`);
      if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new YamlLdError('YAML-LD values must be strings, numbers, booleans or null.');
      spend(v === null ? 4 : typeof v === 'string' ? bytes(JSON.stringify(v)) : String(v).length);
      return v;
    }
    if (isMap(n)) {
      spend(2);
      // Own properties only, so keys such as __proto__ are data, not a prototype.
      const out: Record<string, unknown> = {};
      for (const pair of n.items) {
        if (!isPair(pair)) continue;
        let key = pair.key as unknown;
        if (isAlias(key)) key = key.resolve(doc);
        if (!isScalar(key) || typeof key.value !== 'string') throw new YamlLdError(`YAML-LD mapping keys must be strings (found ${String((key as { source?: string } | null)?.source ?? key)}).`);
        if ((key as Node).tag && !CORE_TAGS.has((key as Node).tag!)) throw new YamlLdError(`YAML-LD can't use the tag ${(key as Node).tag}.`);
        spend(bytes(JSON.stringify(key.value)) + 2);
        Object.defineProperty(out, key.value, { value: build(pair.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    if (isSeq(n)) {
      spend(2);
      return n.items.map((item) => (spend(1), build(item, depth + 1)));
    }
    throw new YamlLdError('YAML-LD contains something JSON can’t hold.');
  };
  if (root !== null && !isMap(root) && !isSeq(root) && !(isScalar(root) && root.value === null))
    throw new YamlLdError('A YAML-LD document must be a mapping, a sequence or null.');
  return build(root, 0);
}
