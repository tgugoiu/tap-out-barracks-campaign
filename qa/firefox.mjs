// Firefox QA over WebDriver BiDi, using stock Firefox and Node's built-in WebSocket.
//
//   npm run build && node qa/firefox.mjs            (serves dist/ on port 4182)
//   FIREFOX_EXE="C:/Program Files/Mozilla Firefox/firefox.exe" node qa/firefox.mjs --url <url>
//
// Writes qa-out/firefox-report.json and qa-out/shots/firefox-*.png.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPreview } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa-out');
const SHOTS = path.join(OUT, 'shots');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FF = process.env.FIREFOX_EXE || 'C:/Program Files/Mozilla Firefox/firefox.exe';

const site = JSON.parse(await fs.readFile(path.join(ROOT, 'site.config.json'), 'utf8'));
const BASE_PATH = new URL(site.siteUrl).pathname;
const COUNT = JSON.parse(await fs.readFile(path.join(ROOT, 'dist/magazine/manifest.json'), 'utf8')).pages.length;
await fs.mkdir(SHOTS, { recursive: true });

let URL_ = arg('--url', '');
let server = null;
if (!URL_) {
  server = await startPreview(ROOT, 4182, BASE_PATH);
  URL_ = server.url;
}

const report = { at: new Date().toISOString(), url: URL_, firefox: null, checks: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
};

