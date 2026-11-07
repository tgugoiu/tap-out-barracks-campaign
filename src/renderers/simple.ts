import { buildSpreads, spreadIndexOf } from '../layout';
import type { PageView } from '../pages';
import type { Mode } from '../types';
import type { Renderer, RendererHost } from './types';

/**
 * Non-animated reader: the same spreads and page parity, with instant page
 * changes. Used for prefers-reduced-motion, `?reader=simple`, and as the
 * fallback if StPageFlip fails to start.
 */
export class SimpleRenderer implements Renderer {
  readonly kind = 'simple' as const;
  private book!: HTMLElement;
  private views: PageView[] = [];
  private mode: Mode = 'landscape';
  private spreads: number[][] = [];
  private spread = 0;
  private locked = false;
  private down: { x: number; y: number; t: number; type: string } | null = null;

  constructor(
    private readonly host: RendererHost,
    private readonly count: number,
  ) {}

  mount(book: HTMLElement, views: PageView[], startPage: number, mode: Mode): void {
    this.book = book;
    this.views = views;
    book.classList.add('book--simple');
    for (const v of views) book.append(v.root);
    this.mode = mode;
    this.spreads = buildSpreads(this.count, mode);
    this.spread = spreadIndexOf(this.spreads, startPage);
    this.place();
    this.bindInput();
  }

  layout(mode: Mode): void {
    const first = this.current();
    this.mode = mode;
    this.spreads = buildSpreads(this.count, mode);
    this.spread = spreadIndexOf(this.spreads, first);
    this.place();
    this.host.onChange(this.current());
  }

  go(page: number): void {
    const s = spreadIndexOf(this.spreads, page);
    if (s === this.spread) return;
    this.spread = s;
    this.place();
    this.host.onChange(this.current());
  }

  current(): number {
    return this.spreads[this.spread]?.[0] ?? 0;
  }

  isBusy(): boolean {
    return false;
  }

  settle(): void {
    /* nothing animates */
  }

  lock(locked: boolean): void {
    this.locked = locked;
  }

  hint(): void {
    /* no animation in this mode */
  }

  private place(): void {
    const w = this.book.clientWidth;
    const h = this.book.clientHeight;
    const pw = this.mode === 'landscape' ? w / 2 : w;
    const shown = this.spreads[this.spread] ?? [0];
    for (const v of this.views) {
      if (!shown.includes(v.index)) {
        v.root.style.cssText = 'display: none';
        continue;
      }
      let left = 0;
      let side: 'left' | 'right' = 'right';
      if (this.mode === 'landscape') {
        if (shown.length === 2) side = v.index === shown[0] ? 'left' : 'right';
        else side = v.index === this.count - 1 && this.count > 1 ? 'left' : 'right';
        left = side === 'left' ? 0 : pw;
      }
      v.root.classList.toggle('--left', side === 'left');
      v.root.classList.toggle('--right', side === 'right');
      v.root.style.cssText = `display:block;position:absolute;top:0;left:${left}px;width:${pw}px;height:${h}px;`;
    }
  }

  private bindInput(): void {
    this.book.addEventListener('pointerdown', (e) => {
      if (this.locked) return;
      this.down = { x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType };
    });
    this.book.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || this.locked) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) > 40 && Math.abs(dy) < 80) {
        this.step(dx < 0 ? 1 : -1);
      } else if (Math.hypot(dx, dy) < 10) {
        if (d.type === 'mouse') {
          const r = this.book.getBoundingClientRect();
          this.step(e.clientX < r.left + r.width / 2 ? -1 : 1);
        } else {
          this.host.onTap(e.clientX, e.clientY);
        }
      }
    });
    this.book.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length >= 2 && !this.locked) {
          this.down = null;
          this.host.onPinch();
        }
      },
      { passive: true },
    );
  }

  private step(delta: number): void {
    const s = Math.min(this.spreads.length - 1, Math.max(0, this.spread + delta));
    if (s !== this.spread) this.go(this.spreads[s][0]);
  }
}
