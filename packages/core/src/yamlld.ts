/**
 * Reading JSON-LD and YAML-LD safely.
 *
 * JSON-LD processing never touches the network here: remote contexts and
 * `@import` are refused, so a submitted document can't make the server fetch
 * URLs. YAML-LD is read under the W3C YAML-LD draft's core requirements: YAML
 * 1.2 with the Core schema only (no 1.1 booleans, timestamps or merge keys), no
 * custom tags, string mapping keys, finite numbers, an object or array at the
 * top, and the first document of a stream unless all are asked for. Input
 * size, nesting and the size after aliases are expanded are all bounded.
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

/** The JSON-LD a YAML-LD text stands for, checked against the core requirements and the budgets. */
export function yamlLdToJson(text: string, opts: YamlLdOptions = {}): unknown {
  const o = { ...DEFAULTS, ...opts };
  if (new TextEncoder().encode(text).length > o.maxBytes) throw new YamlLdError(`YAML-LD input is over ${o.maxBytes} bytes.`);
  const docs = YAML.parseAllDocuments(text, { version: '1.2', schema: 'core', merge: false, uniqueKeys: true, customTags: [], strict: true, prettyErrors: false });
  if (!Array.isArray(docs)) throw new YamlLdError('YAML-LD stream could not be read.');
  const chosen = o.extractAllScripts ? docs : docs.slice(0, 1);
  if (!chosen.length) throw new YamlLdError('YAML-LD input has no document.');
  const values = chosen.map((doc) => checked(doc, o));
  const out = o.extractAllScripts ? values.flat() : values[0];
  if (JSON.stringify(out).length > o.maxExpandedBytes) throw new YamlLdError(`YAML-LD expands to over ${o.maxExpandedBytes} bytes of JSON.`);
  return out;
}

function checked(doc: Document.Parsed, o: typeof DEFAULTS): unknown {
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) throw new YamlLdError(`YAML-LD isn't valid: ${problem.message}`);
  if (doc.directives?.yaml.explicit && doc.directives.yaml.version !== '1.2') throw new YamlLdError(`YAML-LD must be YAML 1.2, not ${doc.directives.yaml.version}.`);
  const root = doc.contents;
  if (!isMap(root) && !isSeq(root)) throw new YamlLdError('A YAML-LD document must be a mapping or a sequence.');
  // Walk the tree (not the expanded value), so aliases are counted once and depth is bounded before expansion.
  const walk = (node: Node | null, depth: number) => {
    if (!node) return;
    if (depth > o.maxDepth) throw new YamlLdError(`YAML-LD is nested more than ${o.maxDepth} levels deep.`);
    if (node.tag && !CORE_TAGS.has(node.tag)) throw new YamlLdError(`YAML-LD can't use the tag ${node.tag}.`);
    if (isAlias(node)) return;
    if (isScalar(node)) {
      if (typeof node.value === 'number' && !Number.isFinite(node.value)) throw new YamlLdError(`YAML-LD can't hold ${String(node.source ?? node.value)}: JSON has no such number.`);
      return;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isPair(pair)) continue;
        const key = pair.key as Node | null;
        if (!isScalar(key) || typeof key.value !== 'string') throw new YamlLdError(`YAML-LD mapping keys must be strings (found ${String((key as { source?: string } | null)?.source ?? key)}).`);
        walk(key, depth + 1);
        walk(pair.value as Node | null, depth + 1);
      }
      return;
    }
    if (isSeq(node)) for (const item of node.items) walk(item as Node | null, depth + 1);
  };
  walk(root, 0);
  return doc.toJS({ maxAliasCount: 100 });
}
