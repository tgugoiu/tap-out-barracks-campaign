import type { Mode, ViewPreference } from './types';

/**
 * Reading order, matching StPageFlip's showCover behaviour exactly:
 * landscape = front cover alone, facing pairs, and the last page alone when
 * the count is even (a back cover); portrait = one page per spread.
 */
export function buildSpreads(count: number, mode: Mode): number[][] {
  const spreads: number[][] = [];
  if (count <= 0) return spreads;
  if (mode === 'portrait') {
    for (let i = 0; i < count; i++) spreads.push([i]);
    return spreads;
  }
  spreads.push([0]);
  for (let i = 1; i < count; i += 2) {
    spreads.push(i < count - 1 ? [i, i + 1] : [i]);
  }
  return spreads;
}

export function spreadIndexOf(spreads: number[][], page: number): number {
  for (let s = 0; s < spreads.length; s++) if (spreads[s].includes(page)) return s;
  return 0;
}

export interface Fit {
  mode: Mode;
  pageW: number;
  pageH: number;
  /** True when a two-page spread would still be a comfortable size here. */
  canSpread: boolean;
}

/**
 * Largest page size that fits the available box, choosing between a spread
 * and a single page. "auto" prefers spreads unless they would shrink the
 * page below ~72 % of the single-page height (phones and tall tablets).
 */
export function fitBook(availW: number, availH: number, ratio: number, pref: ViewPreference): Fit {
  const w = Math.max(80, availW);
  const h = Math.max(80, availH);
  const spreadH = Math.min(h, w / (2 * ratio));
  const singleH = Math.min(h, w / ratio);
  const canSpread = spreadH >= singleH * 0.72 && spreadH * ratio >= 150;
  let mode: Mode = canSpread ? 'landscape' : 'portrait';
  if (pref === 'single') mode = 'portrait';
  if (pref === 'double' && spreadH * ratio >= 120) mode = 'landscape';
  const pageH = Math.floor(mode === 'landscape' ? spreadH : singleH);
  const pageW = Math.floor(pageH * ratio);
  return { mode, pageW: Math.max(1, pageW), pageH: Math.max(1, pageH), canSpread };
}

/** "2–3", "Cover" style labels for a spread. */
export function spreadLabel(spread: number[]): string {
  return spread.length === 2 ? `${spread[0] + 1}–${spread[1] + 1}` : `${spread[0] + 1}`;
}
