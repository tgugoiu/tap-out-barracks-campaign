import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import site from './site.config.json' with { type: 'json' };

const ROOT = import.meta.dirname;

/** "/repo/" from BASE_PATH (set by the Pages workflow) or from siteUrl in site.config.json. */
function productionBase(): string {
  const fromEnv = process.env.BASE_PATH;
  let path = '/';
  if (fromEnv !== undefined && fromEnv !== '') path = fromEnv;
  else {
    try {
      path = new URL(site.siteUrl).pathname;
    } catch {
      path = '/';
    }
  }
  path = `/${path}/`.replace(/\/{2,}/g, '/');
  return path;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

interface ManifestLite {
  pages?: { src: string }[];
  og?: { src: string; width: number; height: number };
  icon?: { src: string };
  download?: { src: string } | null;
}

function readManifest(): ManifestLite | null {
  const path = resolve(ROOT, 'public/magazine/manifest.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ManifestLite;
  } catch {
    return null;
  }
}

/** Fills the {{tokens}} in index.html from site.config.json and the generated manifest. */
function siteHtml(): Plugin {
  let base = '/';
  return {
    name: 'tob-site-html',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const manifest = readManifest();
        const full = site.subtitle ? `${site.title} — ${site.subtitle}` : site.title;
        const siteUrl = site.siteUrl.endsWith('/') ? site.siteUrl : `${site.siteUrl}/`;
        const head: string[] = [];
        head.push(`<meta property="og:type" content="website" />`);
        head.push(`<meta property="og:site_name" content="${esc(site.title)}" />`);
        head.push(`<meta property="og:title" content="${esc(full)}" />`);
        head.push(`<meta property="og:description" content="${esc(site.description)}" />`);
        if (site.siteUrl) head.push(`<meta property="og:url" content="${esc(siteUrl)}" />`);
        if (manifest?.og && site.siteUrl) {
          const img = `${siteUrl}magazine/${manifest.og.src}`;
          head.push(`<meta property="og:image" content="${esc(img)}" />`);
          head.push(`<meta property="og:image:width" content="${manifest.og.width}" />`);
          head.push(`<meta property="og:image:height" content="${manifest.og.height}" />`);
          head.push(`<meta property="og:image:alt" content="${esc(`${full}, front cover`)}" />`);
          head.push(`<meta name="twitter:card" content="summary_large_image" />`);
          head.push(`<meta name="twitter:image" content="${esc(img)}" />`);
        }
        if (manifest?.icon) head.push(`<link rel="apple-touch-icon" href="${base}magazine/${esc(manifest.icon.src)}" />`);
        const cover = manifest?.pages?.[0]?.src;
        if (cover) {
          // The cover is the first thing the reader shows: start it alongside the scripts.
          head.push(`<link rel="preload" as="image" href="${base}magazine/${esc(cover)}" fetchpriority="high" />`);
        }

        let noscriptLink = '';
        if (site.download.mode === 'external' && site.download.externalUrl) {
          noscriptLink = `<a href="${esc(site.download.externalUrl)}">${esc(site.download.label)}</a>`;
        } else if (site.download.mode === 'auto' && manifest?.download) {
          noscriptLink = `<a href="${base}magazine/${esc(manifest.download.src)}">${esc(site.download.label)}</a>`;
        }

        const tokens: Record<string, string> = {
          lang: esc(site.lang),
          fullTitle: esc(full),
          title: esc(site.title),
          subtitle: esc(site.subtitle),
          description: esc(site.description),
          themeColor: esc(site.themeColor),
          headExtra: head.join('\n    '),
          noscriptLink,
        };
        return html.replace(/\{\{(\w+)\}\}/g, (m, key: string) => tokens[key] ?? m);
      },
    },
    generateBundle() {
      // GitHub Pages serves 404.html for unknown paths; send visitors back to the book.
      const target = JSON.stringify(base);
      this.emitFile({
        type: 'asset',
        fileName: '404.html',
        source:
          `<!doctype html><html lang="${esc(site.lang)}"><head><meta charset="utf-8" />` +
          `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
          `<title>${esc(site.title)}</title><meta name="robots" content="noindex" />` +
          `<meta http-equiv="refresh" content="0; url=${esc(base)}" />` +
          `<script>location.replace(${target} + location.hash)</script></head>` +
          `<body style="background:#0b0909;color:#b9ae9d;font:14px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0">` +
          `<a style="color:#c6a66e" href="${esc(base)}">Open the magazine</a></body></html>\n`,
      });
    },
  };
}

export default defineConfig(({ command, isPreview }) => ({
  // Dev serves at "/"; builds and `vite preview` use the Pages project path.
  base: command === 'build' || isPreview ? productionBase() : '/',
  plugins: [siteHtml()],
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    sourcemap: false,
    reportCompressedSize: true,
  },
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  preview: { host: '127.0.0.1', port: 4180, strictPort: true },
}));
