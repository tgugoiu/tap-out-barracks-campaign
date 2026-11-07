export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  attrs?: Record<string, string>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export function $(selector: string, root: ParentNode = document): HTMLElement {
  const node = root.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Missing element ${selector}`);
  return node;
}

/** localStorage that never throws (private windows, blocked storage, previews). */
export const store = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: the reader works without it */
    }
  },
};

export const media = {
  reducedMotion: (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  coarse: (): boolean => window.matchMedia('(pointer: coarse)').matches,
  hover: (): boolean => window.matchMedia('(hover: hover)').matches,
};

export function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
