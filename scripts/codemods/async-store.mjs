#!/usr/bin/env node
/**
 * Codemod: make the server's database calls async (step 2 of moving to Vercel + Postgres).
 *
 * The functions db.ts exports (get, put, list, transaction, ...) become async. This script finds every call to
 * them with the TypeScript language service, adds `await`, makes the enclosing function `async` (and its declared
 * return type a Promise), then repeats for the callers of every function it made async, until nothing changes.
 *
 * It is meant to be re-run: when another server PR merges, check out the pre-conversion tree with that PR merged,
 * re-run this, then re-apply the hand fixes with `git apply --3way scripts/codemods/async-store.fixes.patch`
 * (and fix whatever new spots it prints). That is quicker and safer than resolving conflicts in ~900 rewritten
 * lines. Refresh the patch afterwards: `git diff <codemod output commit> -- apps > scripts/codemods/async-store.fixes.patch`.
 * The patch holds the hand fixes made in the conversion commit itself; fixes committed after it (such as the
 * transactions added in review) are ordinary commits: cherry-pick them on top of the re-run.
 *
 * What it won't do by itself, and prints instead ("needs a hand fix"):
 * - a function made async that is passed as a callback to something other than a known promise-aware caller
 *   (Array#map/filter/some/forEach..., timers, event handlers): `.filter(async ...)` compiles but is always true;
 * - a db function or newly async function used as a value rather than called (`fn = get`, `.map(get)`);
 * - getters, setters, constructors and class field initialisers, which can't be async;
 * - type predicates (`x is T`) as return types.
 * After it runs, `pnpm --filter @concord/server typecheck` finds the rest (e.g. typed callback slots).
 *
 * Usage: node scripts/codemods/async-store.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, Project, SyntaxKind } from 'ts-morph';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const server = path.join(root, 'apps/server');
const dbFile = path.join(server, 'src/db.ts');
const dry = process.argv.includes('--dry');

/** db.ts exports that touch the database. HttpError and the Collection type stay as they are. */
const SEEDS = ['openDb', 'closeDb', 'get', 'mustGet', 'list', 'put', 'remove', 'take', 'claim', 'insertOnce', 'removeWhereAtMost', 'clearAll', 'transaction', 'withoutWaiting', 'scrubFreeSpace'];

/** Callees that take an async callback and await what it returns. */
const PROMISE_AWARE_CALLEES = new Set([
  'transaction',
  'withoutWaiting',
  // vitest
  'it',
  'test',
  'beforeAll',
  'beforeEach',
  'afterAll',
  'afterEach',
  // Express 5 forwards a rejected handler promise to the error middleware.
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'all',
  'use',
]);
/** Receivers whose get/post/... are Express routing (not a Map or the db). */
const EXPRESS_RECEIVERS = /^(app|router|r|api|publicRouter|routes)$/;

const project = new Project({ tsConfigFilePath: path.join(server, 'tsconfig.json') });
const db = project.getSourceFileOrThrow(dbFile);

/** @type {Map<string, {at: number, text: string}[]>} insertions/replacements per file, by position */
const edits = new Map();
const notes = [];
const done = new Set(); // function-like nodes already handled (made async, or already async)
const madeAsync = new Set(); // function-like nodes this run turned from sync into async
/** @type {Map<object, Set<object>>} innermost enclosing function -> the functions it calls that are now async */
const calls = new Map();
/** @type {Map<object, number>} how many now-async calls each function makes */
const callCount = new Map();
const awaited = new Set(); // call nodes already given an await
const queue = [];

/**
 * Queue a text edit. Several insertions can land on the same position (`transaction(async () => await get(x))`
 * starts three things at once), so each says whether it opens or closes something and how far out it sits
 * (`rank`: 0 innermost), and they are ordered so outer ones enclose inner ones.
 */
function edit(node, at, text, { end, close = false, rank = 0 } = {}) {
  const file = node.getSourceFile().getFilePath();
  if (file === dbFile || !inServer(file)) return; // db.ts is regenerated below; dependencies aren't ours to edit.
  if (!edits.has(file)) edits.set(file, []);
  edits.get(file).push({ at, end: end ?? at, text, close, rank });
}

