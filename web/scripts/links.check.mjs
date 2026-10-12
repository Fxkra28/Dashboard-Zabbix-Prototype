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
 *   node web/scripts/links.check.mjs [repo root]   (default: two levels up)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
/** Historical records: their links describe the tree as it was when they were written. */
const SKIP_FILES = new Set(['AUDIT_REPORT.md', 'README_copy.md']);

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// [text](target "title"), where target may be <with spaces> or hold one level of balanced ().
const INLINE = /\]\(\s*(<[^>\n]*>|[^\s()<]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(<[^>\n]*>|\S+)/;
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

/** Broken links under `root`, and how many links were checked. */
export function checkLinks(root) {
  const listings = new Map();
  const broken = [];
  let checked = 0;
  const files = markdownFiles(root);
  for (const file of files) {
    for (const { line, target } of relativeLinks(readFileSync(file, 'utf8'))) {
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
  return { files: files.length, checked, broken };
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

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
if (!statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
const { files, checked, broken } = checkLinks(root);
for (const b of broken) console.error(b);
if (broken.length) {
  console.error(`\nlinks.check: ${broken.length} of ${checked} relative links in ${files} files do not resolve.`);
  process.exit(1);
}
console.log(`links.check: ${checked} relative links in ${files} files, all resolve.`);
