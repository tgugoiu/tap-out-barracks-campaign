// Checks public/magazine against its manifest before a build or a release.
//
//   node scripts/validate-publication.mjs [--dir public/magazine] [--pdf path/to/source.pdf]
//
// Fails on: missing or extra (orphaned) files, size or dimension mismatches,
// broken placeholders, a bundled PDF that differs from the manifest, files
// GitHub would reject (>100 MB). Warns on files over GitHub's 50 MB warning.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const DIR = path.resolve(ROOT, arg('--dir', 'public/magazine'));
const PDF = arg('--pdf', null);

const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Width/height from a WebP header (VP8, VP8L or VP8X). */
function webpSize(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  if (kind === 'VP8X') return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
  return null;
}

if (!fs.existsSync(path.join(DIR, 'manifest.json'))) {
  console.error(`No manifest at ${path.relative(ROOT, DIR)}/manifest.json. Run: npm run pages -- path/to/magazine.pdf`);
  process.exit(1);
}
const m = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
if (m.schema !== 1) fail(`unknown manifest schema ${m.schema}`);
if (!Array.isArray(m.pages) || m.pages.length === 0) fail('manifest lists no pages');
const pages = m.pages ?? [];
if (m.pageCount !== pages.length) fail(`pageCount ${m.pageCount} but ${pages.length} pages listed`);

const expected = new Set(['manifest.json']);
let pageBytes = 0;
let thumbBytes = 0;
pages.forEach((p, i) => {
  const n = i + 1;
  if (p.number !== n) fail(`page ${n}: number is ${p.number}`);
  for (const [kind, src, w, h, bytes] of [
    ['page', p.src, p.width, p.height, p.bytes],
    ['thumb', p.thumb?.src, p.thumb?.width, p.thumb?.height, p.thumb?.bytes],
  ]) {
    if (!src) {
      fail(`page ${n}: no ${kind} src`);
      continue;
    }
    expected.add(src);
    const file = path.join(DIR, src);
    if (!fs.existsSync(file)) {
      fail(`page ${n}: missing ${kind} ${src}`);
      continue;
    }
    const size = fs.statSync(file).size;
    if (bytes !== undefined && size !== bytes) fail(`page ${n}: ${kind} is ${size} bytes, manifest says ${bytes}`);
    const dims = webpSize(file);
    if (!dims) fail(`page ${n}: ${kind} is not a readable WebP`);
    else if (dims[0] !== w || dims[1] !== h) fail(`page ${n}: ${kind} is ${dims.join('x')}, manifest says ${w}x${h}`);
    if (kind === 'page') pageBytes += size;
    else thumbBytes += size;
  }
  if (!/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(p.lqip ?? '')) fail(`page ${n}: placeholder missing or malformed`);
  const ratio = p.width / p.height;
  const ref = m.pageSize.width / m.pageSize.height;
  if (Math.abs(ratio - ref) / ref > 0.006) warn(`page ${n}: aspect ${ratio.toFixed(4)} differs from the book's ${ref.toFixed(4)}; it will be letterboxed`);
});

for (const extra of ['og', 'icon']) {
  if (!m[extra]) continue;
  expected.add(m[extra].src);
  if (!fs.existsSync(path.join(DIR, m[extra].src))) fail(`missing ${extra} image ${m[extra].src}`);
}
if (m.download) {
  expected.add(m.download.src);
  const file = path.join(DIR, m.download.src);
  if (!fs.existsSync(file)) fail(`missing bundled PDF ${m.download.src}`);
  else {
    if (fs.statSync(file).size !== m.download.bytes) fail('bundled PDF size differs from the manifest');
    if (m.download.sha256 && sha256(file) !== m.download.sha256) fail('bundled PDF hash differs from the manifest');
  }
}

const found = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else found.push(path.relative(DIR, full).replaceAll('\\', '/'));
  }
})(DIR);
for (const f of found) {
  if (!expected.has(f)) fail(`orphaned file not in the manifest: ${f}`);
  const size = fs.statSync(path.join(DIR, f)).size;
  if (size > 100 * 1024 * 1024) fail(`${f} is over GitHub's 100 MB file limit`);
  else if (size > 50 * 1024 * 1024) warn(`${f} is over GitHub's 50 MB warning size`);
}

if (PDF) {
  const src = path.resolve(PDF);
  if (sha256(src) !== m.source?.sha256) fail(`manifest was built from a different PDF than ${PDF}`);
}

const spreads = ['[1]'];
for (let i = 1; i < pages.length; i += 2) spreads.push(i < pages.length - 1 ? `[${i + 1}|${i + 2}]` : `[${i + 1}]`);
const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
console.log(`Publication  ${pages.length} pages from ${m.source?.fileName ?? '?'} (${m.generatedAt ?? 'unknown date'})`);
console.log(`Assets       pages ${mb(pageBytes)}, thumbs ${mb(thumbBytes)}${m.download ? `, PDF ${mb(m.download.bytes)}` : ', no bundled PDF'}`);
console.log(`Spreads      ${spreads.join(' ')}`);
if (pages.length % 2 === 1) warn('odd page count: the last page shares a spread instead of standing alone as a back cover');
for (const w of warnings) console.log(`WARNING      ${w}`);
for (const e of errors) console.log(`ERROR        ${e}`);
console.log(errors.length ? `\n${errors.length} problem(s) found.` : '\nPublication is valid.');
process.exit(errors.length ? 1 : 0);
