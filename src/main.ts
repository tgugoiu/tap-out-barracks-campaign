import './styles.css';
import { site } from './config';
import { buildSpreads, fitBook, spreadIndexOf, spreadLabel, type Fit } from './layout';
import { PageLoader } from './loader';
import { loadPublication, type Publication } from './manifest';
import { createPageView, type PageView } from './pages';
import { FlipRenderer } from './renderers/flip';
import { SimpleRenderer } from './renderers/simple';
import type { Renderer, RendererHost } from './renderers/types';
import { pageUrl, readHashPage, writeHash } from './router';
import type { Mode, ViewPreference } from './types';
import { Chrome } from './ui/chrome';
import { Overview } from './ui/overview';
import { fullscreen, shareLink } from './ui/platform';
import { Toast } from './ui/toast';
import { Zoom } from './ui/zoom';
import { $, el, media, nextFrame, store } from './util';

const KEY_VIEW = 'tob:view';
const KEY_LAST = 'tob:last';
const KEY_HINTED = 'tob:hinted';

type HistoryMode = 'push' | 'replace' | 'none';

class Reader implements RendererHost {
  private readonly app: HTMLElement;
  private readonly book: HTMLElement;
  private readonly count: number;
  private readonly views: PageView[];
  private readonly loader: PageLoader;
  private readonly chrome: Chrome;
  private readonly overview: Overview;
  private readonly zoom: Zoom;
  private readonly toast: Toast;
  private renderer!: Renderer;
  private fit!: Fit;
  private pref: ViewPreference;
  private spreads: number[][] = [];
  private spread = 0;
  private started = false;
  private interacted = false;
  private saveTimer = 0;
  private resizeRaf = 0;
  private resizeEnd = 0;
  private jumpToken = 0;
  private jumping = false;

  constructor(private readonly pub: Publication) {
    this.app = $('#app');
    this.book = $('#book');
    this.count = pub.pages.length;
    const stored = store.get(KEY_VIEW);
    this.pref = stored === 'single' || stored === 'double' ? stored : site.reader.defaultView;

    this.views = pub.pages.map((p, i) =>
      createPageView(p, this.count, pub.ratio, i === 0 || (i === this.count - 1 && this.count % 2 === 0) ? 'hard' : 'soft'),
    );

    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    this.loader = new PageLoader(this.views, pub.pages, {
      concurrency: Math.max(1, site.reader.concurrentRequests),
      maxLoaded: Math.max(8, media.coarse() ? Math.min(16, site.reader.maxLoadedPages) : site.reader.maxLoadedPages),
    });
    if (saveData) {
      site.reader.preloadSpreadsAhead = Math.min(1, site.reader.preloadSpreadsAhead);
      site.reader.preloadSpreadsBehind = Math.min(1, site.reader.preloadSpreadsBehind);
    }

    this.toast = new Toast($('#toast'));
    this.chrome = new Chrome(
      this.app,
      {
        prev: () => this.step(-1),
        next: () => this.step(1),
        overview: () => this.openOverview(),
        view: () => this.toggleView(),
        zoom: () => this.openZoom(),
        share: () => void this.share(),
        fullscreen: () => void fullscreen.toggle(),
        scrub: (s) => this.go(this.spreads[s]?.[0] ?? 0, { history: 'push' }),
      },
      Math.max(1200, site.reader.controlsAutoHideMs),
      (s) => {
        const spread = this.spreads[s] ?? [0];
        return { pages: spread.map((i) => pub.pages[i]), label: this.folioText(spread) };
      },
    );
    this.overview = new Overview(
      $('#overview'),
      $('#overview-grid'),
      pub.pages,
      pub.ratio,
      (page) => this.go(page, { history: 'push' }),
      (open) => this.overlayToggled(open),
    );
    this.zoom = new Zoom($('#zoom'), $('#zoom-viewport'), $('#zoom-canvas'), $('#zoom-level'), (open) =>
      this.overlayToggled(open),
    );
  }

  // --------------------------------------------------------------- start

