// Browser QA for the digital edition (Chromium/Edge via Playwright).
//
//   npm run build && npm run qa                 (serves dist/ with `vite preview` on port 4181)
//   node qa/run-qa.mjs --url http://127.0.0.1:4180/tap-out-barracks-campaign/
//
// Playwright is not a project dependency: set PLAYWRIGHT_MODULE to an installed
// playwright(-core) index.mjs, or `npm i -D playwright-core`. The browser is the
// installed Microsoft Edge (BROWSER_CHANNEL=chrome or BROWSER_EXE to change).
// Writes qa-out/report.json, qa-out/network-initial.json and qa-out/shots/*.png.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa-out');
const SHOTS = path.join(OUT, 'shots');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const site = JSON.parse(await fs.readFile(path.join(ROOT, 'site.config.json'), 'utf8'));
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'dist', 'magazine', 'manifest.json'), 'utf8'));
const COUNT = manifest.pages.length;
const BASE_PATH = new URL(site.siteUrl).pathname;

const pwPath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = pwPath ? await import(pathToFileURL(pwPath).href) : await import('playwright-core');

// ------------------------------------------------------------------ server
let server = null;
let URL_ = arg('--url', process.env.QA_URL || '');
if (!URL_) {
  const port = 4181;
  URL_ = `http://127.0.0.1:${port}${BASE_PATH}`;
  server = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(URL_)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
}
const stopServer = () => {
  if (!server || server.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' });
    else server.kill('SIGTERM');
  } catch {
    /* already gone */
  }
};
process.on('exit', stopServer);

// ----------------------------------------------------------------- helpers
const report = { at: new Date().toISOString(), url: URL_, count: COUNT, checks: [], metrics: {} };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
};
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

const browser = await chromium.launch({
  headless: process.env.HEADED ? false : true,
  ...(process.env.BROWSER_EXE ? { executablePath: process.env.BROWSER_EXE } : { channel: process.env.BROWSER_CHANNEL || 'msedge' }),
});
report.browser = `${browser.browserType().name()} ${browser.version()}`;
console.log('Browser', report.browser, '·', URL_);

const errorsFor = (page) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return errors;
};
const ready = (page) =>
  page.waitForFunction(() => window.__tob && !document.getElementById('app').classList.contains('is-loading'), null, { timeout: 20000 });
const settle = async (page, extra = 150) => {
  await page.waitForFunction(() => window.__tob && !window.__tob.busy, null, { timeout: 10000 });
  await sleep(extra);
};
const state = (page) =>
  page.evaluate(() => ({
    page: __tob.page,
    spread: __tob.spread,
    mode: __tob.mode,
    renderer: __tob.renderer,
    hash: location.hash,
    folio: document.getElementById('folio').textContent.replace(/\s+/g, ' ').trim(),
    counts: __tob.loader.counts(),
  }));
const wakeChrome = async (page) => {
  await page.mouse.move(300, 300);
  await page.mouse.move(320, 310);
  await sleep(120);
};
const decodeVisible = (page) =>
  page.evaluate(async () => {
    const imgs = [...document.querySelectorAll('.page')].filter((p) => getComputedStyle(p).display !== 'none').map((p) => p.querySelector('.page__img'));
    await Promise.all(imgs.map((i) => (i.src ? i.decode().catch(() => {}) : null)));
  });

const pageFile = (u) => {
  const m = /\/pages\/p(\d{3})-/.exec(u);
  return m ? Number(m[1]) - 1 : null;
};

