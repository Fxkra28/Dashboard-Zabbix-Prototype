import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The CI workflow, .github/workflows/docs.yml, read as plain text.
 *
 * Nothing runs the workflow until it is pushed, and a step that quietly goes missing looks the same
 * as a step that passes. This reads the file for the things the checklist asked CI to do, and for
 * the paths and npm scripts those steps name. There is no YAML parser in the dependencies, so it
 * reads only the shape this file uses: two-space blocks, `- key: value` steps, and `#` comments.
 */
interface Step {
  name?: string;
  uses?: string;
  run?: string;
  'working-directory'?: string;
}

const root = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const text = readFileSync(root('.github/workflows/docs.yml'), 'utf8');

// A plain scalar ends at ` #`, as in YAML.
const lines = text
  .split('\n')
  .map((l) => l.replace(/\s+#.*$/, '').trimEnd())
  .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

/** The `key: value` lines indented one level (two spaces) under a top-level or job-level key. */
function block(header: RegExp, indent: number): Record<string, string> {
  const start = lines.findIndex((l) => header.test(l));
  const out: Record<string, string> = {};
  if (start < 0) return out;
  for (const l of lines.slice(start + 1)) {
    const lead = l.length - l.trimStart().length;
    if (lead <= indent) break;
    if (lead === indent + 2) {
      const m = /^\s*([\w-]+):\s*(.*)$/.exec(l);
      if (m) out[m[1]] = unquote(m[2]);
    }
  }
  return out;
}

/** Each job's steps. A step starts at a `- key:` line and takes the keys written beneath it. */
function readJobs(): Record<string, { permissions: Record<string, string>; steps: Step[] }> {
  const jobs: Record<string, { permissions: Record<string, string>; steps: Step[] }> = {};
  const from = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  let job: string | undefined;
  let step: Step | undefined;
  for (const l of lines.slice(from + 1)) {
    const lead = l.length - l.trimStart().length;
    if (lead === 0) break;
    const jobHead = /^ {2}([\w-]+):\s*$/.exec(l);
    if (jobHead) {
      job = jobHead[1];
      jobs[job] = { permissions: {}, steps: [] };
      step = undefined;
      continue;
    }
    if (!job) continue;
    const item = /^ {6}- ([\w-]+):\s*(.*)$/.exec(l);
    if (item) {
      step = { [item[1]]: unquote(item[2]) };
      jobs[job].steps.push(step);
      continue;
    }
    const key = /^ {8}([\w-]+):\s*(.*)$/.exec(l);
    if (key && step) (step as Record<string, string>)[key[1]] = unquote(key[2]);
    if (/^ {4}permissions:/.test(l)) jobs[job].permissions = { declared: l.trim() };
  }
  return jobs;
}

const jobs = readJobs();
const validate = jobs.validate?.steps ?? [];
const images = jobs.images?.steps ?? [];
const secretScan = jobs.secrets?.steps ?? [];
const all = [...validate, ...images, ...secretScan];

/** The step that runs `command` in `dir`, if any. A command may be followed by more arguments. */
const runs = (steps: Step[], command: string | RegExp, dir?: string) =>
  steps.some(
    (s) =>
      s.run !== undefined &&
      (typeof command === 'string' ? s.run === command : command.test(s.run)) &&
      (dir === undefined || s['working-directory'] === dir),
  );

describe('.github/workflows/docs.yml', () => {
  it('reads as three jobs, each with its steps', () => {
    expect(Object.keys(jobs).sort()).toEqual(['images', 'secrets', 'validate']);
    expect(validate.length).toBeGreaterThan(10);
    expect(images.length).toBeGreaterThan(2);
    expect(secretScan.length).toBeGreaterThan(1);
  });

  it('runs on pushes and pull requests to main', () => {
    const on = block(/^on:\s*$/, 0);
    expect(Object.keys(on)).toEqual(expect.arrayContaining(['push', 'pull_request']));
    expect(text).toMatch(/pull_request:\s*\n\s+branches: \[main\]/);
  });

  describe('permissions (SC-17)', () => {
    it('gives the token read access to the repository and nothing else', () => {
      expect(block(/^permissions:\s*$/, 0)).toEqual({ contents: 'read' });
    });

    it('lets no job ask for more than that', () => {
      for (const [name, job] of Object.entries(jobs)) expect(job.permissions, name).toEqual({});
    });

    it('never pushes, deploys or signs in anywhere', () => {
      for (const s of all) expect(s.run ?? '', s.name).not.toMatch(/\b(?:docker\s+(?:push|login)|git\s+push|gh\s|npm\s+publish)/);
    });

    it('pins every action to a full commit SHA and names the tag it was taken from, so a moved tag cannot change what runs', () => {
      const lines = text.split('\n').filter((l) => /^\s*(?:- )?uses:/.test(l));
      // Read off the file as written, comments included: the tag after the SHA is what a person checks.
      expect(lines.length).toBeGreaterThan(4);
      for (const l of lines) expect(l.trim(), l).toMatch(/^(?:- )?uses:\s+[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+$/);
      // The steps the reader found are those lines, so none was skipped for being written another way.
      expect(all.filter((s) => s.uses).length).toBe(lines.length);
    });
  });

  describe('the secret scan (SC-17, SC-06)', () => {
    const job = text.slice(text.indexOf('\n  secrets:'), text.indexOf('\n  images:'));

    it('runs on pushes and pull requests, and not on a manual run, which has no commit range and would read all history', () => {
      expect(job).toMatch(/\n    if: github\.event_name != 'workflow_dispatch'\n/);
    });

    it('checks out the whole history, which is what a scan of a range of commits needs', () => {
      expect(job).toMatch(/uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+fetch-depth: 0\n/);
    });

    it('scans with gitleaks, and publishes nothing a finding could be read from', () => {
      expect(secretScan.some((s) => /^gitleaks\/gitleaks-action@[0-9a-f]{40}$/.test(s.uses ?? ''))).toBe(true);
      // On a public repository a comment or an artifact would repeat the secret it found.
      expect(job).toMatch(/GITLEAKS_ENABLE_COMMENTS: false/);
      expect(job).toMatch(/GITLEAKS_ENABLE_UPLOAD_ARTIFACT: false/);
    });
  });

  describe('the checks the checklist asked for (IN-10)', () => {
    it.each(['server', 'web'])('installs from the lockfile, audits and typechecks %s', (dir) => {
      expect(runs(validate, 'npm ci', dir)).toBe(true);
      expect(runs(validate, 'npm audit --omit=dev --audit-level=high', dir)).toBe(true);
      expect(runs(validate, 'npm run typecheck', dir)).toBe(true);
      expect(runs(validate, 'npm test', dir)).toBe(true);
    });

    it('lints and builds the web app, which also typechecks vite.config.ts', () => {
      expect(runs(validate, 'npm run lint', 'web')).toBe(true);
      expect(runs(validate, 'npm run build', 'web')).toBe(true);
    });

    it.each([
      'server/scripts/openapi.check.ts',
      'server/scripts/erd.check.ts',
      'web/scripts/css.check.mjs',
      'web/scripts/tokens.check.mjs',
      'web/scripts/markdown.check.ts',
      'web/scripts/units.check.ts',
      'web/scripts/links.check.mjs',
      'web/scripts/diagrams.check.mjs',
      'web/scripts/parity.check.mjs',
    ])('runs %s', (script) => {
      expect(runs(validate, new RegExp(`\\s${script.replace(/\./g, '\\.')}(\\s|$)`))).toBe(true);
    });

    it('builds both Docker images without pushing them, and checks the nginx config in the web one', () => {
      expect(runs(images, /^docker build --tag \S+ server$/)).toBe(true);
      const web = images.find((s) => /^docker build --tag \S+ web$/.test(s.run ?? ''));
      expect(web).toBeDefined();
      const tag = /--tag (\S+)/.exec(web?.run ?? '')?.[1] ?? '';
      expect(runs(images, `docker run --rm ${tag} nginx -t`)).toBe(true);
    });
  });

  describe('what its steps point at', () => {
    it('only names directories that exist, with a lockfile where it runs `npm ci`', () => {
      for (const s of all) {
        const dir = s['working-directory'];
        if (dir) expect(existsSync(root(dir)), `${s.name}: ${dir}`).toBe(true);
        if (s.run === 'npm ci') expect(existsSync(root(`${dir}/package-lock.json`)), s.name).toBe(true);
      }
    });

    it('only runs npm scripts that the package defines', () => {
      for (const s of all) {
        const m = /^npm (?:run (\S+)|(test))$/.exec(s.run ?? '');
        if (!m) continue;
        const scripts = JSON.parse(readFileSync(root(`${s['working-directory']}/package.json`), 'utf8')).scripts;
        expect(Object.keys(scripts), `${s.name}: ${s.run}`).toContain(m[1] ?? m[2]);
      }
    });

    it('only runs scripts that exist', () => {
      for (const s of all) {
        for (const m of (s.run ?? '').matchAll(/\b((?:server|web)\/scripts\/[\w.-]+)/g)) {
          expect(existsSync(root(m[1])), `${s.name}: ${m[1]}`).toBe(true);
        }
      }
    });

    it('builds each image from a folder that holds its Dockerfile', () => {
      for (const s of images) {
        const m = /^docker build --tag \S+ (\S+)$/.exec(s.run ?? '');
        if (m) expect(existsSync(root(`${m[1]}/Dockerfile`)), s.name).toBe(true);
      }
    });
  });
});

describe('.github/dependabot.yml (SC-17, SC-21)', () => {
  const file = readFileSync(root('.github/dependabot.yml'), 'utf8');
  const entries = [...file.matchAll(/- package-ecosystem: (\S+)\n\s+directory: (\S+)/g)].map((m) => `${m[1]} ${m[2]}`);

  it('is version 2 and covers the actions, both npm projects and both Dockerfiles', () => {
    expect(file).toMatch(/^version: 2$/m);
    expect(entries.sort()).toEqual(['docker /server', 'docker /web', 'github-actions /', 'npm /server', 'npm /web']);
  });

  it('points only at folders that hold what its ecosystem reads', () => {
    for (const entry of entries) {
      const [kind, dir] = entry.split(' ');
      const where = dir === '/' ? '' : dir.slice(1);
      if (kind === 'npm') expect(existsSync(root(`${where}/package.json`)), entry).toBe(true);
      if (kind === 'docker') expect(existsSync(root(`${where}/Dockerfile`)), entry).toBe(true);
      if (kind === 'github-actions') expect(existsSync(root('.github/workflows')), entry).toBe(true);
    }
  });

  it('looks every week, so a pinned SHA or digest is never left to age', () => {
    expect([...file.matchAll(/interval: weekly/g)].length).toBe(entries.length);
  });
});