  async start(): Promise<void> {
    const hashPage = readHashPage(this.count);
    const start = hashPage ?? 0;
    this.applyConfigStyles();
    this.fit = this.computeFit();
    this.sizeStage();

    this.renderer = this.createRenderer();
    try {
      this.renderer.mount(this.book, this.views, start, this.fit.mode);
    } catch (err) {
      console.warn('Page-turn renderer failed; using the simple reader.', err);
      this.book.replaceChildren();
      this.renderer = new SimpleRenderer(this, this.count);
      this.renderer.mount(this.book, this.views, start, this.fit.mode);
    }
    this.app.dataset.renderer = this.renderer.kind;
    this.started = true;
    this.onChange(this.renderer.current());
    if (hashPage !== null) writeHash(hashPage, 'replace'); // normalises #24, #p24, out-of-range values

    this.bindEvents();
    this.chrome.setFullscreen(fullscreen.supported(), fullscreen.active());
    this.setupDownload();

    await this.loader.whenSettled(this.spreads[this.spread], 4500);
    await nextFrame();
    this.app.classList.remove('is-loading');
    this.app.classList.add('is-revealed');
    window.setTimeout(() => this.app.classList.remove('is-revealed'), 1600);
    this.chrome.wake(3800);
    if (hashPage === null) this.offerResume();
    this.maybeHint();
  }

  private createRenderer(): Renderer {
    const param = new URLSearchParams(window.location.search).get('reader');
    const simple = param === 'simple' || (param !== 'flip' && media.reducedMotion());
    if (simple) return new SimpleRenderer(this, this.count);
    return new FlipRenderer(this, {
      flipTimeMs: site.reader.flipTimeMs,
      coverDensity: site.reader.coverDensity,
      refWidth: this.pub.refWidth,
      refHeight: this.pub.refHeight,
      count: this.count,
    });
  }

  // -------------------------------------------------------- RendererHost