// ============================================== A. desktop first visit
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(URL_).origin });
  const page = await ctx.newPage();
  const errors = errorsFor(page);
  const net = [];
  page.on('requestfinished', async (req) => {
    try {
      const sizes = await req.sizes();
      const res = await req.response();
      net.push({ url: req.url(), type: req.resourceType(), status: res?.status(), bytes: sizes.responseBodySize, t: Date.now() });
    } catch {
      /* ignore */
    }
  });
  page.on('requestfailed', (req) => net.push({ url: req.url(), failed: req.failure()?.errorText, t: Date.now() }));

  // A 10 Mbit/s, 70 ms connection makes the load order observable.
  const net0 = await ctx.newCDPSession(page);
  await net0.send('Network.enable');
  await net0.send('Network.emulateNetworkConditions', { offline: false, latency: 70, downloadThroughput: 1.25e6, uploadThroughput: 0.6e6 });
  const t0 = Date.now();
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await ready(page);
  const tReady = Date.now() - t0;
  const atReady = net.slice();
  await sleep(5000);
  const atIdle = net.slice();
  const loadLog = await page.evaluate(() => __tob.loader.log());
  await net0.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const sum = (list) => list.reduce((a, r) => a + (r.bytes || 0), 0);
  const pagesAt = (list) => [...new Set(list.map((r) => pageFile(r.url)).filter((x) => x !== null))].sort((a, b) => a - b);
  report.metrics.initialLoad = {
    viewport: '1440x900 @1x',
    network: 'emulated 10 Mbit/s down, 70 ms latency, empty cache',
    msToCoverShown: tReady,
    bytesAtCoverShown: sum(atReady),
    requestsAtCoverShown: atReady.length,
    pageImagesAtCoverShown: pagesAt(atReady),
    bytesAfter5sIdle: sum(atIdle),
    pageImagesAfter5sIdle: pagesAt(atIdle),
    thumbsAfter5sIdle: atIdle.filter((r) => /\/thumbs\//.test(r.url)).length,
    byType: Object.fromEntries(
      ['document', 'script', 'stylesheet', 'fetch', 'image', 'other'].map((t) => [t, sum(atIdle.filter((r) => r.type === t))]),
    ),
    note: 'Local preview server sends JS/CSS/JSON uncompressed; GitHub Pages gzips them (WebP is sent as is).',
  };
  await fs.writeFile(path.join(OUT, 'network-initial.json'), JSON.stringify(atIdle, null, 1));
  const cover = loadLog.find((r) => r.index === 0);
  const others = loadLog.filter((r) => r.index !== 0);
  check(
    'first visit: the cover loads before any other page is requested',
    cover && cover.ok && others.every((r) => r.t0 >= cover.t1 - 1),
    { coverMs: cover && Math.round(cover.t1 - cover.t0), firstPrefetchAt: others.length ? Math.round(Math.min(...others.map((r) => r.t0))) : null, coverDoneAt: cover && Math.round(cover.t1) },
  );
  check('first visit: cover shown with only the cover page image', pagesAt(atReady).length <= 2, pagesAt(atReady));
  check('first visit: idle prefetch is limited to nearby spreads', pagesAt(atIdle).every((i) => i <= 4) && pagesAt(atIdle).length <= 5, pagesAt(atIdle));
  check('first visit: no thumbnails until the overview opens', report.metrics.initialLoad.thumbsAfter5sIdle === 0);
  const outside = atIdle.filter((r) => !new URL(r.url).pathname.startsWith(BASE_PATH) && !r.url.startsWith('data:'));
  check('all requests stay under the Pages base path', outside.length === 0, outside.map((r) => r.url).slice(0, 5));
  const bad = atIdle.filter((r) => r.failed || (r.status && r.status >= 400));
  check('no failed requests', bad.length === 0, bad.slice(0, 5));

  let s = await state(page);
  check('cover alone on open (landscape)', s.mode === 'landscape' && JSON.stringify(s.spread) === '[0]' && s.renderer === 'flip', s);
  await decodeVisible(page);
  await shot(page, 'desktop-01-cover');

  // corner hint fires on first visit (no interaction yet)
  await sleep(300);

  // B. navigation ---------------------------------------------------
  await page.keyboard.press('ArrowRight');
  await settle(page);
  s = await state(page);
  check('ArrowRight opens spread 2–3', JSON.stringify(s.spread) === '[1,2]' && s.hash === '#page=2' && s.folio.startsWith('2–3'), s);
  await decodeVisible(page);
  await shot(page, 'desktop-02-spread-2-3');

  await page.keyboard.press('ArrowRight');
  await sleep(330);
  const mid = await page.evaluate(() =>
    [...document.querySelectorAll('.page')]
      .filter((p) => getComputedStyle(p).display !== 'none')
      .map((p) => ({ i: Number(p.dataset.index), ready: p.classList.contains('is-ready') })),
  );
  await shot(page, 'desktop-03-mid-turn');
  check('mid-turn: every page on screen is already loaded (no placeholder frames)', mid.length >= 2 && mid.every((m) => m.ready), mid);
  await settle(page);

  const before = (await state(page)).spread;
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('ArrowRight');
    await sleep(60);
  }
  await settle(page, 400);
  s = await state(page);
  const spreads = [[0]];
  for (let i = 1; i < COUNT; i += 2) spreads.push(i < COUNT - 1 ? [i, i + 1] : [i]);
  const idx = spreads.findIndex((sp) => sp[0] === before[0]);
  check('rapid key presses land on the right spread', JSON.stringify(s.spread) === JSON.stringify(spreads[Math.min(spreads.length - 1, idx + 8)]), { before, after: s.spread });
  const fromSpread = s.spread;

  // overview
  await page.keyboard.press('t');
  await page.waitForSelector('#overview.is-open');
  await sleep(700);
  const thumbsReq = net.filter((r) => /\/thumbs\//.test(r.url)).length;
  check('overview fetches thumbnails once opened', thumbsReq > 0, { thumbsRequested: thumbsReq, of: COUNT });
  report.metrics.overviewThumbBytes = net.filter((r) => /\/thumbs\//.test(r.url)).reduce((a, r) => a + (r.bytes || 0), 0);
  await shot(page, 'desktop-04-overview');
  await page.click('button.sheet[aria-label="Pages 30 and 31"]');
  await sleep(60);
  await settle(page, 300);
  s = await state(page);
  check('overview jump to 30–31', JSON.stringify(s.spread) === '[29,30]' && s.hash === '#page=30', s);

  await page.goBack();
  await sleep(200);
  await settle(page, 300);
  s = await state(page);
  check('browser Back returns to the previous spread', JSON.stringify(s.spread) === JSON.stringify(fromSpread), { expected: fromSpread, got: s.spread, hash: s.hash });
  await page.goForward();
  await sleep(200);
  await settle(page, 300);
  s = await state(page);
  check('browser Forward returns to 30–31', JSON.stringify(s.spread) === '[29,30]', s);

  // End / Home
  await page.keyboard.press('End');
  await settle(page, 900);
  s = await state(page);
  check('End shows the back cover alone', JSON.stringify(s.spread) === JSON.stringify([COUNT - 1]) && COUNT % 2 === 0, s);
  await decodeVisible(page);
  await shot(page, 'desktop-05-back-cover');
  await page.keyboard.press('Home');
  await settle(page, 900);
  s = await state(page);
  check('Home returns to the cover', JSON.stringify(s.spread) === '[0]', s);

  // scrubber via keyboard
  await wakeChrome(page);
  await page.focus('#scrub-range');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await sleep(150);
  await shot(page, 'desktop-06-scrub-preview');
  await page.keyboard.press('Tab');
  await settle(page, 900);
  s = await state(page);
  check('scrubber moves by spreads', JSON.stringify(s.spread) === JSON.stringify(spreads[5]), s);

  // controls visible + focus ring
  await wakeChrome(page);
  await page.focus('[data-action="overview"]');
  await sleep(200);
  await shot(page, 'desktop-07-controls-focus');
  const chromeShown = await page.evaluate(() => !document.getElementById('app').classList.contains('chrome-hidden'));
  check('controls show while focused', chromeShown);
  await page.mouse.move(720, 450);
  await page.evaluate(() => document.activeElement?.blur());
  await sleep(site.reader.controlsAutoHideMs + 1400);
  const hiddenNow = await page.evaluate(() => document.getElementById('app').classList.contains('chrome-hidden'));
  check('controls fade out while reading', hiddenNow);

  // share
  await wakeChrome(page);
  await page.click('[data-action="share"]');
  await sleep(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => `ERR ${e}`));
  s = await state(page);
  check('share copies a link to the current page', clip === (await page.evaluate(() => location.href)) && /#page=\d+$/.test(clip), clip);
  await shot(page, 'desktop-08-link-copied');

  // download
  const dl = await page.getAttribute('#download', 'href');
  const dlRes = dl ? await fetch(new URL(dl, URL_), { method: 'HEAD' }) : null;
  check(
    'download link serves the bundled PDF',
    !manifest.download || (dlRes?.ok && Number(dlRes.headers.get('content-length')) === manifest.download.bytes),
    { href: dl, status: dlRes?.status, length: dlRes?.headers.get('content-length') },
  );

  // view toggle
  await wakeChrome(page);
  await page.click('#view-toggle');
  await settle(page, 600);
  s = await state(page);
  check('view toggle switches to single pages', s.mode === 'portrait', s);
  await decodeVisible(page);
  await shot(page, 'desktop-09-single-page-view');
  await wakeChrome(page);
  await page.click('#view-toggle');
  await settle(page, 600);
  check('view toggle returns to spreads', (await state(page)).mode === 'landscape');

  // zoom
  await page.keyboard.press('z');
  await page.waitForSelector('#zoom.is-open');
  await sleep(400);
  await page.mouse.move(900, 400);
  await page.mouse.wheel(0, -700);
  await sleep(300);
  const level = await page.textContent('#zoom-level');
  check('detail view zooms in', parseInt(level, 10) > 150, level);
  await page.evaluate(async () => Promise.all([...document.querySelectorAll('.zoom__img')].map((i) => i.decode().catch(() => {}))));
  await shot(page, 'desktop-10-zoom');
  await page.keyboard.press('Escape');
  await sleep(350);
  check('Escape closes the detail view', await page.evaluate(() => document.getElementById('zoom').hidden));

  // fullscreen (headless may refuse)
  await wakeChrome(page);
  await page.click('#fullscreen');
  await sleep(500);
  const fs1 = await page.evaluate(() => Boolean(document.fullscreenElement));
  check('fullscreen toggle enters full screen', fs1, { note: 'headless Chromium may refuse fullscreen' });
  if (fs1) {
    await page.keyboard.press('f');
    await sleep(400);
  }

  // resize to a tall window, then back
  await page.setViewportSize({ width: 900, height: 1150 });
  await sleep(500);
  s = await state(page);
  check('tall window switches to single pages', s.mode === 'portrait', s);
  await decodeVisible(page);
  await shot(page, 'desktop-11-tall-window');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await sleep(500);
  s = await state(page);
  const geo = await page.evaluate(() => {
    const r = document.getElementById('shift').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth };
  });
  check('1920×1080 uses the height for a spread', s.mode === 'landscape' && geo.h >= 900 && geo.scrollW <= geo.vw, geo);
  await decodeVisible(page);
  await shot(page, 'desktop-12-1080p');

  // deep links: an edited hash in the open page, then fresh loads
  await page.evaluate(() => (location.hash = '#page=24'));
  await sleep(80);
  await settle(page, 300);
  s = await state(page);
  check('editing the hash to #page=24 turns to 24–25', JSON.stringify(s.spread) === '[23,24]' && s.folio.startsWith('24–25'), s);
  const fresh = await ctx.newPage();
  await fresh.goto(`${URL_}#page=24`);
  await ready(fresh);
  await settle(fresh);
  const f = await state(fresh);
  check('opening a #page=24 link shows 24–25 straight away', JSON.stringify(f.spread) === '[23,24]', f);
  await fresh.close();
  await page.reload();
  await ready(page);
  await settle(page);
  check('reload keeps the page', JSON.stringify((await state(page)).spread) === '[23,24]');
  await page.goto(`${URL_}#page=999`);
  await page.reload();
  await ready(page);
  await settle(page);
  s = await state(page);
  check('out-of-range link clamps to the last page', JSON.stringify(s.spread) === JSON.stringify([COUNT - 1]) && s.hash === `#page=${COUNT}`, s);
  await page.goto(`${URL_}#page=abc`);
  await page.reload();
  await ready(page);
  s = await state(page);
  check('invalid link opens the cover', JSON.stringify(s.spread) === '[0]', s);

  check('desktop: no script errors', errors.length === 0, errors);
  await ctx.close();
}

