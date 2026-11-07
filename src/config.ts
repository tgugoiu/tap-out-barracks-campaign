import raw from '../site.config.json';
import type { ReaderConfig, SiteConfig } from './types';

const READER_DEFAULTS: ReaderConfig = {
  defaultView: 'auto',
  flipTimeMs: 850,
  coverDensity: 'hard',
  preloadSpreadsAhead: 2,
  preloadSpreadsBehind: 1,
  maxLoadedPages: 28,
  concurrentRequests: 4,
  controlsAutoHideMs: 2800,
  cornerHint: true,
  resumePrompt: true,
  gutterShadow: 0.22,
  pageStack: true,
};

const input = raw as unknown as Partial<SiteConfig> & { reader?: Partial<ReaderConfig> };

export const site: SiteConfig = {
  title: input.title ?? 'Magazine',
  subtitle: input.subtitle ?? '',
  description: input.description ?? '',
  siteUrl: input.siteUrl ?? '',
  lang: input.lang ?? 'en',
  themeColor: input.themeColor ?? '#0c0a0a',
  download: {
    mode: input.download?.mode ?? 'auto',
    externalUrl: input.download?.externalUrl ?? '',
    label: input.download?.label ?? 'Download the PDF',
  },
  reader: { ...READER_DEFAULTS, ...(input.reader ?? {}) },
};

/** Base URL of the deployed site ("/" locally, "/<repo>/" on GitHub Pages). */
export const BASE = import.meta.env.BASE_URL;
export const MANIFEST_URL = `${BASE}magazine/manifest.json`;
