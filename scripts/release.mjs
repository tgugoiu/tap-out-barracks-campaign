// One command for a new edition: render pages, validate, typecheck, build.
//   npm run release -- path/to/final.pdf [pipeline options, e.g. --no-include-pdf]
// Then review `npm run preview`, commit public/magazine and push; GitHub Actions deploys.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('-')) {
  console.error('Usage: npm run release -- path/to/final.pdf [pipeline options]');
  process.exit(2);
}
const node = (script, extra = []) => spawnSync(process.execPath, [path.join(ROOT, script), ...extra], { stdio: 'inherit', cwd: ROOT }).status;
const step = (name, code) => {
  if (code !== 0) {
    console.error(`\n✗ ${name} failed; nothing was published.`);
    process.exit(code || 1);
  }
  console.log(`✓ ${name}\n`);
};

console.log('— Rendering pages');
step('pages rendered', runPipeline(args));
console.log('— Validating');
step('publication valid', node('scripts/validate-publication.mjs', ['--pdf', args[0]]));
console.log('— Type-checking');
step('types clean', node('node_modules/typescript/bin/tsc', ['--noEmit']));
console.log('— Building');
step('site built in dist/', node('node_modules/vite/bin/vite.js', ['build']));

console.log(`Next:
  npm run preview                       # check it at http://127.0.0.1:4180/<repo>/
  git add -A public/magazine
  git commit -m "Publish edition: <name>"
  git push                              # GitHub Actions builds and deploys`);