// ===================================== C. missing and delayed images
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = errorsFor(page);
  const missing = manifest.pages[9].src.split('/').pop();
  const delayed = new Set(manifest.pages.slice(38, 42).map((p) => p.src.split('/').pop()));
  await page.route('**/pages/*.webp', async (route) => {
    const name = route.request().url().split('/').pop();
    if (name === missing) return route.abort('failed');
    if (delayed.has(name)) await sleep(2400);
    return route.continue();
  });
  await page.goto(`${URL_}#page=10`);
  await ready(page);
  await sleep(3500);
  const miss = await page.evaluate(() => {
    const p = document.querySelector('.page[data-index="9"]');
    return { error: p.classList.contains('is-error'), retryShown: !p.querySelector('.page__retry').hidden, lqip: Boolean(p.querySelector('.page__lqip')?.complete) };
  });
  check('missing page keeps its placeholder and offers a retry', miss.error && miss.retryShown && miss.lqip, miss);
  await shot(page, 'failure-01-missing-page');

  await page.evaluate(() => window.__tob.go(39));
  await sleep(60);
  await settle(page, 50);
  const early = await page.evaluate(() =>
    [...document.querySelectorAll('.page')]
      .filter((p) => getComputedStyle(p).display !== 'none')
      .map((p) => ({ i: Number(p.dataset.index), ready: p.classList.contains('is-ready'), lqip: Boolean(p.querySelector('.page__lqip')?.complete) })),
  );
  await shot(page, 'failure-02-delayed-page-placeholder');
  await sleep(2600);
  const late = await page.evaluate(() => ({ spread: __tob.spread, ready: __tob.spread.map((i) => document.querySelector(`.page[data-index="${i}"]`).classList.contains('is-ready')) }));
  check(
    'slow pages: placeholders while waiting, full pages once they arrive',
    early.some((e) => (e.i === 39 || e.i === 40) && !e.ready && e.lqip) && late.ready.every(Boolean) && JSON.stringify(late.spread) === '[39,40]',
    { early, late },
  );
  await decodeVisible(page);
  await shot(page, 'failure-03-delayed-page-loaded');
  check('failure cases: no script errors', errors.length === 0, errors);
  await ctx.close();
}

