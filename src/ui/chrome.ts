import type { Mode, Page } from '../types';
import { $, clamp, el, formatBytes, media } from '../util';

export interface ChromeActions {
  prev(): void;
  next(): void;
  overview(): void;
  view(): void;
  zoom(): void;
  share(): void;
  fullscreen(): void;
  scrub(spread: number): void;
}

export type SpreadPreview = (spread: number) => { pages: Page[]; label: string };

/**
 * Reader controls: dock, edge arrows, scrubber. They fade out while reading
 * and come back on mouse movement, keyboard focus, or a tap on the page.
 */
export class Chrome {
  private readonly holds = new Set<string>();
  private timer = 0;
  private hidden = true;
  private readonly folio: HTMLElement;
  private readonly range: HTMLInputElement;
  private readonly preview: HTMLElement;
  private readonly previewThumbs: HTMLElement;
  private readonly previewLabel: HTMLElement;
  private readonly viewBtn: HTMLButtonElement;
  private readonly fsBtn: HTMLButtonElement;
  private readonly download: HTMLAnchorElement;
  private spreadCount = 1;

  constructor(
    private readonly app: HTMLElement,
    private readonly actions: ChromeActions,
    private readonly autoHideMs: number,
    private readonly describe: SpreadPreview,
  ) {
    this.folio = $('#folio', app);
    this.range = $('#scrub-range', app) as HTMLInputElement;
    this.preview = $('#scrub-preview', app);
    this.previewThumbs = $('.scrub__thumbs', this.preview);
    this.previewLabel = $('.scrub__label', this.preview);
    this.viewBtn = $('#view-toggle', app) as HTMLButtonElement;
    this.fsBtn = $('#fullscreen', app) as HTMLButtonElement;
    this.download = $('#download', app) as HTMLAnchorElement;
    this.wire();
  }

  // ---------------------------------------------------------- visibility

