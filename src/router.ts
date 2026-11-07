/**
 * Hash deep links: #page=24 (1-based). Hash routing keeps every URL inside
 * the single index.html, so GitHub Pages never serves a 404 for a page link.
 * Also accepts #24 and #p24.
 */
export function readHashPage(count: number): number | null {
  const raw = decodeURIComponent(window.location.hash.replace(/^#/, '')).trim();
  if (!raw) return null;
  let value: string | null = null;
  const params = new URLSearchParams(raw);
  if (params.has('page')) value = params.get('page');
  else if (/^p?\d+$/i.test(raw)) value = raw.replace(/^p/i, '');
  if (value === null || !/^\d+$/.test(value)) return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || count <= 0) return null;
  return Math.min(count, Math.max(1, n)) - 1;
}

export function pageUrl(index: number): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#page=${index + 1}`;
}

export function writeHash(index: number, mode: 'push' | 'replace'): void {
  const url = `${window.location.pathname}${window.location.search}#page=${index + 1}`;
  if (url === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  try {
    if (mode === 'push') window.history.pushState({ page: index }, '', url);
    else window.history.replaceState({ page: index }, '', url);
  } catch {
    /* some sandboxed embeds refuse history changes */
  }
}
