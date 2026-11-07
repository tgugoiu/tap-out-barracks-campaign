import type { PageView } from './pages';
import type { Page } from './types';

type State = 'idle' | 'loading' | 'loaded' | 'error';

export interface LoadRecord {
  index: number;
  priority: 'high' | 'low';
  t0: number;
  t1?: number;
  ok?: boolean;
}

export interface LoaderOptions {
  concurrency: number;
  maxLoaded: number;
  onReady?: (index: number) => void;
}

/**
 * Progressive page loader.
 *
 * StPageFlip keeps every page in the DOM (hidden ones get display:none and
 * are restyled every frame), so native lazy-loading cannot be relied on, and
 * its image mode requests every page at construction. Instead nothing has a
 * `src` until this loader assigns it:
 *
 *  - visible pages start at once with high fetch priority;
 *  - prefetches (nearby spreads) wait until no visible page is still loading,
 *    then run with limited concurrency;
 *  - prefetches that are no longer near the reader are cancelled on a jump;
 *  - far-away pages are released once more than `maxLoaded` are held, so long
 *    sessions on phones do not pile up decoded images.
 *
 * A page shows its inline blurred placeholder until its image has loaded and
 * decoded, so a turn never exposes an empty frame.
 */
export class PageLoader {
  private readonly state: State[];
  private readonly token: number[];
  private readonly attempts: number[];
  private queue: number[] = [];
  private visible = new Set<number>();
  private keep = new Set<number>();
  private center = 0;
  private readonly inflight = new Set<number>();
  readonly log: LoadRecord[] = [];

  constructor(
    private readonly views: PageView[],
    private readonly pages: Page[],
    private readonly opts: LoaderOptions,
  ) {
    this.state = pages.map(() => 'idle');
    this.token = pages.map(() => 0);
    this.attempts = pages.map(() => 0);
    for (const view of views) {
      view.retry.addEventListener('click', (e) => {
        e.stopPropagation();
        this.retry(view.index);
      });
    }
  }

  /** Declare what the reader sees now and what it is likely to see next (in priority order). */
  focus(visible: number[], prefetch: number[]): void {
    this.visible = new Set(visible);
    this.center = visible.length ? visible.reduce((a, b) => a + b, 0) / visible.length : 0;
    const desired = [...visible, ...prefetch.filter((i) => !this.visible.has(i))];
    this.keep = new Set(desired);
    for (const i of [...this.inflight]) if (!this.keep.has(i)) this.cancel(i);
    this.queue = desired.filter((i) => this.state[i] === 'idle');
    this.pump();
    this.evict();
  }

  isReady(index: number): boolean {
    return this.state[index] === 'loaded';
  }

  /** Resolves when all the given pages are loaded (or failed), or after `timeoutMs`. */
  whenSettled(indices: number[], timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const started = performance.now();
      const check = (): void => {
        const settled = indices.every((i) => this.state[i] === 'loaded' || this.state[i] === 'error');
        if (settled || performance.now() - started > timeoutMs) resolve();
        else setTimeout(check, 40);
      };
      check();
    });
  }

  retry(index: number): void {
    this.attempts[index] = 0;
    this.state[index] = 'idle';
    this.views[index].root.classList.remove('is-error');
    this.views[index].retry.hidden = true;
    this.queue.unshift(index);
    this.visible.add(index);
    this.pump();
  }

  counts(): Record<State, number> {
    const c: Record<State, number> = { idle: 0, loading: 0, loaded: 0, error: 0 };
    for (const s of this.state) c[s]++;
    return c;
  }

  states(): State[] {
    return [...this.state];
  }

  private pump(): void {
    for (const i of [...this.queue]) {
      if (this.visible.has(i) && this.state[i] === 'idle') {
        this.queue.splice(this.queue.indexOf(i), 1);
        this.start(i, 'high');
      }
    }
    for (const i of this.inflight) if (this.visible.has(i)) return;
    while (this.inflight.size < this.opts.concurrency && this.queue.length) {
      const i = this.queue.shift()!;
      if (this.state[i] === 'idle') this.start(i, 'low');
    }
  }

  private start(i: number, priority: 'high' | 'low'): void {
    const page = this.pages[i];
    const view = this.views[i];
    if (!page.src) {
      this.fail(i);
      return;
    }
    const token = ++this.token[i];
    this.state[i] = 'loading';
    this.inflight.add(i);
    const record: LoadRecord = { index: i, priority, t0: performance.now() };
    this.log.push(record);
    const img = view.img;

    const done = (ok: boolean): void => {
      if (token !== this.token[i]) return;
      img.onload = img.onerror = null;
      this.inflight.delete(i);
      record.t1 = performance.now();
      record.ok = ok;
      if (ok) {
        this.state[i] = 'loaded';
        view.root.classList.add('is-ready');
        view.root.classList.remove('is-error');
        view.retry.hidden = true;
        this.opts.onReady?.(i);
      } else if (++this.attempts[i] < 2) {
        this.state[i] = 'idle';
        img.removeAttribute('src');
        setTimeout(() => {
          if (this.keep.has(i) && this.state[i] === 'idle') {
            this.queue.unshift(i);
            this.pump();
          }
        }, 1200);
      } else {
        this.fail(i);
      }
      this.pump();
      this.evict();
    };

    img.fetchPriority = priority;
    img.onload = () => {
      // Decode before revealing, so the first frame that shows it is complete.
      img.decode().then(
        () => done(true),
        () => done(true),
      );
    };
    img.onerror = () => done(false);
    img.src = page.src;
  }

  private cancel(i: number): void {
    this.token[i]++;
    this.inflight.delete(i);
    this.state[i] = 'idle';
    const img = this.views[i].img;
    img.onload = img.onerror = null;
    img.removeAttribute('src');
  }

  private fail(i: number): void {
    this.state[i] = 'error';
    this.inflight.delete(i);
    this.views[i].root.classList.add('is-error');
    this.views[i].retry.hidden = false;
  }

  private evict(): void {
    const loaded: number[] = [];
    this.state.forEach((s, i) => s === 'loaded' && loaded.push(i));
    let excess = loaded.length - this.opts.maxLoaded;
    if (excess <= 0) return;
    const far = loaded
      .filter((i) => !this.keep.has(i))
      .sort((a, b) => Math.abs(b - this.center) - Math.abs(a - this.center));
    for (const i of far) {
      if (excess-- <= 0) break;
      this.token[i]++;
      this.state[i] = 'idle';
      this.views[i].root.classList.remove('is-ready');
      this.views[i].img.removeAttribute('src');
    }
  }
}
