// Starts `vite preview` (serving dist/ under the Pages base path) for a QA run.
import { execSync, spawn } from 'node:child_process';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startPreview(root, port, basePath) {
  const url = `http://127.0.0.1:${port}${basePath}`;
  const child = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  const stop = () => {
    if (child.exitCode !== null) return;
    try {
      // Windows: kill the whole tree, or the server outlives the script.
      if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  };
  process.on('exit', stop);
  return { url, stop };
}