  wake(ms = this.autoHideMs): void {
    if (this.hidden) {
      this.hidden = false;
      this.app.classList.remove('chrome-hidden');
    }
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.maybeHide(), ms);
  }

  hide(): void {
    window.clearTimeout(this.timer);
    if (this.holds.size > 0) return;
    this.hidden = true;
    this.app.classList.add('chrome-hidden');
    this.hidePreview();
  }

  toggle(): void {
    if (this.hidden) this.wake();
    else {
      this.holds.delete('hover');
      this.hide();
    }
  }

  hold(reason: string, on: boolean): void {
    if (on) {
      this.holds.add(reason);
      this.wake();
    } else {
      this.holds.delete(reason);
      if (this.holds.size === 0) this.wake();
    }
  }

  private maybeHide(): void {
    if (this.holds.size === 0) this.hide();
  }

  // -------------------------------------------------------------- state

  setPosition(spread: number, spreadCount: number, folio: string, total: number, ariaText: string): void {
    this.spreadCount = spreadCount;
    this.folio.innerHTML = '';
    const cur = el('span', 'folio__now');
    cur.textContent = folio;
    const tot = el('span', 'folio__total');
    tot.textContent = ` / ${total}`;
    this.folio.append(cur, tot);
    this.folio.setAttribute('aria-label', ariaText);

    const atStart = spread <= 0;
    const atEnd = spread >= spreadCount - 1;
    this.app.querySelectorAll<HTMLButtonElement>('[data-action="prev"]').forEach((b) => (b.disabled = atStart));
    this.app.querySelectorAll<HTMLButtonElement>('[data-action="next"]').forEach((b) => (b.disabled = atEnd));

    this.range.max = String(Math.max(1, spreadCount - 1));
    this.range.disabled = spreadCount <= 1;
    if (document.activeElement !== this.range) this.range.value = String(spread);
    this.range.setAttribute('aria-valuetext', ariaText);
    this.paintRange();
  }

  setView(mode: Mode, canSpread: boolean): void {
    const show = canSpread || mode === 'portrait' ? canSpread : false;
    this.viewBtn.hidden = !show;
    const single = mode === 'portrait';
    this.viewBtn.classList.toggle('is-single', single);
    const label = single ? 'Show facing pages' : 'Show single pages';
    this.viewBtn.setAttribute('aria-label', label);
    this.viewBtn.dataset.tip = single ? 'Facing pages' : 'Single page';
  }

  setFullscreen(supported: boolean, active: boolean): void {
    this.fsBtn.hidden = !supported;
    this.fsBtn.classList.toggle('is-active', active);
    this.fsBtn.setAttribute('aria-label', active ? 'Exit full screen' : 'Enter full screen');
    this.fsBtn.dataset.tip = active ? 'Exit full screen  F' : 'Full screen  F';
  }

  setDownload(url: string | null, bytes: number, label: string, external: boolean): void {
    if (!url) {
      this.download.hidden = true;
      return;
    }
    this.download.hidden = false;
    this.download.href = url;
    const size = bytes > 0 ? ` (${formatBytes(bytes)})` : '';
    this.download.setAttribute('aria-label', `${label}${size}`);
    this.download.dataset.tip = `PDF${size.replace(/[()]/g, '').replace(/^ /, ' · ')}`;
    if (external) {
      this.download.target = '_blank';
      this.download.rel = 'noopener';
      this.download.removeAttribute('download');
    } else {
      this.download.setAttribute('download', '');
    }
  }

  // ------------------------------------------------------------- wiring

  private wire(): void {
    this.app.querySelectorAll<HTMLElement>('[data-action]').forEach((node) => {
      const action = node.dataset.action as keyof ChromeActions | 'download';
      if (action === 'download') return;
      node.addEventListener('click', (e) => {
        e.preventDefault();
        if (action === 'scrub') return;
        (this.actions[action] as () => void)();
      });
    });

    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.wake();
    });
    window.addEventListener('mousedown', () => this.wake());

    for (const zone of this.app.querySelectorAll<HTMLElement>('.dock, .edge, .scrub, .masthead')) {
      zone.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse') this.hold('hover', true);
      });
      zone.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'mouse') this.hold('hover', false);
      });
      zone.addEventListener('focusin', () => this.hold('focus', true));
      zone.addEventListener('focusout', (e) => {
        const next = e.relatedTarget as Node | null;
        if (!next || !(next instanceof Element) || !next.closest('.chrome')) this.hold('focus', false);
      });
    }

    const range = this.range;
    range.addEventListener('input', () => {
      this.hold('scrub', true);
      this.paintRange();
      this.showPreview(Number(range.value));
    });
    let commit = 0;
    range.addEventListener('change', () => {
      // Keyboard stepping fires change per key press; commit once the keys stop.
      window.clearTimeout(commit);
      commit = window.setTimeout(() => {
        this.actions.scrub(Number(range.value));
        this.hold('scrub', false);
        window.setTimeout(() => this.hidePreview(), 500);
      }, 220);
    });
    range.addEventListener('blur', () => {
      this.hold('scrub', false);
      this.hidePreview();
    });
    range.addEventListener('pointermove', (e) => {
      if (!media.hover()) return;
      const r = range.getBoundingClientRect();
      const t = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
      this.showPreview(Math.round(t * (this.spreadCount - 1)));
    });
    range.addEventListener('pointerleave', () => {
      if (document.activeElement !== range) this.hidePreview();
    });
  }

  private paintRange(): void {
    const max = Math.max(1, Number(this.range.max));
    const p = (Number(this.range.value) / max) * 100;
    this.range.style.setProperty('--p', `${p}%`);
  }

  private showPreview(spread: number): void {
    const info = this.describe(clamp(spread, 0, this.spreadCount - 1));
    this.previewThumbs.replaceChildren();
    for (const page of info.pages) {
      const img = el('img', '', { alt: '', decoding: 'async', draggable: 'false' });
      img.style.backgroundColor = page.color;
      img.width = Math.round((page.thumbWidth / page.thumbHeight) * 96);
      img.height = 96;
      if (page.thumb) img.src = page.thumb;
      this.previewThumbs.append(img);
    }
    this.previewLabel.textContent = info.label;
    const r = this.range.getBoundingClientRect();
    const max = Math.max(1, this.spreadCount - 1);
    const x = r.left + (clamp(spread, 0, max) / max) * r.width;
    const half = info.pages.length * 40 + 12;
    this.preview.style.left = `${clamp(x, half, window.innerWidth - half)}px`;
    this.preview.classList.add('is-visible');
  }

  private hidePreview(): void {
    this.preview.classList.remove('is-visible');
  }
}
