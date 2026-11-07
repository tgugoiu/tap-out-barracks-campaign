import { PageFlip } from 'page-flip/dist/js/page-flip.module.js';
import type { Point } from 'page-flip/dist/js/page-flip.module.js';
import { buildSpreads, spreadIndexOf } from '../layout';
import type { PageView } from '../pages';
import type { Mode } from '../types';
import type { Renderer, RendererHost } from './types';

/** A minWidth no viewport reaches: makes StPageFlip's stretch mode choose portrait. */
const PORTRAIT_LOCK = 1_000_000;

interface FlipOptions {
  flipTimeMs: number;
  coverDensity: 'soft' | 'hard';
  refWidth: number;
  refHeight: number;
  count: number;
}

type Internals = {
  drawFrame: () => void;
  animation: unknown;
};

/**
 * StPageFlip (HTML mode) renderer.
 *
 * Layout is owned by the reader: the book element is given the exact spread
 * size, and orientation is forced through StPageFlip's own stretch rule by
 * changing `minWidth` on its live settings object, then calling update().
 * That avoids destroy()/re-create, which in 2.0.7 leaves the old instance's
 * requestAnimationFrame loop running forever.
 *
 * StPageFlip also restyles all pages on every animation frame even when the
 * book is still; drawFrame is wrapped so it only runs while something moves.
 */
export class FlipRenderer implements Renderer {
  readonly kind = 'flip' as const;
  private pf!: PageFlip;
  private book!: HTMLElement;
  private locked = false;
  private dirty = 30;
  private mode: Mode = 'landscape';
  private pending: number | null = null;
  private touch: { x: number; y: number; t: number } | null = null;

  constructor(
    private readonly host: RendererHost,
    private readonly opts: FlipOptions,
  ) {}

  mount(book: HTMLElement, views: PageView[], startPage: number, mode: Mode): void {
    this.book = book;
    this.mode = mode;
    const pf = new PageFlip(book, {
      width: this.opts.refWidth,
      height: this.opts.refHeight,
      size: 'stretch',
      minWidth: mode === 'portrait' ? PORTRAIT_LOCK : 1,
      maxWidth: 100_000,
      minHeight: 1,
      maxHeight: 100_000,
      autoSize: false,
      showCover: true,
      usePortrait: true,
      mobileScrollSupport: false,
      drawShadow: true,
      maxShadowOpacity: 0.55,
      flippingTime: Math.max(1, this.opts.flipTimeMs),
      startPage,
      startZIndex: 2,
      swipeDistance: 24,
      showPageCorners: true,
      clickEventForward: true,
      useMouseEvents: true,
      disableFlipByClick: false,
    });
    pf.loadFromHTML(views.map((v) => v.root));
    // loadFromHTML's UI pins min sizes from minWidth; the reader sizes the book itself.
    book.style.minWidth = '0';
    book.style.minHeight = '0';
    this.pf = pf;
    pf.update();

    if (this.opts.coverDensity === 'soft') {
      pf.getPage(0).setDensity('soft');
      if (this.opts.count > 1) pf.getPage(this.opts.count - 1).setDensity('soft');
    }

    // ?idle=raw keeps the library's every-frame redraw, for comparison measurements.
    if (new URLSearchParams(window.location.search).get('idle') !== 'raw') this.patchRenderLoop();
    this.patchInput();

    pf.on('flip', (e) => {
      this.markDirty();
      this.host.onChange(e.data);
    });
    pf.on('changeState', (e) => {
      this.markDirty();
      if (e.data === 'flipping') this.host.onTurnStart(this.turnTarget());
      if (e.data === 'read' && this.pending !== null) {
        const page = this.pending;
        this.pending = null;
        requestAnimationFrame(() => this.go(page, true));
      }
    });
    pf.on('changeOrientation', () => this.markDirty(20));

    this.bindTouch();
  }

  layout(mode: Mode): void {
    this.mode = mode;
    this.pf.getSettings().minWidth = mode === 'portrait' ? PORTRAIT_LOCK : 1;
    this.pf.update();
    this.markDirty(20);
  }