// ========================================= D. reduced motion (simple reader)
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = errorsFor(page);
  await page.goto(URL_);
  await ready(page);
  let s = await state(page);
  check('reduced motion uses the non-animated reader', s.renderer === 'simple', s);
  await page.keyboard.press('ArrowRight');
  await sleep(60);
  s = await state(page);
  check('reduced motion: page changes immediately', JSON.stringify(s.spread) === '[1,2]', s);
  await decodeVisible(page);
  await shot(page, 'reduced-motion-01-spread');
  check('reduced motion: no script errors', errors.length === 0, errors);
  await ctx.close();
}

// ============================================================ E. mobile
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  });
  const page = await ctx.newPage();
  const errors = errorsFor(page);
  const net = [];
  page.on('requestfinished', async (req) => {
    try {
      net.push({ url: req.url(), bytes: (await req.sizes()).responseBodySize });
    } catch {
      /* ignore */
    }
  });
  await page.goto(URL_);
  await ready(page);
  await sleep(5000);
  report.metrics.mobileInitial = {
    viewport: '390x844 @3x',
    bytesAfter5s: net.reduce((a, r) => a + r.bytes, 0),
    pageImages: [...new Set(net.map((r) => pageFile(r.url)).filter((x) => x !== null))].sort((a, b) => a - b),
  };
  let s = await state(page);
  const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: innerWidth, sh: document.documentElement.scrollHeight, vh: innerHeight }));
  check('mobile: single page portrait', s.mode === 'portrait' && JSON.stringify(s.spread) === '[0]', s);
  check('mobile: no horizontal scrolling', overflow.sw <= overflow.vw && overflow.sh <= overflow.vh, overflow);
  await decodeVisible(page);
  await shot(page, 'mobile-01-cover');

  const cdp = await ctx.newCDPSession(page);
  const swipe = async (x0, x1, y = 420) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
    for (let k = 1; k <= 4; k++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * k) / 4, y }] });
      await sleep(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await swipe(320, 90);
  await settle(page, 300);
  s = await state(page);
  check('mobile: swipe left turns the page', JSON.stringify(s.spread) === '[1]', s);
  await swipe(320, 90);
  await sleep(250);
  await decodeVisible(page);
  await shot(page, 'mobile-02-mid-turn');
  await settle(page, 300);
  await swipe(80, 320);
  await settle(page, 300);
  s = await state(page);
  check('mobile: swipe right turns back', JSON.stringify(s.spread) === '[1]', s);

  const hiddenBefore = await page.evaluate(() => document.getElementById('app').classList.contains('chrome-hidden'));
  await page.touchscreen.tap(195, 420);
  await sleep(300);
  const hiddenAfter = await page.evaluate(() => document.getElementById('app').classList.contains('chrome-hidden'));
  check('mobile: tapping the page toggles the controls', hiddenBefore !== hiddenAfter, { hiddenBefore, hiddenAfter });
  if (hiddenAfter) {
    await page.touchscreen.tap(195, 420);
    await sleep(300);
  }
  await decodeVisible(page);
  await shot(page, 'mobile-03-controls');
  await page.touchscreen.tap(378, 420);
  await settle(page, 300);
  s = await state(page);
  check('mobile: tapping the right edge turns forward', JSON.stringify(s.spread) === '[2]', s);

  await page.setViewportSize({ width: 844, height: 390 });
  await sleep(600);
  s = await state(page);
  const o2 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: innerWidth }));
  check('mobile: rotating to landscape shows the spread', s.mode === 'landscape' && JSON.stringify(s.spread) === '[1,2]' && o2.sw <= o2.vw, { s, o2 });
  await decodeVisible(page);
  await shot(page, 'mobile-04-landscape');
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(600);
  s = await state(page);
  check('mobile: rotating back keeps the reading position', s.mode === 'portrait' && [1, 2].includes(s.spread[0]), s);

  const thumbsBefore = net.filter((r) => /\/thumbs\//.test(r.url)).length;
  await page.evaluate(() => document.querySelector('[data-action="overview"]').click());
  await page.waitForSelector('#overview.is-open');
  await sleep(900);
  const mobileThumbs = net.filter((r) => /\/thumbs\//.test(r.url));
  report.metrics.mobileOverview = { thumbsBeforeOpen: thumbsBefore, thumbsAfterOpen: mobileThumbs.length, bytes: mobileThumbs.reduce((a, r) => a + r.bytes, 0) };
  check('mobile: overview fetches only the rows near the view', thumbsBefore === 0 && mobileThumbs.length > 0 && mobileThumbs.length < COUNT, report.metrics.mobileOverview);
  await shot(page, 'mobile-05-overview');
  await page.keyboard.press('Escape');
  check('mobile: no script errors', errors.length === 0, errors);
  await ctx.close();
}

// ================================================ F. idle CPU at rest
{
  const measure = async (query) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${URL_}${query}#page=12`);
    await ready(page);
    await settle(page, 1500);
    await page.mouse.move(5, 5);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    const get = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const a = await get();
    await sleep(5000);
    const b = await get();
    await ctx.close();
    return {
      windowMs: 5000,
      taskMs: Math.round((b.TaskDuration - a.TaskDuration) * 1000),
      scriptMs: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000),
      styleRecalcMs: Math.round((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000),
      styleRecalcs: b.RecalcStyleCount - a.RecalcStyleCount,
      layouts: b.LayoutCount - a.LayoutCount,
    };
  };
  report.metrics.idleAtRest = { patched: await measure(''), libraryDefault: await measure('?idle=raw') };
  const { patched, libraryDefault } = report.metrics.idleAtRest;
  check('idle redraw patch cuts main-thread work at rest', patched.taskMs < libraryDefault.taskMs, report.metrics.idleAtRest);
}

await browser.close();
stopServer();
const failed = report.checks.filter((c) => !c.ok);
report.summary = { passed: report.checks.length - failed.length, failed: failed.length };
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.summary.passed} passed, ${report.summary.failed} failed · qa-out/report.json`);
console.log(JSON.stringify(report.metrics, null, 2));
process.exit(failed.length ? 1 : 0);
