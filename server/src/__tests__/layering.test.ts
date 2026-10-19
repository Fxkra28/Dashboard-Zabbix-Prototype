import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The direction code may depend in: index.ts mounts routes, routes call services, services call the shared folders.
 * Nothing but index.ts imports a route module, no route imports another route, and no service imports a route, so
 * a handler's logic is reachable without Fastify and a route can be read on its own.
 *
 * The shared folders hold what the services use, one kind of file in each:
 *   core      configuration, the cache and its stale marker, the gate, query parsing, the body schemas. Imports nothing else.
 *   clients   the Zabbix client, the model client and the caps on its use
 *   domain    what a host, a site and a problem are: naming rules, reachability, the shared reads
 *   security  sign-in and the roles, passwords, the page table, what a viewer may not read
 *   http      what index.ts wires in around the routes: hooks, error mapping, the health check, shutdown
 * index.ts is the only file left at the top of src.
 */

const SRC = path.resolve(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Every module specifier a file imports or re-exports, resolved to a path under src without the extension. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    out.push(path.resolve(path.dirname(file), m[1].replace(/\.js$/, '')));
  }
  return out;
}

const inDir = (target: string, dir: string) => path.dirname(target) === path.join(SRC, dir);
/** The folders of files the services share. */
const SHARED = ['core', 'clients', 'domain', 'security', 'http'];
const files = sources(SRC);

describe('the layers of server/src', () => {
  it('finds the files it checks', () => {
    expect(files.some((f) => f.endsWith(path.join('routes', 'hosts.ts')))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join('services', 'hosts.ts')))).toBe(true);
  });

  it('lets only index.ts import a route module', () => {
    const offenders = files
      .filter((f) => path.basename(f) !== 'index.ts' || path.dirname(f) !== SRC)
      .flatMap((f) => importsOf(f).filter((t) => inDir(t, 'routes')).map((t) => `${path.relative(SRC, f)} imports ${path.relative(SRC, t)}`));
    expect(offenders).toEqual([]);
  });

  it('has no service that imports a route', () => {
    const offenders = files
      .filter((f) => inDir(f, 'services'))
      .flatMap((f) => importsOf(f).filter((t) => inDir(t, 'routes')).map((t) => `${path.relative(SRC, f)} imports ${path.relative(SRC, t)}`));
    expect(offenders).toEqual([]);
  });

  it('leaves index.ts alone at the top of src, with every other file in a folder', () => {
    expect(readdirSync(SRC).filter((name) => name.endsWith('.ts'))).toEqual(['index.ts']);
  });

  it('has these folders in src and no other', () => {
    const folders = readdirSync(SRC)
      .filter((name) => name !== '__tests__' && statSync(path.join(SRC, name)).isDirectory())
      .sort();
    expect(folders).toEqual(['clients', 'core', 'domain', 'export', 'http', 'routes', 'security', 'services', 'sli']);
  });

  it('lets core import nothing outside core', () => {
    const offenders = files
      .filter((f) => inDir(f, 'core'))
      .flatMap((f) => importsOf(f).filter((t) => !inDir(t, 'core')).map((t) => `${path.relative(SRC, f)} imports ${path.relative(SRC, t)}`));
    expect(offenders).toEqual([]);
  });

  it('lets the shared folders import no route and no service, but the health check reading the stream count', () => {
    const allowed = ['http/health.ts imports services/stream'];
    const offenders = files
      .filter((f) => SHARED.some((dir) => inDir(f, dir)))
      .flatMap((f) =>
        importsOf(f)
          .filter((t) => inDir(t, 'routes') || inDir(t, 'services'))
          .map((t) => `${path.relative(SRC, f)} imports ${path.relative(SRC, t)}`),
      )
      .filter((edge) => !allowed.includes(edge));
    expect(offenders).toEqual([]);
  });

  it('lets only index.ts import http/, but for the sentence two services show when Zabbix cannot be read', () => {
    // Adding a line here is the decision to couple a service to the HTTP plumbing.
    const allowed = ['services/chat.ts imports http/errors', 'services/stream.ts imports http/errors'];
    const offenders = files
      .filter((f) => !inDir(f, 'http') && !(path.basename(f) === 'index.ts' && path.dirname(f) === SRC))
      .flatMap((f) => importsOf(f).filter((t) => inDir(t, 'http')).map((t) => `${path.relative(SRC, f)} imports ${path.relative(SRC, t)}`))
      .filter((edge) => !allowed.includes(edge));
    expect(offenders).toEqual([]);
  });

  it('keeps routes to the registrar: no module-level logic of their own to share', () => {
    // A route file exports its registrar and nothing else; anything another file needs belongs in services/.
    const offenders = files
      .filter((f) => inDir(f, 'routes'))
      .filter((f) => [...readFileSync(f, 'utf8').matchAll(/^export (?!async function \w+Routes\b)/gm)].length > 0)
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