const inServer = (file) => file.startsWith(server + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`);

function where(node) {
  const sf = node.getSourceFile();
  const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
  return `${path.relative(root, sf.getFilePath())}:${line}:${column}`;
}

function note(node, why) {
  notes.push(`${where(node)}  ${why}\n      ${node.getText().split('\n')[0].slice(0, 110)}`);
}

for (const name of SEEDS) {
  const fn = db.getFunction(name);
  if (!fn) {
    console.warn(`db.ts has no ${name}; skipping it`);
    continue;
  }
  done.add(fn);
  queue.push(fn);
}

/** The identifier other code uses to refer to a function-like node, if any. */
function nameNodeOf(fn) {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) return fn.getNameNode();
  const p = fn.getParent();
  if (Node.isVariableDeclaration(p) && p.getInitializer() === fn) return p.getNameNode();
  if (Node.isPropertyAssignment(p) && p.getInitializer() === fn) return p.getNameNode();
  if (Node.isFunctionExpression(fn) && fn.getNameNode()) return fn.getNameNode();
  return undefined;
}

/** The call a function-like node is passed to as an argument, if it is a callback. */
function callbackHost(fn) {
  let n = fn;
  while (Node.isParenthesizedExpression(n.getParent())) n = n.getParent();
  const p = n.getParent();
  return Node.isCallExpression(p) && p.getArguments().includes(n) ? p : undefined;
}

function calleeName(call) {
  const e = call.getExpression();
  if (Node.isIdentifier(e)) return { name: e.getText() };
  if (Node.isPropertyAccessExpression(e)) return { name: e.getName(), receiver: e.getExpression().getText() };
  return { name: e.getText() };
}

function isPromiseAware(call) {
  const { name, receiver } = calleeName(call);
  if (!PROMISE_AWARE_CALLEES.has(name)) return false;
  if (['get', 'post', 'put', 'patch', 'delete', 'all', 'use'].includes(name)) return receiver !== undefined && EXPRESS_RECEIVERS.test(receiver);
  return true;
}

/** Make a function-like node async, unless it already is; queue it so its own callers get awaited. */
function makeAsync(fn, because) {
  if (done.has(fn)) return;
  done.add(fn);
  if (Node.isGetAccessorDeclaration(fn) || Node.isSetAccessorDeclaration(fn) || Node.isConstructorDeclaration(fn)) {
    note(because, `inside a ${fn.getKindName()}, which can't be async`);
    return;
  }
  if (fn.isGenerator?.()) {
    note(because, 'inside a generator');
    return;
  }
  if (fn.isAsync()) return; // Its callers already deal in promises.
  madeAsync.add(fn);

  // `async` goes before `function`, before an arrow's parameters, or before a method's name.
  if (Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn)) {
    edit(fn, fn.getFirstChildByKindOrThrow(SyntaxKind.FunctionKeyword).getStart(), 'async ');
  } else if (Node.isArrowFunction(fn)) {
    edit(fn, fn.getStart(), 'async ');
  } else if (Node.isMethodDeclaration(fn)) {
    edit(fn, fn.getNameNode().getStart(), 'async ');
  }

  const rt = fn.getReturnTypeNode();
  if (rt) {
    if (Node.isTypePredicate(rt)) note(rt, 'a type predicate return type cannot be async');
    else if (!/^Promise</.test(rt.getText())) edit(rt, rt.getStart(), `Promise<${rt.getText()}>`, { end: rt.getEnd() });
  }

  const host = callbackHost(fn);
  if (host) {
    asyncCallbackIn(host, fn, because);
    return; // Nothing refers to a callback by name.
  }
  queue.push(fn);
}

/** Array methods that call their callback synchronously, in the caller's turn. */
const ARRAY_METHODS = new Set(['map', 'forEach', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast', 'flatMap', 'reduce', 'sort', 'toSorted']);
const wrappedMaps = new Set();

/**
 * A callback (or a function passed by name) that now returns a promise. Promise-aware hosts are fine as they
 * are. `.map(cb)` becomes `(await Promise.all(xs.map(cb)))`, which keeps the order, and the function around it
 * becomes async. Any other array method, timer or event handler is listed for a hand fix.
 */
function asyncCallbackIn(host, fn, because) {
  if (isPromiseAware(host)) return;
  const { name, receiver } = calleeName(host);
  const enclosing = host.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a));
  // The array method runs the callback inside the enclosing function's turn, so it inherits the callback's writes.
  if (receiver !== undefined && ARRAY_METHODS.has(name) && enclosing && fn) {
    if (!calls.has(enclosing)) calls.set(enclosing, new Set());
    calls.get(enclosing).add(fn);
  }
  if (receiver !== undefined && name === 'map') {
    if (wrappedMaps.has(host)) return;
    wrappedMaps.add(host);
    edit(host, host.getStart(), '(await Promise.all(', { rank: 3 });
    edit(host, host.getEnd(), '))', { close: true, rank: 3 });
    if (enclosing) makeAsync(enclosing, host);
    return;
  }
  note(because ?? host, `now async, but ${name}() won't await it: use a for loop, Promise.all, or .catch()`);
}

