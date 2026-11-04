/**
 * JavaScript and TypeScript classes for an ontology, generated from its SHACL
 * node shapes with the ODI SHACL → TypeScript converter
 * (@theodi/shacl-converter) over @rdfjs/wrapper. Each node shape becomes a
 * class whose accessors read and write the underlying RDF, and one dataset
 * wrapper finds the instances of every class.
 *
 * The converter writes one file per class; here its output is joined into a
 * single module, so an app can import the classes straight from the ontology's
 * URI, and packaged as an npm tarball for apps that use a bundler.
 */
import { Store, DataFactory } from 'n3';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { NS, RDF_TYPE, localName } from './ns.js';
import { literal, nn, typedLit } from './rdf.js';
import type { OntologyGraph } from './graph.js';
import { deriveShapes, type DerivedShapes } from './shacl.js';
import { codeModel, identifierFrom, JS_KEYWORDS, RESERVED_CLASSES, THING, type CodeModel } from './codemodel.js';

const SH = NS.sh;
const XSD = NS.xsd;
const require = createRequire(import.meta.url);

/** A dependency's version, from the package.json above its entry point (neither package exports ./package.json). */
function packageVersion(name: string, entry = name): string {
  let dir = path.dirname(require.resolve(entry));
  while (dir !== path.dirname(dir)) {
    const file = path.join(dir, 'package.json');
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      if (pkg.name === name) return pkg.version;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`cannot find the version of ${name}`);
}

/** The @rdfjs/wrapper version the generated code is written against. */
export const WRAPPER_VERSION = packageVersion('@rdfjs/wrapper');
const CONVERTER_VERSION = packageVersion('@theodi/shacl-converter', '@theodi/shacl-converter/dist/generator/class-generator.js');
/** Where the browser module imports @rdfjs/wrapper from by default (an ES module CDN, so no bundler is needed). */
export const WRAPPER_CDN = `https://cdn.jsdelivr.net/npm/@rdfjs/wrapper@${WRAPPER_VERSION}/+esm`;

export interface CodegenOptions {
  /** Name the dataset wrapper and package after this, e.g. the ontology slug ('volunteering' → VolunteeringDataset). */
  name?: string;
  /** Version string for the header and the package (defaults to owl:versionInfo). */
  version?: string;
  /** The IRI the module was fetched from, for the header. */
  sourceUrl?: string;
}

export interface GeneratedClass {
  name: string;
  classIRI: string;
  shapeIRI: string;
  extends?: string;
  properties: { name: string; path: string }[];
  /** The dataset wrapper's getter for this class's instances (none for the Thing wrapper). */
  datasetGetter?: string;
}

export interface GeneratedModule {
  /** TypeScript source. */
  ts: string;
  /** JavaScript (an ES module) importing @rdfjs/wrapper by its bare name, for bundlers and Node. */
  js: string;
  /** Type declarations for `js`. */
  dts: string;
  classes: GeneratedClass[];
  datasetClass: string;
  /** Constraints in the shapes that the classes can't express exactly. */
  notes: string[];
  ontology: { iri?: string; versionIRI?: string; version?: string; namespace: string };
}

/** Rewrites the bare @rdfjs/wrapper import, e.g. to a CDN for use in a browser without a bundler. */
export function withWrapperImport(code: string, specifier: string = WRAPPER_CDN): string {
  return code.replace(/from "@rdfjs\/wrapper";/g, () => `from ${JSON.stringify(specifier)};`);
}

/** Datatypes whose converter mapping is exact; every other datatype gets a typed-literal writer (see `literalWriter`). */
const EXACT_WRITERS = new Set([XSD + 'string', XSD + 'boolean', XSD + 'integer', XSD + 'double', NS.rdf + 'langString']);

/**
 * The shapes the converter works from, one per class in the code model (see
 * codemodel.ts): sh:codeIdentifier on every shape and property, the declared
 * accessors only (inherited ones come from the base class), class-valued
 * properties pointing (sh:node) at the shape of their class, and sh:and for
 * the base class.
 */