async function withFirefox(prefs, fn) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tob-ff-'));
  await fs.writeFile(
    path.join(profile, 'user.js'),
    Object.entries({ 'browser.shell.checkDefaultBrowser': false, 'datareporting.policy.dataSubmissionEnabled': false, ...prefs })
      .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
      .join('\n'),
  );
  const port = 9400 + Math.floor(Math.random() * 400);
  const ff = spawn(FF, ['-headless', '-no-remote', '-profile', profile, '--remote-debugging-port', String(port), 'about:blank'], { stdio: 'ignore' });
  let ws;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(500);
    try {
      ws = await new Promise((res, rej) => {
        const s = new WebSocket(`ws://127.0.0.1:${port}/session`);
        s.onopen = () => res(s);
        s.onerror = rej;
      });
    } catch {
      /* retry */
    }
  }
  if (!ws) throw new Error('Firefox BiDi socket did not open');
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'log.entryAdded' && d.params.level === 'error') errors.push(d.params.text);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      if (d.type === 'error') p.rej(new Error(`${d.error}: ${d.message}`));
      else p.res(d.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  try {
    const s = await send('session.new', { capabilities: {} });
    report.firefox = s.capabilities.browserVersion;
    await send('session.subscribe', { events: ['log.entryAdded'] });
    const ctx = (await send('browsingContext.getTree', {})).contexts[0].context;
    const ev = async (expr) => {
      const r = await send('script.evaluate', { expression: expr, target: { context: ctx }, awaitPromise: true, resultOwnership: 'none' });
      if (r.type === 'exception') throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };
    const json = async (expr) => JSON.parse(await ev(`JSON.stringify(${expr})`));
    const api = {
      ctx,
      send,
      ev,
      json,
      errors,
      async viewport(width, height, dpr = 1) {
        await send('browsingContext.setViewport', { context: ctx, viewport: { width, height }, devicePixelRatio: dpr });
      },
      async go(url) {
        await send('browsingContext.navigate', { context: ctx, url, wait: 'complete' });
      },
      async ready() {
        for (let i = 0; i < 200; i++) {
          if (await ev(`Boolean(window.__tob && !document.getElementById('app').classList.contains('is-loading'))`)) return;
          await sleep(100);
        }
        throw new Error('reader never became ready');
      },
      async settle(extra = 150) {
        for (let i = 0; i < 150; i++) {
          if (await ev('Boolean(window.__tob && !window.__tob.busy)')) break;
          await sleep(60);
        }
        await sleep(extra);
      },
      state: () => json(`{ spread: __tob.spread, mode: __tob.mode, renderer: __tob.renderer, hash: location.hash, folio: document.getElementById('folio').textContent.replace(/\\s+/g,' ').trim() }`),
      async key(value) {
        await send('input.performActions', {
          context: ctx,
          actions: [{ type: 'key', id: 'kb', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }],
        });
      },
      async shot(name) {
        await ev(`Promise.all([...document.querySelectorAll('.page__img, .zoom__img, .sheet__img')].filter(i => i.src).map(i => i.decode().catch(() => {}))).then(() => true)`);
        const r = await send('browsingContext.captureScreenshot', { context: ctx });
        await fs.writeFile(path.join(SHOTS, `firefox-${name}.png`), Buffer.from(r.data, 'base64'));
      },
    };
    await fn(api);
  } finally {
    try {
      await send('session.end', {});
    } catch {
      /* closing */
    }
    ws.close();
    ff.kill();
    await sleep(400);
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

const RIGHT = '\uE014';
const END = '\uE010';

try {
  await withFirefox({}, async (b) => {
    console.log('Firefox', report.firefox, '·', URL_);
    await b.viewport(1440, 900);
    await b.go(URL_);
    await b.ready();
    await b.settle(400);
    let s = await b.state();
    check('[firefox desktop] cover alone, page-turn renderer', JSON.stringify(s.spread) === '[0]' && s.mode === 'landscape' && s.renderer === 'flip', s);
    await b.shot('desktop-01-cover');

    await b.key(RIGHT);
    await sleep(320);
    await b.shot('desktop-02-mid-turn');
    await b.settle();
    s = await b.state();
    check('[firefox desktop] ArrowRight opens 2–3', JSON.stringify(s.spread) === '[1,2]' && s.hash === '#page=2', s);
    await b.shot('desktop-03-spread');

    for (let i = 0; i < 6; i++) {
      await b.key(RIGHT);
      await sleep(70);
    }
    await b.settle(400);
    s = await b.state();
    check('[firefox desktop] rapid presses land on 14–15', JSON.stringify(s.spread) === '[13,14]', s);

    await b.ev(`location.hash = '#page=40'`);
    await sleep(100);
    await b.settle(400);
    s = await b.state();
    check('[firefox desktop] hash edit turns to 40–41', JSON.stringify(s.spread) === '[39,40]', s);

    await b.key('t');
    await sleep(900);
    const ov = await b.json(`{ open: document.getElementById('overview').classList.contains('is-open'), thumbs: [...document.querySelectorAll('.sheet__img')].filter(i => i.complete && i.naturalWidth).length }`);
    check('[firefox desktop] overview opens with thumbnails', ov.open && ov.thumbs > 0, ov);
    await b.shot('desktop-04-overview');
    await b.ev(`document.querySelector('button.sheet[aria-label="Pages 6 and 7"]').click()`);
    await sleep(100);
    await b.settle(500);
    s = await b.state();
    check('[firefox desktop] overview jump to 6–7', JSON.stringify(s.spread) === '[5,6]', s);

    await b.key('z');
    await sleep(500);
    await b.shot('desktop-05-zoom');
    const zoomOpen = await b.ev(`!document.getElementById('zoom').hidden`);
    await b.key('\uE00C'); // Escape
    await sleep(400);
    check('[firefox desktop] detail view opens and Escape closes it', zoomOpen && (await b.ev(`document.getElementById('zoom').hidden`)));

    await b.key(END);
    await b.settle(900);
    s = await b.state();
    check('[firefox desktop] End shows the back cover alone', JSON.stringify(s.spread) === JSON.stringify([COUNT - 1]), s);
    await b.shot('desktop-06-back-cover');

    await b.viewport(900, 1150);
    await sleep(600);
    s = await b.state();
    check('[firefox desktop] tall window → single pages', s.mode === 'portrait', s);

    const idle = await b.json(`(() => { const before = performance.now(); return { now: before }; })()`);
    void idle;

    await b.viewport(390, 844, 3);
    await b.go(`${URL_}#page=12`);
    await b.ready();
    await b.settle(400);
    s = await b.state();
    const of = await b.json(`{ sw: document.documentElement.scrollWidth, vw: innerWidth }`);
    check('[firefox phone] #page=12 opens page 12 as a single page, no overflow', JSON.stringify(s.spread) === '[11]' && s.mode === 'portrait' && of.sw <= of.vw, { s, of });
    await b.shot('phone-01-page-12');
    await b.viewport(844, 390, 3);
    await sleep(600);
    s = await b.state();
    check('[firefox phone] rotated → spread 12–13', s.mode === 'landscape' && JSON.stringify(s.spread) === '[11,12]', s);
    await b.shot('phone-02-landscape');
    check('[firefox] no script errors', b.errors.length === 0, b.errors);
  });

  await withFirefox({ 'ui.prefersReducedMotion': 1 }, async (b) => {
    await b.viewport(1440, 900);
    await b.go(URL_);
    await b.ready();
    let s = await b.state();
    check('[firefox reduced motion] non-animated reader', s.renderer === 'simple', s);
    await b.key(RIGHT);
    await sleep(80);
    s = await b.state();
    check('[firefox reduced motion] instant page change', JSON.stringify(s.spread) === '[1,2]', s);
    await b.shot('reduced-motion');
    check('[firefox reduced motion] no script errors', b.errors.length === 0, b.errors);
  });
} finally {
  server?.stop();
}

const failed = report.checks.filter((c) => !c.ok).length;
report.summary = { passed: report.checks.length - failed, failed };
await fs.writeFile(path.join(OUT, 'firefox-report.json'), JSON.stringify(report, null, 2));
console.log(`\nFirefox ${report.firefox}: ${report.summary.passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
