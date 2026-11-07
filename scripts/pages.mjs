// Runs the PDF-to-pages pipeline with whichever Python is available.
//   npm run pages -- path/to/magazine.pdf [--no-include-pdf] [--long-edge 1600] ...
// Set PYTHON to choose an interpreter. Needs: python -m pip install -r pipeline/requirements.txt
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function findPython() {
  const candidates = process.env.PYTHON ? [process.env.PYTHON] : process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info >= (3, 9))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return cmd;
  }
  return null;
}

export function runPipeline(args) {
  const py = findPython();
  if (!py) {
    console.error('Python 3.9+ not found. Install it, or set PYTHON=/path/to/python.');
    return 2;
  }
  const r = spawnSync(py, [path.join(ROOT, 'pipeline', 'build_publication.py'), ...args], { stdio: 'inherit', cwd: ROOT });
  return r.status ?? 1;
}

if (import.meta.url === `file:///${process.argv[1].replaceAll('\\', '/').replace(/^\//, '')}` || process.argv[1]?.endsWith('pages.mjs')) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0].startsWith('-')) {
    console.error('Usage: npm run pages -- path/to/magazine.pdf [pipeline options]');
    process.exit(2);
  }
  process.exit(runPipeline(args));
}
