import { buildSpreads, spreadLabel } from '../layout';
import type { Page } from '../types';
import { el } from '../util';
import { trapFocus } from './platform';

/** Contact-sheet overview of every spread. Thumbnails load only once it is opened. */
export class Overview {
  private built = false;
  private sheets: HTMLButtonElement[] = [];
  private spreads: number[][] = [];
  private returnFocus: HTMLElement | null = null;
  private closeTimer = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly grid: HTMLElement,
    private readonly pages: Page[],
    private readonly ratio: number,
    private readonly onPick: (page: number) => void,
    private readonly onToggle: (open: boolean) => void,
  ) {
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
      } else trapFocus(root, e);
    });
    root.querySelector('[data-close]')?.addEventListener('click', () => this.hide());
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  show(currentPage: number): void {
    if (!this.built) this.build();
    window.clearTimeout(this.closeTimer);
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.root.hidden = false;
    this.onToggle(true);
    const current = this.spreads.findIndex((s) => s.includes(currentPage));
    this.sheets.forEach((b, i) => {
      const on = i === current;
      b.classList.toggle('is-current', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    requestAnimationFrame(() => {
      this.root.classList.add('is-open');
      const target = this.sheets[current] ?? this.sheets[0];
      target?.scrollIntoView({ block: 'center' });
      target?.focus({ preventScroll: true });
    });
  }

  hide(): void {
    if (this.root.hidden) return;
    this.root.classList.remove('is-open');
    this.closeTimer = window.setTimeout(() => {
      this.root.hidden = true;
    }, 260);
    this.onToggle(false);
    this.returnFocus?.focus({ preventScroll: true });
  }

  private build(): void {
    this.built = true;
    this.spreads = buildSpreads(this.pages.length, 'landscape');
    const last = this.pages.length - 1;
    const frag = document.createDocumentFragment();
    for (const spread of this.spreads) {
      const item = el('div', 'overview__item', { role: 'listitem' });
      const btn = el('button', 'sheet', { type: 'button' });
      const first = spread[0];
      const name =
        spread.length === 2
          ? `Pages ${spread[0] + 1} and ${spread[1] + 1}`
          : first === 0
            ? 'Front cover'
            : first === last && last % 2 === 1
              ? 'Back cover'
              : `Page ${first + 1}`;
      btn.setAttribute('aria-label', name);
      if (spread.length === 1) btn.classList.add(first === 0 ? 'sheet--right' : 'sheet--left');

      const frame = el('span', 'sheet__pages');
      frame.style.aspectRatio = String(2 * this.ratio);
      for (const i of spread) {
        const p = this.pages[i];
        const img = el('img', 'sheet__img', {
          alt: '',
          loading: 'lazy',
          decoding: 'async',
          draggable: 'false',
          width: String(p.thumbWidth),
          height: String(p.thumbHeight),
        });
        img.style.backgroundColor = p.color;
        if (p.thumb) img.dataset.src = p.thumb;
        frame.append(img);
      }
      const label = el('span', 'sheet__label');
      label.textContent = spreadLabel(spread);
      btn.append(frame, label);
      btn.addEventListener('click', () => {
        this.hide();
        this.onPick(first);
      });
      item.append(btn);
      frag.append(item);
      this.sheets.push(btn);
    }
    this.grid.append(frag);

    // Thumbnails load as their row nears the view (native lazy-loading's
    // margin is so wide in Chromium that it would fetch the whole sheet).
    const reveal = (node: Element): void => {
      for (const img of node.querySelectorAll<HTMLImageElement>('img[data-src]')) {
        img.src = img.dataset.src!;
        img.removeAttribute('data-src');
      }
    };
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            reveal(e.target);
            io.unobserve(e.target);
          }
        },
        { root: this.grid, rootMargin: '320px 0px' },
      );
      for (const b of this.sheets) io.observe(b);
    } else {
      for (const b of this.sheets) reveal(b);
    }
  }
}