function converterShapes(derived: DerivedShapes): { store: Store; model: CodeModel; classes: GeneratedClass[]; thing?: GeneratedClass; datatypes: Map<string, Map<string, string>> } {
  const model = codeModel(derived, derived.propertyInfo);
  const store = new Store();
  const add = (s: any, p: string, o: any) => store.addQuad(s, nn(p), o);
  const int = (n: number) => typedLit(String(n), XSD + 'integer');
  const thingShape = `${derived.shapesNs}__Thing`;
  const classes: GeneratedClass[] = [];
  const datatypes = new Map<string, Map<string, string>>();

  for (const c of model.classes) {
    const shape = nn(c.shapeIRI);
    add(shape, RDF_TYPE, nn(SH + 'NodeShape'));
    add(shape, SH + 'targetClass', nn(c.targetClass));
    add(shape, SH + 'codeIdentifier', literal(c.name));
    if (c.base) {
      const list = DataFactory.blankNode();
      add(shape, SH + 'and', list);
      add(list, NS.rdf + 'first', nn(c.base));
      add(list, NS.rdf + 'rest', nn(NS.rdf + 'nil'));
    }
    const dts = new Map<string, string>();
    for (const p of c.declared) {
      const b = DataFactory.blankNode();
      add(shape, SH + 'property', b);
      add(b, SH + 'path', nn(p.path));
      add(b, SH + 'codeIdentifier', literal(p.name));
      add(b, SH + 'name', literal(p.name));
      if (p.node) add(b, SH + 'node', nn(p.node === THING ? thingShape : p.node));
      else if (p.datatype) {
        add(b, SH + 'datatype', nn(p.datatype));
        dts.set(p.path, p.datatype);
      }
      if (p.minCount !== undefined) add(b, SH + 'minCount', int(p.minCount));
      if (p.maxCount !== undefined) add(b, SH + 'maxCount', int(p.maxCount));
    }
    datatypes.set(c.name, dts);
    classes.push({
      name: c.name,
      classIRI: c.targetClass,
      shapeIRI: c.shapeIRI,
      extends: c.base ? model.byShape.get(c.base)!.name : undefined,
      properties: [...c.effective.values()].map((p) => ({ name: p.name, path: p.path })),
    });
  }
  let thing: GeneratedClass | undefined;
  if (model.thingName) {
    add(nn(thingShape), RDF_TYPE, nn(SH + 'NodeShape'));
    add(nn(thingShape), SH + 'codeIdentifier', literal(model.thingName));
    thing = { name: model.thingName, classIRI: NS.owl + 'Thing', shapeIRI: thingShape, properties: [] };
  }
  return { store, model, classes, thing, datatypes };
}

