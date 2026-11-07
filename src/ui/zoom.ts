import type { Page } from '../types';
import { clamp, el } from '../util';
import { trapFocus } from './platform';

/**
 * Detail view for examining gear and apparel: the visible page(s) at full
 * resolution with wheel / pinch / double-click zoom and drag to pan.
 */
export class Zoom {
  private s = 1;
  private x = 0;
  private y = 0;
  private fit = 1;
  private max = 2;
  private contentW = 1;
  private contentH = 1;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; cx: number; cy: number } | null = null;
  private returnFocus: HTMLElement | null = null;
  private closeTimer = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly viewport: HTMLElement,
    private readonly canvas: HTMLElement,
    private readonly level: HTMLElement,
    private readonly onToggle: (open: boolean) => void,
  ) {
    root.querySelectorAll<HTMLElement>('[data-close]').forEach((b) => b.addEventListener('click', () => this.hide()));
    root.querySelector('[data-zoom="in"]')?.addEventListener('click', () => this.zoomCenter(1.5));
    root.querySelector('[data-zoom="out"]')?.addEventListener('click', () => this.zoomCenter(1 / 1.5));
    root.addEventListener('keydown', (e) => this.onKey(e));
    viewport.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    viewport.addEventListener('pointerdown', (e) => this.onDown(e));
    viewport.addEventListener('pointermove', (e) => this.onMove(e));
    viewport.addEventListener('pointerup', (e) => this.onUp(e));
    viewport.addEventListener('pointercancel', (e) => this.onUp(e));
    viewport.addEventListener('dblclick', (e) => {
      if (this.s > this.fit * 1.05) this.reset();
      else this.zoomAt(2.5, e.clientX, e.clientY);
    });
    window.addEventListener('resize', () => {
      if (this.isOpen()) this.measure(true);
    });
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  show(pages: Page[]): void {
    window.clearTimeout(this.closeTimer);
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.canvas.replaceChildren();
    const h = Math.max(...pages.map((p) => p.height));
    let w = 0;
    for (const p of pages) {
      const scale = h / p.height;
      const img = el('img', 'zoom__img', { alt: `${p.label}, page ${p.number}`, draggable: 'false', decoding: 'async' });
      img.width = Math.round(p.width * scale);
      img.height = h;
      img.style.backgroundColor = p.color;
      if (p.lqip) img.style.backgroundImage = `url("${p.lqip}")`;
      img.src = p.src;
      w += img.width;
      this.canvas.append(img);
    }
    this.contentW = w;
    this.contentH = h;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.root.hidden = false;
    this.onToggle(true);
    this.measure(true);
    requestAnimationFrame(() => {
      this.root.classList.add('is-open');
      this.root.querySelector<HTMLElement>('[data-zoom="in"]')?.focus({ preventScroll: true });
    });
  }

  hide(): void {
    if (this.root.hidden) return;
    this.root.classList.remove('is-open');
    this.closeTimer = window.setTimeout(() => {
      this.root.hidden = true;
      this.canvas.replaceChildren();
    }, 240);
    this.pointers.clear();
    this.pinch = null;
    this.onToggle(false);
    this.returnFocus?.focus({ preventScroll: true });
  }

  private measure(resetView: boolean): void {
    const vw = this.viewport.clientWidth || window.innerWidth;
    const vh = this.viewport.clientHeight || window.innerHeight;
    this.fit = Math.min((vw - 32) / this.contentW, (vh - 96) / this.contentH);
    this.max = Math.max(this.fit * 2.5, 1.5);
    if (resetView) this.reset();
    else this.apply();
  }

  private reset(): void {
    this.s = this.fit;
    this.x = (this.viewport.clientWidth - this.contentW * this.s) / 2;
    this.y = (this.viewport.clientHeight - 64 - this.contentH * this.s) / 2 + 8;
    this.apply();
  }

  private zoomCenter(factor: number): void {
    const r = this.viewport.getBoundingClientRect();
    this.zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
  }

  private zoomAt(factor: number, cx: number, cy: number): void {
    const r = this.viewport.getBoundingClientRect();
    const px = cx - r.left;
    const py = cy - r.top;
    const next = clamp(this.s * factor, this.fit, this.max);
    const k = next / this.s;
    this.x = px - (px - this.x) * k;
    this.y = py - (py - this.y) * k;
    this.s = next;
    this.apply();
  }

  private apply(): void {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const w = this.contentW * this.s;
    const h = this.contentH * this.s;
    this.x = w <= vw ? (vw - w) / 2 : clamp(this.x, vw - w, 0);
    this.y = h <= vh - 64 ? (vh - 64 - h) / 2 + 8 : clamp(this.y, vh - h - 64, 0);
    this.canvas.style.transform = `translate3d(${this.x}px, ${this.y}px, 0) scale(${this.s})`;
    this.level.textContent = `${Math.round((this.s / this.fit) * 100)}%`;
    this.viewport.classList.toggle('is-zoomed', this.s > this.fit * 1.01);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022));
    this.zoomAt(factor, e.clientX, e.clientY);
  }

  private onDown(e: PointerEvent): void {
    this.viewport.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) this.pinch = this.pinchState();
    this.viewport.classList.add('is-dragging');
  }

  private onMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    this.pointers.set(e.pointerId, cur);
    if (this.pointers.size >= 2 && this.pinch) {
      const next = this.pinchState();
      this.x += next.cx - this.pinch.cx;
      this.y += next.cy - this.pinch.cy;
      this.zoomAt(next.dist / this.pinch.dist, next.cx, next.cy);
      this.pinch = next;
    } else if (this.pointers.size === 1) {
      this.x += cur.x - prev.x;
      this.y += cur.y - prev.y;
      this.apply();
    }
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.pinch = this.pointers.size >= 2 ? this.pinchState() : null;
    if (this.pointers.size === 0) this.viewport.classList.remove('is-dragging');
  }

  private pinchState(): { dist: number; cx: number; cy: number } {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  private onKey(e: KeyboardEvent): void {
    const step = 80;
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.hide();
        return;
      case '+':
      case '=':
        this.zoomCenter(1.4);
        break;
      case '-':
      case '_':
        this.zoomCenter(1 / 1.4);
        break;
      case '0':
        this.reset();
        break;
      case 'ArrowLeft':
        this.x += step;
        this.apply();
        break;
      case 'ArrowRight':
        this.x -= step;
        this.apply();
        break;
      case 'ArrowUp':
        this.y += step;
        this.apply();
        break;
      case 'ArrowDown':
        this.y -= step;
        this.apply();
        break;
      default:
        trapFocus(this.root, e);
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
}