function needsParens(call) {
  const p = call.getParent();
  return (
    (Node.isPropertyAccessExpression(p) && p.getExpression() === call) ||
    (Node.isElementAccessExpression(p) && p.getExpression() === call) ||
    (Node.isCallExpression(p) && p.getExpression() === call) ||
    Node.isNonNullExpression(p) ||
    Node.isTaggedTemplateExpression(p) ||
    Node.isNewExpression(p)
  );
}

function awaitCall(call, callee) {
  const enclosing = call.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a));
  if (enclosing && !awaited.has(call)) {
    if (!calls.has(enclosing)) calls.set(enclosing, new Set());
    calls.get(enclosing).add(callee);
    callCount.set(enclosing, (callCount.get(enclosing) ?? 0) + 1);
  }
  if (awaited.has(call)) return;
  awaited.add(call);
  let outer = call;
  while (Node.isParenthesizedExpression(outer.getParent())) outer = outer.getParent();
  if (Node.isAwaitExpression(outer.getParent())) return;
  // `expect(p).rejects` and `expect(p).resolves` want the promise itself: awaiting it would throw before expect.
  const host = outer.getParent();
  if (Node.isCallExpression(host) && host.getExpression().getText() === 'expect' && host.getArguments()[0] === outer) {
    const then = host.getParent();
    if (Node.isPropertyAccessExpression(then) && ['rejects', 'resolves'].includes(then.getName())) return;
  }
  if (needsParens(call)) {
    edit(call, call.getStart(), '(await ', { rank: 1 });
    edit(call, call.getEnd(), ')', { close: true, rank: 1 });
  } else {
    edit(call, call.getStart(), 'await ');
  }
  const fn = call.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a));
  if (!fn) {
    const field = call.getFirstAncestor((a) => Node.isPropertyDeclaration(a) || Node.isClassStaticBlockDeclaration(a));
    if (field) note(call, 'in a class field or static block');
    return; // Top level of an ES module: top-level await works.
  }
  makeAsync(fn, call);
}

while (queue.length) {
  const fn = queue.shift();
  const nameNode = nameNodeOf(fn);
  if (!nameNode) continue;
  if (!Node.isIdentifier(nameNode)) {
    note(nameNode, 'made async, but named by a pattern or string key: find its callers by hand');
    continue;
  }
  for (const ref of nameNode.findReferencesAsNodes()) {
    if (ref === nameNode || !inServer(ref.getSourceFile().getFilePath())) continue;
    const p = ref.getParent();
    if (Node.isImportSpecifier(p) || Node.isExportSpecifier(p) || Node.isImportClause(p) || Node.isNamespaceImport(p)) continue;
    if (ref.getFirstAncestorByKind(SyntaxKind.TypeQuery)) {
      note(ref, '`typeof` of a function that is now async: check the type (Awaited<ReturnType<...>>?)');
      continue;
    }
    let call;
    if (Node.isCallExpression(p) && p.getExpression() === ref) call = p;
    else if (Node.isPropertyAccessExpression(p) && p.getNameNode() === ref && Node.isCallExpression(p.getParent()) && p.getParent().getExpression() === p)
      call = p.getParent();
    if (!call) {
      let arg = ref;
      while (Node.isParenthesizedExpression(arg.getParent())) arg = arg.getParent();
      const host = Node.isCallExpression(arg.getParent()) && arg.getParent().getArguments().includes(arg) ? arg.getParent() : undefined;
      if (host) asyncCallbackIn(host, fn, ref);
      else note(ref, 'used as a value, not called: whoever calls it must now await it');
      continue;
    }
    awaitCall(call, fn);
  }
}

/*
 * Keep what used to be atomic, atomic. A synchronous function ran start to finish without any other request
 * getting in between, so a read-then-write in it could never lose an update. Once its database calls are
 * awaited, other requests can interleave at every await. So every function this run made async that writes
 * (calls put/remove/take/claim/clearAll, or another such function, directly rather than from a callback) gets
 * its body wrapped in transaction(): nested calls join the outermost one, so the whole formerly-synchronous
 * call tree commits as one. Functions that were already async were never atomic across their awaits and are
 * left alone, as are callbacks given to transaction() or withoutWaiting() (VACUUM can't run in a transaction),
 * tests, Express handlers (see below), and functions whose only database call is a single write (already atomic).
 */