/** Text for a code comment: nothing in it can end the comment or the line. */
export const commentSafe = (s: string) => s.replace(/\*\//g, '*\u2215').replace(/[\r\n\u2028\u2029]+/g, ' ');

/** A writer for a typed literal, for datatypes the converter's built-in mappings would get wrong. */
const LITERAL_WRITER = `/** Writes a value as a literal of the given datatype (dates in ISO 8601). */
function literalWriter<T>(datatype: string): ITermFromValueMapping<T> {
  return (value: T, factory: DataFactory): Term => {
    let lexical: string;
    if (value instanceof Date) lexical = datatype === "${XSD}date" ? value.toISOString().slice(0, 10) : value.toISOString();
    else lexical = String(value);
    return factory.literal(lexical, factory.namedNode(datatype));
  };
}`;

/** Runs a function with the converter's progress logging silenced (it logs a line per shape). */
function quietly<T>(fn: () => T): T {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
}

/**
 * Generates the classes for an ontology. The shapes are the same ones served
 * as SHACL and SHACLC (see shacl.ts), so the code and the shapes agree.
 */
/**
 * An RDF/JS DatasetCore over an N3 store whose match() uses the store's
 * indexes and returns only the matches. The converter calls match(...).size
 * for every class, and an N3 match result counts against the whole store, so
 * a deep hierarchy would take quadratic time.
 */
function indexedDataset(store: Store) {
  return {
    get size() {
      return store.size;
    },
    match: (s?: any, p?: any, o?: any, g?: any) => new Store(store.getQuads(s ?? null, p ?? null, o ?? null, g ?? null)),
    add(q: any) {
      store.addQuad(q);
      return this;
    },
    delete(q: any) {
      store.removeQuad(q);
      return this;
    },
    has: (q: any) => store.has(q),
    [Symbol.iterator]: () => store.getQuads(null, null, null, null)[Symbol.iterator](),
  };
}

export async function toWrapperClasses(graph: OntologyGraph, opts: CodegenOptions = {}): Promise<GeneratedModule> {
  const derived = deriveShapes(graph);
  const { store, model, classes, thing, datatypes } = converterShapes(derived);
  const meta = graph.view().metadata;
  const ontology = { iri: graph.ontologyIRI || undefined, versionIRI: meta.versionIRI, version: opts.version ?? meta.versionInfo, namespace: graph.namespace };

  const [{ ClassGenerator }, { ShaclDataset }] = await Promise.all([
    import('@theodi/shacl-converter/dist/generator/class-generator.js' as string),
    import('@theodi/shacl-converter/dist/model/shacl-model.js' as string),
  ]);
  const ds = new ShaclDataset(indexedDataset(store), DataFactory);
  const models = new Map<string, any>([...ds.nodeShapes].map((m: any) => [m.value, m]));
  const registry = new Map<string, unknown>();
  for (const [iri, m] of models) registry.set(iri, { shape: m, fileName: m.codeIdentifier, codeIdentifier: m.codeIdentifier, prefix: '' });
  const generator = new ClassGenerator('', registry);

  // The model lists bases before the classes that extend them; Thing has no base.
  const all = thing ? [thing, ...classes] : classes;
  const ordered = all;

  const wrapperImports = new Set<string>(['DatasetWrapper']);
  let needsWriter = false;
  let needsLangString = false;
  const bodies: string[] = [];
  for (const c of ordered) {
    const code: string = quietly(() => generator.generate(models.get(c.shapeIRI)));
    const lines = code.split('\n');
    const body: string[] = [];
    for (const line of lines) {
      const imp = /^import \{ ([^}]+) \} from ["']([^"']+)["'];$/.exec(line.trim());
      if (imp) {
        if (imp[2] === '@rdfjs/wrapper') imp[1].split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => wrapperImports.add(x));
        continue; // relative imports between generated classes go away: they share one module
      }
      body.push(line);
    }
    let text = body.join('\n').trim();
    // Exact literal writers for datatypes the converter would write with the wrong (or a missing) datatype.
    for (const [path, dt] of datatypes.get(c.name) ?? []) {
      if (EXACT_WRITERS.has(dt)) continue;
      const iri = JSON.stringify(path);
      const writer = `literalWriter(${JSON.stringify(dt)})`;
      const before = text;
      text = text
        // Replacer functions, so `$&` or `$1` in a datatype IRI stays literal text.
        .replaceAll(new RegExp(`(\\(this, ${escapeRe(iri)}, value, )LiteralFrom\\.\\w+\\)`, 'g'), (_m, head: string) => `${head}${writer})`)
        .replaceAll(new RegExp(`(\\(this, ${escapeRe(iri)}, LiteralAs\\.\\w+, )LiteralFrom\\.\\w+\\)`, 'g'), (_m, head: string) => `${head}${writer})`);
      if (text !== before) needsWriter = true;
    }
    if (/\bILangString\b/.test(text)) needsLangString = true;
    const doc = c === thing
      ? `/** Any resource. Values whose class has no class of its own here are wrapped as ${c.name}. */`
      : `/** ${commentSafe(`<${c.classIRI}>${labelOf(graph, c.classIRI)}`)} */`;
    bodies.push(`${doc}\n${text}`);
  }

  const datasetClass = uniqueName(`${identifierFrom(opts.name ?? defaultName(graph), 'pascal')}Dataset`, new Set([...model.taken, ...RESERVED_CLASSES, ...JS_KEYWORDS]));
  const reservedGetters = new Set(['size', 'add', 'delete', 'has', 'match', 'dataset', 'factory', 'named', 'subjectsOf', 'objectsOf', 'instancesOf', 'matchSubjectsOf', 'matchObjectsOf', 'constructor']);
  const getterNames = new Set<string>();
  const getters = classes.map((c) => {
    let g = c.name[0].toLowerCase() + c.name.slice(1);
    if (reservedGetters.has(g)) g = `${g}_`;
    g = uniqueName(g, getterNames);
    getterNames.add(g);
    c.datasetGetter = g;
    return `  /** Every instance of ${commentSafe(`<${c.classIRI}>`)} in the dataset. */\n  get ${g}(): Iterable<${c.name}> {\n    return this.instancesOf(${JSON.stringify(c.classIRI)}, ${c.name});\n  }`;
  });
  const dataset = `/** Finds the instances of every class above in an RDF/JS dataset. */\nexport class ${datasetClass} extends DatasetWrapper {\n${getters.join('\n\n')}\n}`;

  const header = [
    `/**`,
    ` * ${commentSafe(`${meta.title ?? ontology.iri ?? 'Ontology'}${ontology.version ? ` ${ontology.version}` : ''}`)}: classes for every SHACL node shape.`,
    ...(opts.sourceUrl ? [` * Source: ${commentSafe(opts.sourceUrl)}`] : []),
    ...(ontology.versionIRI ? [` * Version IRI: ${commentSafe(ontology.versionIRI)}`] : []),
    ` * Generated by Concord with @theodi/shacl-converter ${CONVERTER_VERSION} over @rdfjs/wrapper ${WRAPPER_VERSION}. Do not edit.`,
    ` *`,
    ` * Usage: const data = new ${datasetClass}(dataset, factory); for (const x of data.${getters.length ? /get (\w+)\(/.exec(getters[0])![1] : 'thing'}) { ... }`,
    ` * or wrap one node: new ${classes[0]?.name ?? 'Thing'}(iri, dataset, factory).`,
    ...(model.notes.length ? [` *`, ...model.notes.map((n) => ` * Note: ${commentSafe(n)}`)] : []),
    ` */`,
  ].join('\n');
  const ontologyConst = `/** The ontology these classes were generated from. */\nexport const ontology = ${JSON.stringify(Object.fromEntries(Object.entries(ontology).filter(([, x]) => x !== undefined)), null, 2)} as const;`;

  const typeImports = [...(needsWriter ? ['ITermFromValueMapping'] : []), ...(needsLangString ? ['ILangString'] : [])];
  const imports = [
    `import { ${[...wrapperImports].sort().join(', ')} } from "@rdfjs/wrapper";`,
    ...(typeImports.length ? [`import type { ${typeImports.join(', ')} } from "@rdfjs/wrapper";`] : []),
    ...(needsWriter ? [`import type { DataFactory, Term } from "@rdfjs/types";`] : []),
  ];
  const ts = [header, imports.join('\n'), ontologyConst, ...(needsWriter ? [LITERAL_WRITER] : []), ...bodies, dataset].join('\n\n') + '\n';

  const esbuild = await import('esbuild');
  const { code } = await esbuild.transform(ts, { loader: 'ts', format: 'esm', target: 'es2022', legalComments: 'none' });
  const js = `${header}\n${code}`;
  return { ts, js, dts: declarations(ts), classes: all, datasetClass, notes: model.notes, ontology };
}

