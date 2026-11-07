import type { PageView } from '../pages';
import type { Mode } from '../types';

export interface RendererHost {
  /** The visible spread changed; `page` is its first page index. */
  onChange(page: number): void;
  /** An animated turn began towards the spread that starts at `page` (when known). */
  onTurnStart(page: number | null): void;
  /** A quick tap (touch) on the book, in viewport coordinates. */
  onTap(x: number, y: number): void;
  /** Two fingers landed on the book. */
  onPinch(): void;
}

export interface Renderer {
  readonly kind: 'flip' | 'simple';
  mount(book: HTMLElement, views: PageView[], startPage: number, mode: Mode): void;
  /** Re-fit after the book element was resized and/or the mode changed. */
  layout(mode: Mode): void;
  go(page: number, animate: boolean): void;
  current(): number;
  isBusy(): boolean;
  /** Complete a programmatic turn that is still animating (no-op while the reader drags). */
  settle(): void;
  /** Ignore pointer input on the pages (while overlays are open). */
  lock(locked: boolean): void;
  /** Briefly lift the corner of the current right-hand page. */
  hint(): void;
}