const WRITERS = new Set(['put', 'remove', 'take', 'claim', 'clearAll'].map((n) => db.getFunction(n)).filter(Boolean));
const writes = new Set();
for (let changed = true; changed; ) {
  changed = false;
  for (const [fn, callees] of calls) {
    if (writes.has(fn) || !madeAsync.has(fn)) continue;
    if ([...callees].some((c) => WRITERS.has(c) || writes.has(c))) {
      writes.add(fn);
      changed = true;
    }
  }
}
const txImports = new Set();
let wrapped = 0;
const TEST_HOSTS = new Set(['it', 'test', 'beforeAll', 'beforeEach', 'afterAll', 'afterEach']);
for (const fn of writes) {
  // Tests aren't wrapped: a test body held open as a transaction would block the requests it makes.
  if (fn.getSourceFile().getFilePath().startsWith(path.join(server, 'test') + path.sep)) continue;
  const host = callbackHost(fn);
  if (host && ['transaction', 'withoutWaiting', ...TEST_HOSTS].includes(calleeName(host).name)) continue;
  // Nor Express handlers: the response would go out before COMMIT, claiming success for work that could still
  // roll back. The service functions they call are wrapped where they read and then write.
  if (host && isPromiseAware(host)) continue;
  // One write and nothing else is atomic on its own.
  if (callCount.get(fn) === 1 && [...calls.get(fn)].every((c) => WRITERS.has(c))) continue;
  const body = fn.getBody();
  if (!body) continue;
  wrapped++;
  if (Node.isBlock(body)) {
    edit(fn, body.getStart() + 1, ' return transaction(async () => {', { rank: 2 });
    edit(fn, body.getEnd() - 1, '}); ', { close: true, rank: 2 });
  } else {
    edit(fn, body.getStart(), 'transaction(async () => ', { rank: 2 });
    edit(fn, body.getEnd(), ')', { close: true, rank: 2 });
  }
  if (fn.getSourceFile().getFilePath() !== dbFile) txImports.add(fn.getSourceFile());
}
for (const sf of txImports) {
  const imp = sf.getImportDeclarations().find((d) => !d.isTypeOnly() && d.getModuleSpecifierSourceFile()?.getFilePath() === dbFile);
  if (imp?.getNamedImports().some((n) => n.getName() === 'transaction')) continue;
  const named = imp?.getNamedImports()[0];
  if (named) edit(named, named.getStart(), 'transaction, ');
  else {
    let spec = path.relative(path.dirname(sf.getFilePath()), dbFile).replace(/\\.ts$/, '.js').split(path.sep).join('/');
    if (!spec.startsWith('.')) spec = `./${spec}`;
    const last = sf.getImportDeclarations().at(-1);
    edit(sf, last ? last.getEnd() : 0, `${last ? '\n' : ''}import { transaction } from '${spec}';${last ? '' : '\n'}`);
  }
}
console.log(`${madeAsync.size} functions made async; ${wrapped} of them write after another database call, and now run as one transaction.`);

// Apply edits from the end of each file backwards, so earlier positions stay valid.
let count = 0;
for (const [file, list] of edits) {
  // Applied from the end backwards; at one position, later-applied text lands first, so apply opens inner to outer
  // and then closes outer to inner, giving `close_inner close_outer open_outer open_inner` in the file.
  const tie = (e) => (e.close ? 100 - e.rank : e.rank);
  list.sort((a, b) => b.at - a.at || b.end - a.end || tie(a) - tie(b));
  let text = fs.readFileSync(file, 'utf8');
  for (const e of list) text = text.slice(0, e.at) + e.text + text.slice(e.end);
  count += list.length;
  if (!dry) fs.writeFileSync(file, text);
}

// db.ts: keep its Collection type, delegate everything else to the async store.
const collection = db.getTypeAliasOrThrow('Collection').getText();
const template = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'db.async.ts.txt'), 'utf8');
if (!dry) fs.writeFileSync(dbFile, template.replace('/*COLLECTION*/', collection));

console.log(`${count} edits in ${edits.size} files${dry ? ' (dry run, nothing written)' : ''}; db.ts regenerated from scripts/codemods/db.async.ts.txt.`);
if (notes.length) {
  console.log(`\n${notes.length} places need a hand fix:\n`);
  console.log(notes.join('\n'));
}