  go(page: number, animate: boolean): void {
    const pf = this.pf;
    if (pf.getState() === 'user_fold') {
      this.pending = page; // the reader is dragging a page; turn once it lands
      return;
    }
    // Land any turn in progress first. flipToPage() rewrites the internal spread
    // index before animating, so starting a new turn mid-flight would leave the
    // book on the wrong spread.
    if (pf.getState() === 'fold_corner') pf.getFlipController().showCorner({ x: -1e5, y: -1e5 });
    if (pf.getState() !== 'read') pf.getRender().finishAnimation();
    this.markDirty(30);
    const spreads = buildSpreads(this.opts.count, pf.getOrientation() === 'portrait' ? 'portrait' : 'landscape');
    const from = spreadIndexOf(spreads, pf.getCurrentPageIndex());
    const to = spreadIndexOf(spreads, page);
    if (from === to) return;
    if (!animate) {
      pf.turnToPage(spreads[to][0]);
      return;
    }
    if (to === from + 1) pf.flipNext('bottom');
    else if (to === from - 1) pf.flipPrev('bottom');
    else pf.flip(spreads[to][0], 'bottom');
  }

  current(): number {
    return this.pf.getCurrentPageIndex();
  }

  isBusy(): boolean {
    return this.pf.getState() !== 'read';
  }

  settle(): void {
    if (this.pf.getState() === 'flipping') {
      this.markDirty(10);
      this.pf.getRender().finishAnimation();
    }
  }

  lock(locked: boolean): void {
    this.locked = locked;
    if (locked) {
      // Drop any half-started gesture so nothing folds behind an overlay.
      (this.pf as unknown as { isUserTouch: boolean }).isUserTouch = false;
      if (this.pf.getState() === 'fold_corner') this.pf.getFlipController().showCorner({ x: -1e5, y: -1e5 });
      this.markDirty(20);
    }
  }

  hint(): void {
    if (this.locked || this.isBusy()) return;
    const r = this.pf.getBoundsRect();
    const fc = this.pf.getFlipController();
    this.markDirty(90);
    fc.showCorner({ x: r.left + r.width - 3, y: r.top + r.height - 3 });
    window.setTimeout(() => {
      if (this.pf.getState() === 'fold_corner') {
        this.markDirty(90);
        fc.showCorner({ x: -1e5, y: -1e5 });
      }
    }, 1150);
  }

  private markDirty(frames = 8): void {
    this.dirty = Math.max(this.dirty, frames);
  }

  private turnTarget(): number | null {
    const dir = this.pf.getRender().getDirection();
    if (dir === null) return null;
    const spreads = buildSpreads(this.opts.count, this.mode);
    const s = this.pf.getPageCollection().getCurrentSpreadIndex() + (dir === 0 ? 1 : -1);
    return spreads[s] ? spreads[s][0] : null;
  }

  private patchRenderLoop(): void {
    const render = this.pf.getRender() as unknown as Internals;
    const draw = render.drawFrame.bind(render);
    render.drawFrame = () => {
      if (this.dirty > 0 || render.animation !== null || this.pf.getState() !== 'read') {
        if (this.dirty > 0) this.dirty--;
        draw();
      }
    };
  }

  private patchInput(): void {
    const pf = this.pf;
    const start = pf.startUserTouch.bind(pf);
    const move = pf.userMove.bind(pf);
    const stop = pf.userStop.bind(pf);
    pf.startUserTouch = (pos: Point) => {
      if (this.locked) return;
      this.markDirty();
      start(pos);
    };
    pf.userMove = (pos: Point, isTouch: boolean) => {
      if (this.locked) return;
      this.markDirty(3);
      move(pos, isTouch);
    };
    pf.userStop = (pos: Point, isSwipe?: boolean) => {
      if (this.locked) return;
      this.markDirty();
      stop(pos, isSwipe);
    };
  }

  private bindTouch(): void {
    const book = this.book;
    book.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length >= 2) {
          this.touch = null;
          if (!this.locked) this.host.onPinch();
          return;
        }
        const t = e.touches[0];
        this.touch = { x: t.clientX, y: t.clientY, t: performance.now() };
      },
      { passive: true },
    );
    book.addEventListener(
      'touchend',
      (e) => {
        const start = this.touch;
        this.touch = null;
        if (!start || e.changedTouches.length === 0 || this.locked) return;
        const t = e.changedTouches[0];
        const moved = Math.hypot(t.clientX - start.x, t.clientY - start.y);
        if (moved < 10 && performance.now() - start.t < 260) this.host.onTap(t.clientX, t.clientY);
      },
      { passive: true },
    );
  }
}
