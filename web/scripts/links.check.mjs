/**
 * Every relative link in the repo's Markdown points at a file that exists, with
 * the same spelling.
 *
 * macOS resolves a wrong-case path, so a link can work on a laptop and 404 on a
 * case-sensitive checkout. Each path segment is therefore matched against the
 * real directory listing. Links inside code are not links and are skipped, and
 * so are the two historical records, whose links describe the tree as it was.
 *
 * Read: inline links (with a title or a <...> target), reference definitions,
 * HTML href and src, and "/x" as the repo root. Not recognised: indented code
 * blocks, so a link-like text in one is checked like prose.
 *
 * Also checked: a line citation in backticks, such as `server/src/rateLimit.ts:22-35`, must not run past the end of its file.
 * That proves the lines exist, not that they say what the sentence does. The records of past days (tracker.md, CHANGELOG.md, AUDIT_REPORT.md) are left out.
 *
 *   node web/scripts/links.check.mjs [repo root]   (default: two levels up)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
/** Historical records: their links describe the tree as it was when they were written. */
const SKIP_FILES = new Set(['AUDIT_REPORT.md', 'README_copy.md']);
/** Their line citations were right on the day and are evidence, not a pointer into today's code. */
const CITATION_SKIP = new Set(['tracker.md', 'CHANGELOG.md', 'AUDIT_REPORT.md', 'README_copy.md']);

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// [text](target "title"), where target may be <with spaces> or hold one level of balanced ().
const INLINE = /\]\(\s*(<[^>\n]*>|[^\s()<]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(<[^>\n]*>|\S+)/;
// `path/to/file.ext:12` or `:12-30`, alone in its backticks.
const CITATION = /`((?:[\w@.-]+\/)*[\w@.-]+\.[a-z]{1,4}):(\d+)(?:-(\d+))?`/g;
const HTML = /<(?:a|img|source)\b[^>]*?\s(?:href|src)\s*=\s*["']([^"']+)["']/gi;

/** Every Markdown file under `root`, as absolute paths. */
function markdownFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Relative link targets in `text`, with their line numbers, outside code and HTML comments. */
export function relativeLinks(text) {
  const links = [];
  let fence = null; // the opening fence while inside a fenced block
  let comment = false;
  text.split('\n').forEach((raw, i) => {
    if (fence) {
      const close = raw.match(FENCE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !raw.slice(close[0].length).trim()) fence = null;
      return;
    }
    let line = raw;
    if (comment) {
      const end = line.indexOf('-->');
      if (end < 0) return;
      line = line.slice(end + 3);
      comment = false;
    }
    const open = line === raw ? line.match(FENCE) : null;
    if (open) {
      fence = open[1];
      return;
    }
    line = line.replace(/<!--[\s\S]*?-->/g, '');
    const start = line.indexOf('<!--');
    if (start >= 0) {
      line = line.slice(0, start);
      comment = true;
    }
    line = line.replace(/(`+)[^`]*?\1/g, '');
    const targets = [...line.matchAll(INLINE), ...line.matchAll(HTML)].map((m) => m[1]);
    const ref = line.match(REFERENCE);
    if (ref) targets.push(ref[1]);
    for (const t of targets) {
      const target = t.replace(/^<|>$/g, '');
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      links.push({ line: i + 1, target });
    }
  });
  return links;
}

/** Line citations in `text` (`file.ts:12-30`), outside fenced code. */
export function lineCitations(text) {
  const found = [];
  let fence = null;
  text.split('\n').forEach((raw, i) => {
    if (fence) {
      const close = raw.match(FENCE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !raw.slice(close[0].length).trim()) fence = null;
      return;
    }
    const open = raw.match(FENCE);
    if (open) {
      fence = open[1];
      return;
    }
    for (const m of raw.matchAll(CITATION)) {
      found.push({ line: i + 1, path: m[1], from: Number(m[2]), to: Number(m[3] ?? m[2]) });
    }
  });
  return found;
}

/** The file a citation names: from the repo root, or the way the documents shorten it (`routes/x.ts`), or beside the document. */
function citedFile(root, docDir, path) {
  for (const base of [root, join(root, 'server', 'src'), join(root, 'web', 'src'), docDir]) {
    const candidate = resolve(base, path);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not there: try the next place
    }
  }
  return null;
}

const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

/** Whether `path` exists under `root` with exactly this spelling, segment by segment. */
function existsExactly(root, path, listings) {
  const rel = relative(root, path);
  if (rel === '') return true;
  if (rel.split(sep)[0] === '..') return false;
  let dir = root;
  for (const part of rel.split(sep)) {
    if (!listings.has(dir)) {
      try {
        listings.set(dir, new Set(readdirSync(dir)));
      } catch {
        return false;
      }
    }
    if (!listings.get(dir).has(part)) return false;
    dir = join(dir, part);
  }
  return true;
}

/** Broken links and overrunning citations under `root`, and how many of each were checked. */
export function checkLinks(root) {
  const listings = new Map();
  const broken = [];
  const overrun = [];
  let checked = 0;
  let cited = 0;
  const lengths = new Map();
  const files = markdownFiles(root);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!CITATION_SKIP.has(file.split(sep).at(-1))) {
      for (const c of lineCitations(text)) {
        const target = citedFile(root, dirname(file), c.path);
        if (!target) continue; // not a path of this repository: prose, or a file outside it
        cited++;
        if (!lengths.has(target)) lengths.set(target, lineCount(readFileSync(target, 'utf8')));
        const last = lengths.get(target);
        if (c.from < 1 || c.to < c.from || c.to > last) {
          overrun.push(`${relative(root, file)}:${c.line}  ${c.path}:${c.from}${c.to === c.from ? '' : `-${c.to}`}  (the file has ${last} lines)`);
        }
      }
    }
    for (const { line, target } of relativeLinks(text)) {
      checked++;
      let path = target.split(/[#?]/)[0];
      try {
        path = decodeURIComponent(path);
      } catch {
        // A stray "%" is a literal character, not an escape.
      }
      path = path.startsWith('/') ? join(root, path) : resolve(dirname(file), path);
      if (!existsExactly(root, path, listings)) broken.push(`${relative(root, file)}:${line}  ${target}`);
    }
  }
  return { files: files.length, checked, broken, cited, overrun };
}

// Self-test of the extractor: each Markdown sample and the targets it must yield.
const cases = [
  ['[a](x.md) [b](https://e.com) [c](#top) [d](mailto:a@b.c)', ['x.md']],
  ['[a](x.md "Title") [b](<my file.md>) [c](a_(b).md)', ['x.md', 'my file.md', 'a_(b).md']],
  ['[r]: ref.md "T"\n[^1]: a footnote\n   [s]: <sp ace.md>', ['ref.md', 'sp ace.md']],
  ['<a href="h.md">h</a> <img alt="i" src="i.png">', ['h.md', 'i.png']],
  ['`[a](no.md)` ``[b](no.md)`` [c](yes.md)', ['yes.md']],
  ['```\n[a](no.md)\n```\n~~~\n[b](no.md)\n~~~\n[c](yes.md)', ['yes.md']],
  ['````\n```\n[a](no.md)\n```\n````\n[b](yes.md)', ['yes.md']],
  ['<!-- [a](no.md) --> [b](yes.md)\n<!--\n[c](no.md)\n--> [d](yes2.md)', ['yes.md', 'yes2.md']],
];
for (const [md, expected] of cases) {
  const found = relativeLinks(md).map((l) => l.target);
  if (JSON.stringify(found) !== JSON.stringify(expected)) {
    console.error(`links.check self-test failed: expected ${JSON.stringify(expected)}, found ${JSON.stringify(found)} in:\n${md}`);
    process.exit(1);
  }
}

// Self-test of the citation reader.
const citeCases = [
  ['see `a/b.ts:12` and `c.mjs:3-9`, not `d.ts` or `e.ts:x`', [['a/b.ts', 12, 12], ['c.mjs', 3, 9]]],
  ['```\n`in/fence.ts:4`\n```\n`after.ts:1`', [['after.ts', 1, 1]]],
  ['`server/src/rateLimit.ts:22-35`.', [['server/src/rateLimit.ts', 22, 35]]],
];
for (const [md, expected] of citeCases) {
  const found = lineCitations(md).map((c) => [c.path, c.from, c.to]);
  if (JSON.stringify(found) !== JSON.stringify(expected)) {
    console.error(`links.check citation self-test failed: expected ${JSON.stringify(expected)}, found ${JSON.stringify(found)} in:\n${md}`);
    process.exit(1);
  }
}

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
if (!statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
const { files, checked, broken, cited, overrun } = checkLinks(root);
for (const b of broken) console.error(b);
for (const o of overrun) console.error(o);
if (broken.length || overrun.length) {
  if (broken.length) console.error(`\nlinks.check: ${broken.length} of ${checked} relative links in ${files} files do not resolve.`);
  if (overrun.length) console.error(`links.check: ${overrun.length} of ${cited} line citations run past the end of their file.`);
  process.exit(1);
}
console.log(`links.check: ${checked} relative links in ${files} files, all resolve; ${cited} line citations, none past the end of its file.`);
