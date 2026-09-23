/**
 * Check that docs/api/openapi.yaml lists exactly the routes the server registers.
 *
 *   npx tsx scripts/openapi.check.ts            (from server/)
 *
 * Why this exists. The endpoint table in setup.md §5 drifted twice, it claimed "16 modules, 35
 * endpoints" while the table below it listed all of them (DOC-14), and 23 of its 35 "Defined at"
 * line citations pointed at unrelated lines after the route files grew (DOC-15). Both were written
 * by hand and nothing compared them with the code, so both survived several readings. A third
 * hand-written list would drift the same way. This one is checked.
 *
 * It compares two sets and fails on a difference in either direction:
 *   - every `app.get('…')` / `app.post('…')` in server/src, excluding __tests__
 *   - every path key under `paths:` in docs/api/openapi.yaml
 *
 * Read-only. No npm dependency: the YAML is scanned for path keys rather than parsed, the same
 * trade validate-sli.ts made when it hand-wrote a zip reader instead of adding a parser. That is
 * safe here because this script also owns the spec's formatting contract, path keys are the only
 * two-space-indented `/…:` lines inside the `paths:` block.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, '..', 'src');
const SPEC = join(HERE, '..', '..', 'docs', 'api', 'openapi.yaml');

export interface Route {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  where: string;
}


/**
 * Every route registration in a TypeScript source file.
 *
 * Matches `app.get('/api/x'`, `fastify.post("/api/y"`, and the backtick form. Deliberately does NOT
 * match a template literal with a substitution: a path the checker cannot resolve statically is
 * reported rather than silently skipped.
 */
export function routesIn(source: string, where = '<memory>'): Route[] {
  const out: Route[] = [];
  const re = /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]*)\2/g;
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // Skip comment-only lines so a commented-out route is not counted.
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[i])) !== null) {
      const path = m[3];
      if (!path.startsWith('/')) continue; // cache.get('key'), map.get(…), and friends
      out.push({ method: m[1] as Route['method'], path, where: `${where}:${i + 1}` });
    }
  }
  return out;
}

/** Path keys under `paths:` in an OpenAPI document, in file order. */
export function specPaths(yaml: string): string[] {
  const out: string[] = [];
  const lines = yaml.split('\n');
  let inPaths = false;

  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    // A non-indented, non-blank, non-comment line ends the block.
    if (/^\S/.test(line)) break;
    const m = /^ {2}(\/[^:\s]*):\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFilesUnder(full, acc);
    else if (entry.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

// Self-test, runs before any real file is read

function selfTest(): string[] {
  const bad: string[] = [];
  const eq = (label: string, got: unknown, want: unknown) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) bad.push(`self-test ${label}: got ${g}, want ${w}`);
  };

  eq(
    'finds get and post',
    routesIn(`app.get('/api/a', h);\napp.post("/api/b", h);`).map((r) => `${r.method} ${r.path}`),
    ['get /api/a', 'post /api/b'],
  );
  eq('ignores non-path arguments', routesIn(`cache.get('problems');\nmap.get(key);`), []);
  eq(
    'ignores a commented-out route',
    routesIn(`// app.get('/api/ghost', h);\n * app.get('/api/also-ghost', h);`),
    [],
  );
  eq(
    'accepts any receiver name',
    routesIn(`fastify.get('/api/c', h);`).map((r) => r.path),
    ['/api/c'],
  );
  eq(
    'reads spec path keys',
    specPaths(['paths:', '  /api/a:', '    get:', '      x: 1', '  /api/b:', 'components:', '  /api/nope:'].join('\n')),
    ['/api/a', '/api/b'],
  );
  eq('spec with no paths block', specPaths('info:\n  title: x\n'), []);

  return bad;
}


const selfFailures = selfTest();
if (selfFailures.length) {
  for (const f of selfFailures) console.error(f);
  console.error(`openapi.check: the checker itself is broken — ${selfFailures.length} self-test failure(s).`);
  process.exit(1);
}

const registered = tsFilesUnder(SERVER_SRC).flatMap((f) =>
  routesIn(readFileSync(f, 'utf8'), relative(join(HERE, '..'), f)),
);
const documented = specPaths(readFileSync(SPEC, 'utf8'));

const registeredPaths = new Set(registered.map((r) => r.path));
const documentedPaths = new Set(documented);

const problems: string[] = [];

for (const r of registered) {
  if (!documentedPaths.has(r.path)) {
    problems.push(`${r.where}  ${r.method.toUpperCase()} ${r.path} is registered but absent from openapi.yaml`);
  }
}
for (const p of documented) {
  if (!registeredPaths.has(p)) {
    problems.push(`docs/api/openapi.yaml  ${p} is documented but no route registers it`);
  }
}

const dupes = documented.filter((p, i) => documented.indexOf(p) !== i);
for (const d of new Set(dupes)) {
  problems.push(`docs/api/openapi.yaml  ${d} appears more than once under paths:`);
}

if (problems.length) {
  for (const p of problems) console.error(p);
  console.error(
    `\nopenapi.check: ${problems.length} problem(s). ` +
      `${registeredPaths.size} route(s) registered, ${documentedPaths.size} documented.`,
  );
  process.exit(1);
}

const byMethod = registered.reduce<Record<string, number>>((acc, r) => {
  acc[r.method] = (acc[r.method] ?? 0) + 1;
  return acc;
}, {});
const shape = Object.entries(byMethod)
  .sort()
  .map(([m, n]) => `${n} ${m.toUpperCase()}`)
  .join(' + ');

console.log(`openapi.check: ${registered.length} endpoints (${shape}) — all documented, none extra.`);