  onChange(page: number): void {
    this.spreads = buildSpreads(this.count, this.fit.mode);
    this.spread = spreadIndexOf(this.spreads, page);
    const visible = this.spreads[this.spread];
    this.loader.focus(visible, this.prefetchFor(this.spread));
    this.applyStage(this.spread);
    this.chrome.setPosition(
      this.spread,
      this.spreads.length,
      this.folioText(visible),
      this.count,
      this.ariaText(visible),
    );
    if (this.started) {
      const hp = readHashPage(this.count);
      if (hp === null ? this.spread !== 0 : !visible.includes(hp)) writeHash(visible[0], 'replace');
      window.clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => this.savePosition(visible[0]), 400);
    }
  }

  onTurnStart(page: number | null): void {
    if (page === null) return;
    const s = spreadIndexOf(this.spreads, page);
    this.applyStage(s);
    this.loader.focus(this.spreads[s], this.prefetchFor(s));
  }

  onTap(x: number): void {
    this.interacted = true;
    const w = window.innerWidth;
    if (x < w * 0.18) this.step(-1);
    else if (x > w * 0.82) this.step(1);
    else this.chrome.toggle();
  }

  onPinch(): void {
    this.interacted = true;
    this.openZoom();
  }

  // ---------------------------------------------------------- navigation

  step(delta: number): void {
    this.interacted = true;
    // A press during a turn lands that turn first, so every press moves one spread.
    this.renderer.settle();
    const s = Math.min(this.spreads.length - 1, Math.max(0, this.spread + delta));
    if (s === this.spread && !this.renderer.isBusy()) return;
    this.go(this.spreads[s][0], { history: 'replace' });
  }

  go(page: number, opts: { animate?: boolean; history?: HistoryMode } = {}): void {
    const target = Math.min(this.count - 1, Math.max(0, page));
    const animate = opts.animate ?? this.renderer.kind === 'flip';
    const s = spreadIndexOf(this.spreads, target);
    if (opts.history === 'push' && s !== this.spread) writeHash(this.spreads[s][0], 'push');
    const far = Math.abs(s - this.spread) > 1;
    const visible = this.spreads[s];
    const token = ++this.jumpToken;
    if (animate && far && !visible.every((i) => this.loader.isReady(i))) {
      // Fetch the destination first (briefly), so the long turn lands on finished pages.
      this.jumping = true;
      this.loader.focus(visible, []);
      void this.loader.whenSettled(visible, 700).then(() => {
        if (token !== this.jumpToken) return; // a newer navigation superseded this one
        this.jumping = false;
        this.renderer.go(target, true);
      });
      return;
    }
    this.jumping = false;
    this.renderer.go(target, animate);
  }

  private fromHash(): void {
    const p = readHashPage(this.count) ?? 0;
    if (!this.spreads[this.spread].includes(p)) this.go(p, { history: 'none' });
  }

  // ------------------------------------------------------------- layout

  private computeFit(): Fit {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const coarse = media.coarse();
    const short = vh < 560;
    const padX = coarse || vw < 720 ? 8 : Math.max(60, Math.round(vw * 0.045));
    const padT = short ? 8 : coarse ? 14 : Math.max(22, Math.round(vh * 0.035));
    const padB = short ? 8 : coarse ? 72 : Math.max(74, Math.round(vh * 0.082));
    this.app.style.setProperty('--pad-x', `${padX}px`);
    this.app.style.setProperty('--pad-t', `${padT}px`);
    this.app.style.setProperty('--pad-b', `${padB}px`);
    return fitBook(vw - padX * 2, vh - padT - padB, this.pub.ratio, this.pref);
  }

  private sizeStage(): void {
    const { mode, pageW, pageH } = this.fit;
    const bookW = mode === 'landscape' ? pageW * 2 : pageW;
    const s = this.app.style;
    s.setProperty('--book-w', `${bookW}px`);
    s.setProperty('--book-h', `${pageH}px`);
    s.setProperty('--page-w', `${pageW}px`);
    this.app.dataset.mode = mode;
    this.chrome.setView(mode, this.fit.canSpread);
  }

  private relayout(): void {
    const next = this.computeFit();
    const prev = this.fit;
    if (next.mode === prev.mode && next.pageW === prev.pageW && next.pageH === prev.pageH) {
      this.chrome.setView(next.mode, next.canSpread);
      return;
    }
    this.app.classList.add('is-resizing');
    window.clearTimeout(this.resizeEnd);
    this.resizeEnd = window.setTimeout(() => this.app.classList.remove('is-resizing'), 200);
    this.fit = next;
    this.sizeStage();
    this.renderer.layout(next.mode);
    this.onChange(this.renderer.current());
  }

  private toggleView(): void {
    const wanted: Mode = this.fit.mode === 'landscape' ? 'portrait' : 'landscape';
    const auto = this.computeFitFor('auto').mode;
    this.pref = wanted === auto ? 'auto' : wanted === 'portrait' ? 'single' : 'double';
    store.set(KEY_VIEW, this.pref);
    this.relayout();
  }

  private computeFitFor(pref: ViewPreference): Fit {
    const keep = this.pref;
    this.pref = pref;
    const f = this.computeFit();
    this.pref = keep;
    return f;
  }

  /** Centres a lone cover, sizes the shadow and the page-edge stacks. */
  private applyStage(s: number): void {
    const spread = this.spreads[s] ?? [0];
    const { mode, pageW, pageH } = this.fit;
    let visLeft = 0;
    let visW = pageW;
    let shift = 0;
    if (mode === 'landscape') {
      if (spread.length === 2) visW = pageW * 2;
      else if (spread[0] === 0) {
        visLeft = pageW;
        shift = -pageW / 2;
      } else {
        shift = pageW / 2;
      }
    }
    const before = spread[0];
    const after = this.count - 1 - spread[spread.length - 1];
    const maxStack = site.reader.pageStack ? Math.min(9, Math.max(2, Math.round(pageH * 0.0062 * Math.min(2, this.count / 56)))) : 0;
    const stackL = mode === 'landscape' ? (before / this.count) * maxStack : 0;
    const stackR = (after / this.count) * maxStack;
    const st = this.app.style;
    st.setProperty('--shift', `${shift}px`);
    st.setProperty('--vis-left', `${visLeft}px`);
    st.setProperty('--vis-w', `${visW}px`);
    st.setProperty('--stack-l', `${stackL.toFixed(2)}px`);
    st.setProperty('--stack-r', `${stackR.toFixed(2)}px`);
  }

  private prefetchFor(s: number): number[] {
    const out: number[] = [];
    const ahead = Math.max(0, site.reader.preloadSpreadsAhead);
    const behind = Math.max(0, site.reader.preloadSpreadsBehind);
    for (let d = 1; d <= Math.max(ahead, behind); d++) {
      if (d <= ahead && this.spreads[s + d]) out.push(...this.spreads[s + d]);
      if (d <= behind && this.spreads[s - d]) out.push(...this.spreads[s - d]);
    }
    return out;
  }

  // ----------------------------------------------------------- overlays

  private openOverview(): void {
    this.interacted = true;
    this.overview.show(this.spreads[this.spread][0]);
  }

  private openZoom(): void {
    this.interacted = true;
    if (this.zoom.isOpen()) return;
    const pages = this.spreads[this.spread].map((i) => this.pub.pages[i]);
    this.zoom.show(pages);
  }

  private overlayToggled(open: boolean): void {
    this.renderer.lock(open || this.overview.isOpen() || this.zoom.isOpen());
    this.app.classList.toggle('has-overlay', open);
    this.chrome.hold('overlay', open);
    if (!open) this.chrome.wake();
  }

  // -------------------------------------------------------------- misc

  private async share(): Promise<void> {
    const url = pageUrl(this.spreads[this.spread][0]);
    const result = await shareLink(url, `${site.title} — ${site.subtitle}`);
    const where = this.folioText(this.spreads[this.spread]);
    if (result === 'copied') this.toast.show(`Link to page ${where} copied`);
    else if (result === 'failed') this.toast.show(url, { ms: 6000 });
  }

  private setupDownload(): void {
    const mode = site.download.mode;
    if (mode === 'none') return this.chrome.setDownload(null, 0, '', false);
    if (mode === 'external' && site.download.externalUrl) {
      return this.chrome.setDownload(site.download.externalUrl, 0, site.download.label, true);
    }
    this.chrome.setDownload(this.pub.downloadUrl, this.pub.downloadBytes, site.download.label, false);
  }

  private edition(): string {
    return (this.pub.manifest.source?.sha256 ?? String(this.count)).slice(0, 12);
  }

  private savePosition(page: number): void {
    store.set(KEY_LAST, JSON.stringify({ page, edition: this.edition(), at: Date.now() }));
  }

  private offerResume(): void {
    if (!site.reader.resumePrompt) return;
    try {
      const saved = JSON.parse(store.get(KEY_LAST) ?? 'null') as { page?: number; edition?: string } | null;
      if (!saved || saved.edition !== this.edition() || typeof saved.page !== 'number') return;
      const page = Math.min(this.count - 1, Math.max(0, saved.page));
      if (page < 1) return;
      const label = this.folioText(this.spreads[spreadIndexOf(this.spreads, page)]);
      this.toast.show(`Continue reading at page ${label}?`, {
        ms: 9000,
        action: { label: 'Continue', run: () => this.go(page, { history: 'push' }) },
      });
    } catch {
      /* ignore malformed saved state */
    }
  }

  private maybeHint(): void {
    if (!site.reader.cornerHint || this.renderer.kind !== 'flip' || media.reducedMotion()) return;
    if (store.get(KEY_HINTED) || this.spread !== 0) return;
    window.setTimeout(() => {
      if (this.interacted || this.spread !== 0 || this.overview.isOpen() || this.zoom.isOpen()) return;
      this.renderer.hint();
      store.set(KEY_HINTED, '1');
    }, 1900);
  }

  private folioText(spread: number[]): string {
    return spreadLabel(spread);
  }

  private ariaText(spread: number[]): string {
    if (spread.length === 2) return `Pages ${spread[0] + 1} and ${spread[1] + 1} of ${this.count}`;
    return `Page ${spread[0] + 1} of ${this.count}`;
  }

  private applyConfigStyles(): void {
    const g = Math.min(0.6, Math.max(0, site.reader.gutterShadow));
    this.app.style.setProperty('--gutter', String(g));
  }

  private bindEvents(): void {
    const onResize = (): void => {
      cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = requestAnimationFrame(() => this.relayout());
    };
    // StPageFlip has its own resize listener; it re-reads the book size, which only
    // changes here, so the authoritative update is renderer.layout() in relayout().
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    fullscreen.onChange(() => {
      this.chrome.setFullscreen(fullscreen.supported(), fullscreen.active());
      onResize();
    });
    window.addEventListener('popstate', () => this.fromHash());
    window.addEventListener('hashchange', () => this.fromHash());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('pointerdown', () => (this.interacted = true), { capture: true });
    window.addEventListener('wheel', (e) => {
      if (this.overview.isOpen() || this.zoom.isOpen() || e.ctrlKey) return;
      if (Math.abs(e.deltaX) > 30 && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5) {
        // Horizontal trackpad swipe turns the page (throttled by the flip itself).
        if (!this.renderer.isBusy()) this.step(e.deltaX > 0 ? 1 : -1);
      }
    }, { passive: true });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
    if (this.overview.isOpen() || this.zoom.isOpen()) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const onButton = tag === 'BUTTON' || tag === 'A';
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
        this.step(1);
        break;
      case 'ArrowLeft':
      case 'PageUp':
        this.step(-1);
        break;
      case ' ':
        if (onButton) return;
        this.step(e.shiftKey ? -1 : 1);
        break;
      case 'Home':
        this.go(0, { history: 'push' });
        break;
      case 'End':
        this.go(this.count - 1, { history: 'push' });
        break;
      case 'f':
      case 'F':
        void fullscreen.toggle();
        break;
      case 't':
      case 'T':
      case 'g':
      case 'G':
        this.openOverview();
        break;
      case 'z':
      case 'Z':
        this.openZoom();
        break;
      case 'Tab':
        this.chrome.wake();
        return;
      default:
        return;
    }
    this.interacted = true;
    e.preventDefault();
  }

  debug(): Record<string, unknown> {
    // Read-only hooks for the QA scripts.
    return {
      get page() {
        return reader.renderer.current();
      },
      get spread() {
        return reader.spreads[reader.spread];
      },
      get mode() {
        return reader.fit.mode;
      },
      get renderer() {
        return reader.renderer.kind;
      },
      get busy() {
        return reader.renderer.isBusy() || reader.jumping;
      },
      loader: {
        counts: () => reader.loader.counts(),
        states: () => reader.loader.states(),
        log: () => reader.loader.log.map((r) => ({ ...r })),
      },
      count: this.count,
      go: (p: number) => reader.go(p, { history: 'push' }),
    };
  }
}

let reader: Reader;

function showError(err: unknown): void {
  console.error(err);
  const app = $('#app');
  app.classList.remove('is-loading');
  app.classList.add('is-failed');
  const box = el('div', 'notice', { role: 'alert' });
  const p = el('p');
  p.textContent = 'The magazine could not be opened.';
  const btn = el('button', 'notice__retry', { type: 'button' });
  btn.textContent = 'Try again';
  btn.addEventListener('click', () => window.location.reload());
  box.append(p, btn);
  app.append(box);
}

async function boot(): Promise<void> {
  let pub: Publication;
  try {
    pub = await loadPublication();
  } catch (err) {
    showError(err);
    return;
  }
  reader = new Reader(pub);
  (window as unknown as { __tob: unknown }).__tob = reader.debug();
  try {
    await reader.start();
  } catch (err) {
    showError(err);
  }
}

void boot();
