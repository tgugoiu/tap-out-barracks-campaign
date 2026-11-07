/** Shape of public/magazine/manifest.json, written by pipeline/build_publication.py. */
export interface ManifestPage {
  number: number;
  label: string;
  width: number;
  height: number;
  pt?: [number, number];
  src: string;
  bytes?: number;
  thumb: { src: string; width: number; height: number; bytes?: number };
  lqip?: string;
  color?: string;
}

export interface Manifest {
  schema: number;
  generatedAt?: string;
  pageCount: number;
  pageSize: { width: number; height: number };
  uniformPageSize?: boolean;
  pages: ManifestPage[];
  og?: { src: string; width: number; height: number };
  icon?: { src: string; width: number; height: number };
  download?: { src: string; bytes: number; sha256?: string } | null;
  source?: { fileName: string; bytes: number; sha256: string; pageCount: number };
}

export type ViewPreference = 'auto' | 'single' | 'double';
export type Mode = 'landscape' | 'portrait';

export interface ReaderConfig {
  defaultView: ViewPreference;
  flipTimeMs: number;
  coverDensity: 'soft' | 'hard';
  preloadSpreadsAhead: number;
  preloadSpreadsBehind: number;
  maxLoadedPages: number;
  concurrentRequests: number;
  controlsAutoHideMs: number;
  cornerHint: boolean;
  resumePrompt: boolean;
  gutterShadow: number;
  pageStack: boolean;
}

export interface SiteConfig {
  title: string;
  subtitle: string;
  description: string;
  siteUrl: string;
  lang: string;
  themeColor: string;
  download: { mode: 'auto' | 'external' | 'none'; externalUrl: string; label: string };
  reader: ReaderConfig;
}

/** A page as the reader holds it: manifest data plus resolved URLs. */
export interface Page {
  index: number;
  number: number;
  label: string;
  width: number;
  height: number;
  src: string;
  thumb: string;
  thumbWidth: number;
  thumbHeight: number;
  lqip: string;
  color: string;
  bytes: number;
}