/**
 * Type declarations from the generated TypeScript. The source is regular (the
 * converter writes every accessor the same way), so dropping the bodies is
 * enough; a test type-checks the result against @rdfjs/wrapper.
 */
function declarations(ts: string): string {
  return ts
    .replace(/\/\*\* Writes a value as a literal[\s\S]*?\n\}\n/, '')
    .replace(/^export class /gm, 'export declare class ')
    .replace(/^export const ontology = /m, 'export declare const ontology: ')
    .replace(/(export declare const ontology: [\s\S]*?\n\}) as const;/, '$1;')
    .replace(/^(  (?:get|set) \w+\([^)]*\)(?:: [^{\n]+?)?) \{\n[\s\S]*?\n  \}/gm, '$1;')
    .replace(/^import type \{ DataFactory, Term \} from "@rdfjs\/types";\n/m, '')
    .replace(/^import type \{ ([^}]*) \} from "@rdfjs\/wrapper";\n/m, (_m, names: string) => {
      const keep = names.split(',').map((x) => x.trim()).filter((x) => x && x !== 'ITermFromValueMapping');
      return keep.length ? `import type { ${keep.join(', ')} } from "@rdfjs/wrapper";\n` : '';
    });
}

/** The ontology IRI's last segment (…/volunteering → volunteering), else its preferred prefix. */
function defaultName(graph: OntologyGraph): string {
  const last = (graph.ontologyIRI ?? '').replace(/[#/]+$/, '').split(/[#/]/).pop() ?? '';
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(last) ? last : graph.view().metadata.preferredPrefix ?? 'ontology';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uniqueName = (name: string, taken: Set<string>) => {
  let n = name;
  let i = 2;
  while (taken.has(n)) n = `${name}${i++}`;
  return n;
};
function labelOf(graph: OntologyGraph, iri: string): string {
  const t = graph.term(iri);
  const def = t && 'definition' in t ? (t as { definition?: string }).definition : undefined;
  const text = [t?.label, def].filter(Boolean).join(': ');
  return text ? ` ${text.replace(/\*\//g, '* /').replace(/\s+/g, ' ')}` : '';
}

/* ------------------------------------------------------------------------ */
/* npm package                                                               */
/* ------------------------------------------------------------------------ */

export interface PackageOptions {
  /** npm package name, e.g. 'volunteering-ontology'. */
  name: string;
  /** A semver version, e.g. '1.0.0' or '1.1.0-fork.activity-tracking.2'. */
  version: string;
  description?: string;
  homepage?: string;
  /** The SHACL shapes (Turtle), included as shapes.ttl. */
  shapes?: string;
}

/**
 * An npm package (a gzipped tarball) with the generated classes, so an app
 * that uses a bundler can `npm install <url>.tgz`. Switching between a fork
 * and a release only changes that URL; the package name, and so every import
 * in the app, stays the same.
 */
export function npmPackage(mod: GeneratedModule, opts: PackageOptions): Buffer {
  const pkg = {
    name: opts.name,
    version: opts.version,
    description: opts.description ?? `Classes for ${opts.name}, generated from its SHACL shapes`,
    type: 'module',
    main: './index.js',
    types: './index.d.ts',
    exports: { '.': { types: './index.d.ts', default: './index.js' }, './shapes.ttl': './shapes.ttl' },
    files: ['index.js', 'index.d.ts', 'index.ts', 'shapes.ttl', 'README.md'],
    sideEffects: false,
    ...(opts.homepage ? { homepage: opts.homepage } : {}),
    dependencies: { '@rdfjs/wrapper': `^${WRAPPER_VERSION}`, '@rdfjs/types': '^2.0.0' },
    license: 'SEE LICENSE IN the ontology',
  };
  const readme = `# ${opts.name}\n\n${pkg.description}.\n\n${opts.homepage ? `Ontology: ${opts.homepage}\n\n` : ''}Generated by Concord with @theodi/shacl-converter over @rdfjs/wrapper. Do not edit; install a newer version instead.\n\n\`\`\`js\nimport { ${mod.datasetClass} } from "${opts.name}";\n\`\`\`\n`;
  const files: [string, string][] = [
    ['package.json', JSON.stringify(pkg, null, 2) + '\n'],
    ['README.md', readme],
    ['index.js', mod.js],
    ['index.d.ts', mod.dts],
    ['index.ts', mod.ts],
    ...(opts.shapes ? [['shapes.ttl', opts.shapes] as [string, string]] : []),
  ];
  return gzipSync(tar(files.map(([n, c]) => [`package/${n}`, Buffer.from(c, 'utf8')])), { level: 9 });
}

/** A minimal ustar archive (regular files only, fixed timestamps so the bytes are reproducible). */
function tar(files: [string, Buffer][]): Buffer {
  const blocks: Buffer[] = [];
  const MTIME = 499162500; // 1985-10-26, as npm itself uses for reproducible tarballs
  for (const [name, data] of files) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100, 8, 'ascii');
    h.write('0000000\0', 108, 8, 'ascii');
    h.write('0000000\0', 116, 8, 'ascii');
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    h.write(MTIME.toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
    h.write('        ', 148, 8, 'ascii');
    h.write('0', 156, 1, 'ascii');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
