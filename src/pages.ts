import type { Page } from './types';
import { el } from './util';

/** DOM for one page. Renderers move `root`; the loader drives `img`. */
export interface PageView {
  index: number;
  root: HTMLElement;
  img: HTMLImageElement;
  retry: HTMLButtonElement;
}

/**
 * Builds a page element. The finished composition is shown whole: it fills
 * the frame when its aspect matches the book (within 0.6 %), otherwise it is
 * letterboxed (object-fit: contain), never cropped.
 */
export function createPageView(page: Page, total: number, ratio: number, density: 'soft' | 'hard'): PageView {
  const root = el('div', 'page', { 'data-density': density, 'data-index': String(page.index) });
  const fits = Math.abs(page.width / page.height - ratio) / ratio < 0.006;
  if (fits) root.classList.add('is-fill');

  const paper = el('div', 'page__paper');
  paper.style.backgroundColor = page.color;

  if (page.lqip) {
    const lqip = el('img', 'page__lqip', { alt: '', 'aria-hidden': 'true', decoding: 'async', draggable: 'false' });
    lqip.src = page.lqip;
    paper.append(lqip);
  }

  const img = el('img', 'page__img', {
    alt: `${page.label}, page ${page.number} of ${total}`,
    decoding: 'async',
    draggable: 'false',
    width: String(page.width),
    height: String(page.height),
  });
  const shade = el('span', 'page__shade', { 'aria-hidden': 'true' });
  const retry = el('button', 'page__retry', { type: 'button', hidden: '' });
  retry.textContent = 'Image unavailable · retry';

  paper.append(img, shade, retry);
  root.append(paper);
  return { index: page.index, root, img, retry };
}
