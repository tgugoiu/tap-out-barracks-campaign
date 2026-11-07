import { el, media } from '../util';

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

export const fullscreen = {
  supported(): boolean {
    const d = document as FsDocument;
    return Boolean(d.fullscreenEnabled || d.webkitFullscreenEnabled);
  },
  active(): boolean {
    const d = document as FsDocument;
    return Boolean(d.fullscreenElement || d.webkitFullscreenElement);
  },
  async toggle(): Promise<void> {
    const d = document as FsDocument;
    try {
      if (this.active()) {
        if (d.exitFullscreen) await d.exitFullscreen();
        else await d.webkitExitFullscreen?.();
      } else {
        const root = document.documentElement as FsElement;
        if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
        else await root.webkitRequestFullscreen?.();
      }
    } catch {
      /* refused (iframe without allowfullscreen, or no user gesture) */
    }
  },
  onChange(cb: () => void): void {
    document.addEventListener('fullscreenchange', cb);
    document.addEventListener('webkitfullscreenchange', cb);
  },
};

export type ShareResult = 'shared' | 'copied' | 'cancelled' | 'failed';

/** Native share sheet on touch devices, clipboard elsewhere. */
export async function shareLink(url: string, title: string): Promise<ShareResult> {
  if (typeof navigator.share === 'function' && media.coarse()) {
    try {
      await navigator.share({ title, url });
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    /* clipboard API blocked: fall back to a selection copy */
  }
  const ta = el('textarea', 'visually-hidden');
  ta.value = url;
  ta.setAttribute('readonly', '');
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok ? 'copied' : 'failed';
}

/** Keeps Tab focus inside a dialog. */
export function trapFocus(root: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  const items = [...root.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]:not([tabindex="-1"])')].filter(
    (n) => !n.hasAttribute('disabled') && !n.hidden && n.offsetParent !== null,
  );
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
