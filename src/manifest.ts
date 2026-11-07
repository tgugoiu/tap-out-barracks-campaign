import { MANIFEST_URL } from './config';
import type { Manifest, Page } from './types';

export interface Publication {
  manifest: Manifest;
  pages: Page[];
  /** Reference page aspect (width / height) used for the book frame. */
  ratio: number;
  refWidth: number;
  refHeight: number;
  downloadUrl: string | null;
  downloadBytes: number;
}

const FALLBACK_COLOR = '#1a1616';

/** Fetches and checks the manifest; resolves every asset URL against it. */
export async function loadPublication(): Promise<Publication> {
  const manifestUrl = new URL(MANIFEST_URL, document.baseURI);
  const res = await fetch(manifestUrl, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const manifest = (await res.json()) as Manifest;
  if (!manifest || !Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    throw new Error('manifest has no pages');
  }

  const resolve = (src: string): string => new URL(src, manifestUrl).href;
  const ref = manifest.pageSize?.width > 0 && manifest.pageSize?.height > 0 ? manifest.pageSize : manifest.pages[0];
  const refWidth = Math.max(1, Number(ref.width) || 1);
  const refHeight = Math.max(1, Number(ref.height) || 1);

  const pages: Page[] = manifest.pages.map((p, index) => {
    const width = Number(p.width) > 0 ? Number(p.width) : refWidth;
    const height = Number(p.height) > 0 ? Number(p.height) : refHeight;
    return {
      index,
      number: index + 1,
      label: typeof p.label === 'string' && p.label ? p.label : `Page ${index + 1}`,
      width,
      height,
      src: typeof p.src === 'string' && p.src ? resolve(p.src) : '',
      thumb: p.thumb && typeof p.thumb.src === 'string' ? resolve(p.thumb.src) : '',
      thumbWidth: p.thumb?.width || Math.round(width / 4),
      thumbHeight: p.thumb?.height || Math.round(height / 4),
      lqip: typeof p.lqip === 'string' && p.lqip.startsWith('data:image/') ? p.lqip : '',
      color: typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : FALLBACK_COLOR,
      bytes: Number(p.bytes) || 0,
    };
  });

  const download = manifest.download && typeof manifest.download.src === 'string' ? manifest.download : null;
  return {
    manifest,
    pages,
    ratio: refWidth / refHeight,
    refWidth,
    refHeight,
    downloadUrl: download ? resolve(download.src) : null,
    downloadBytes: download?.bytes ?? 0,
  };
}
