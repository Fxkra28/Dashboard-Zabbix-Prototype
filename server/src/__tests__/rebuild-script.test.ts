import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * deploy/rebuild.sh (tracker IN-01), run as a dry run in small git trees with a stand-in for docker.
 *
 * A dry run changes nothing, so it can say what a real run would do: which commit names the build,
 * which images are kept for a rollback, in which order the copies are built, and what makes the
 * script refuse. The real run (docker, curl, a tag) is what a person watches the first time.
 */
const script = fileURLToPath(new URL('../../../deploy/rebuild.sh', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'rebuild-script-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A docker that answers the one read-only question a dry run asks: does this image tag exist?
// `:latest` always does; any other tag only when FAKE_EXISTING (a regular expression) matches it.
const bin = join(scratch, 'bin');
mkdirSync(bin);
writeFileSync(
  join(bin, 'docker'),
  `#!/usr/bin/env bash
if [ "$1" = image ] && [ "$2" = inspect ]; then
  case "$3" in *:latest) exit 0 ;; esac
  if [ -n "\${FAKE_EXISTING:-}" ] && printf '%s' "$3" | grep -Eq "$FAKE_EXISTING"; then exit 0; fi
  exit 1
fi
echo "unexpected docker call: $*" >&2
exit 99
`,
);
chmodSync(join(bin, 'docker'), 0o755);

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

/** A committed git tree named `name` that holds the script, with `siblings` beside it (copies with no git). */
function tree(label: string, name = 'hcml-portal', siblings: string[] = []): string {
  const parent = join(scratch, label);
  for (const dir of [name, ...siblings]) {
    mkdirSync(join(parent, dir, 'server'), { recursive: true });
    mkdirSync(join(parent, dir, 'web'), { recursive: true });
    writeFileSync(join(parent, dir, 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(join(parent, dir, 'server', 'a.ts'), 'one\n');
    writeFileSync(join(parent, dir, 'web', 'b.ts'), 'two\n');
    mkdirSync(join(parent, dir, 'server', 'src', '__tests__'), { recursive: true });
    writeFileSync(join(parent, dir, 'server', 'src', '__tests__', 'a.test.ts'), 'test\n');
    writeFileSync(join(parent, dir, 'web', 'c.test.tsx'), 'test\n');
  }
  const root = join(parent, name);
  mkdirSync(join(root, 'deploy'));
  copyFileSync(script, join(root, 'deploy', 'rebuild.sh'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');
  return root;
}
const head = (root: string) => git(root, 'rev-parse', '--short', 'HEAD').stdout.trim();

/** The script, run to its end. A script that loops is killed after twenty seconds and fails its test, instead of hanging the suite. */
function rebuild(root: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [join(root, 'deploy', 'rebuild.sh'), ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ...env },
  });
  if (r.error) throw r.error;
  return r;
}

describe('deploy/rebuild.sh, as a dry run', () => {
  it('is executable, and answers --help with its own header', () => {
    expect(statSync(script).mode & 0o111).not.toBe(0);
    const r = rebuild(tree('help'), ['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('deploy/rebuild.sh [--dry-run] [--skip-verify] [--allow-dirty]');
    expect(r.stdout).not.toContain('set -euo');
  });

  it('plans a build named by the commit: a rollback tag for each image, the build arguments, then the tag that says what is live', () => {
    const root = tree('clean');
    const r = rebuild(root, ['--dry-run', '--skip-verify']);
    expect(r.status).toBe(0);
    const sha = head(root);
    expect(r.stdout).toContain(`Build ${sha},`);
    expect(r.stdout).not.toContain('-dirty');
    expect(r.stdout).toMatch(/\+ docker tag hcml-portal-portal-bff:latest hcml-portal-portal-bff:rollback-\d+[a-z]{3}\n/);
    expect(r.stdout).toMatch(/\+ docker tag hcml-portal-portal-web:latest hcml-portal-portal-web:rollback-\d+[a-z]{3}\n/);
    expect(r.stdout).toContain(`+ env BUILD_COMMIT=${sha} BUILD_TIME=`);
    expect(r.stdout).toContain(`docker compose --project-directory ${root} up -d --build`);
    expect(r.stdout).toMatch(new RegExp(`\\+ git -C ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} tag -a live-\\d{4}-\\d{2}-\\d{2} ${sha} `));
    expect(r.stdout).toContain('The tag is local. To make it public: git push origin live-');
    expect(r.stdout.trimEnd().endsWith('Dry run: nothing was changed.')).toBe(true);
    // A dry run makes no tag and no image: the one repository it touches still has no tag.
    expect(git(root, 'tag').stdout).toBe('');
  });

  it('plans npm run verify first unless it is told to skip it', () => {
    const root = tree('verify');
    expect(rebuild(root, ['--dry-run']).stdout).toContain(`+ npm --prefix ${root} run verify`);
    expect(rebuild(root, ['--dry-run', '--skip-verify']).stdout).not.toContain('run verify');
  });

  it('builds the local-model copy after the hosted one, behind a check that the two copies match', () => {
    const root = tree('both', 'hcml-portal', ['hcml-portal-ollama']);
    const out = rebuild(root, ['--dry-run', '--skip-verify']).stdout;
    expect(out).toContain(`+ node ${root}/tools/check/parity.check.mjs`);
    const hosted = out.indexOf('== hcml-portal\n');
    const local = out.indexOf('== hcml-portal-ollama\n');
    expect(hosted).toBeGreaterThan(out.indexOf('parity.check.mjs'));
    expect(local).toBeGreaterThan(hosted);
    expect(out).toContain('docker tag hcml-portal-ollama-portal-bff:latest hcml-portal-ollama-portal-bff:rollback-');
    expect(out).toContain(`--project-directory ${root}-ollama up -d --build`);
  });

  it('builds the folder it is in and nothing else when there is no sibling', () => {
    const out = rebuild(tree('alone'), ['--dry-run', '--skip-verify']).stdout;
    expect(out).not.toContain('parity.check.mjs');
    expect(out).not.toContain('ollama');
  });

  it('takes the next free rollback tag of an image, so a second build in one day keeps the first', () => {
    const out = rebuild(tree('second'), ['--dry-run', '--skip-verify'], { FAKE_EXISTING: '^hcml-portal-portal-bff:rollback-[0-9]+[a-z]+$' }).stdout;
    expect(out).toMatch(/hcml-portal-portal-bff:rollback-\d+[a-z]{3}-2\n/);
    expect(out).toMatch(/hcml-portal-portal-web:rollback-\d+[a-z]{3}\n/);
  });

  it('stops looking for a free rollback tag after fifty, whatever docker says', () => {
    const r = rebuild(tree('every-tag'), ['--dry-run', '--skip-verify'], { FAKE_EXISTING: 'rollback-' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/hcml-portal-portal-bff:rollback-\d+[a-z]{3}-50\n/);
  });

  it('refuses a tree whose server/, web/ or compose file differ from the commit', () => {
    for (const path of ['server/a.ts', 'web/b.ts', 'docker-compose.yml']) {
      const root = tree(`dirty-${path.replace(/\W/g, '-')}`);
      writeFileSync(join(root, path), 'changed\n');
      const r = rebuild(root, ['--dry-run', '--skip-verify']);
      expect(r.status, path).toBe(1);
      expect(r.stderr, path).toContain('differ from');
      expect(r.stdout, path).not.toContain('docker compose');
    }
  });

  it('does not mind a new or changed test, which no image holds', () => {
    const root = tree('tests');
    writeFileSync(join(root, 'server', 'src', '__tests__', 'a.test.ts'), 'changed\n');
    writeFileSync(join(root, 'server', 'src', '__tests__', 'new.test.ts'), 'new\n');
    writeFileSync(join(root, 'web', 'c.test.tsx'), 'changed\n');
    const r = rebuild(root, ['--dry-run', '--skip-verify']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('-dirty');
  });

  it('does not mind a change elsewhere, such as a document', () => {
    const root = tree('docs');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'a.md'), 'new\n');
    const r = rebuild(root, ['--dry-run', '--skip-verify']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('-dirty');
  });

  it('with --allow-dirty labels the build dirty and plans no tag', () => {
    const root = tree('allow');
    writeFileSync(join(root, 'server', 'a.ts'), 'changed\n');
    const r = rebuild(root, ['--dry-run', '--skip-verify', '--allow-dirty']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`BUILD_COMMIT=${head(root)}-dirty`);
    expect(r.stdout).not.toContain(' tag -a live-');
  });

  it('refuses a folder that is not a git checkout, and an option it does not know', () => {
    const root = tree('nogit');
    rmSync(join(root, '.git'), { recursive: true });
    const r = rebuild(root, ['--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not a git checkout');
    const bad = rebuild(tree('badflag'), ['--force']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('unknown option --force');
  });
});
