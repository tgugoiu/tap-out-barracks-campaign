#!/usr/bin/env python3
"""Render a finished magazine PDF into the web edition's page assets.

Each PDF page is treated as a finished composition: it is rendered whole at
its own aspect ratio and is never cropped, split, retouched or reordered.

Output (default public/magazine/, replaced as a unit on every run):

    manifest.json              page order, sizes, asset URLs, placeholders
    pages/p001-<hash>.webp     reading-size page renders
    thumbs/t001-<hash>.webp    contact-sheet thumbnails
    og-cover.jpg               1200x630 link-preview image of the cover
    icon-180.png               home-screen icon (cover on charcoal)
    download/<name>.pdf        byte-identical copy of the PDF (optional)

Usage:
    python pipeline/build_publication.py path/to/magazine.pdf
    python pipeline/build_publication.py path/to/magazine.pdf --no-include-pdf --long-edge 1600

Defaults come from the "pipeline" block of site.config.json; flags override them.
The script never writes to, or next to, the input PDF.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import shutil
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_VERSION = 1
GENERATOR_VERSION = "1.0.0"

DEFAULTS = {
    "outputDir": "public/magazine",
    "pageLongEdge": 1800,
    "pageQuality": 90,
    "thumbLongEdge": 420,
    "thumbQuality": 80,
    "lqipLongEdge": 24,
    "supersample": 1.5,
    "webpMethod": 6,
    "includePdf": True,
    "pdfFileName": "",
}

CHARCOAL = (12, 10, 10)


# ---------------------------------------------------------------- utilities

def log(msg: str) -> None:
    print(msg, flush=True)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_config(path: Path) -> dict:
    cfg = dict(DEFAULTS)
    if path.is_file():
        data = json.loads(path.read_text(encoding="utf-8"))
        cfg.update(data.get("pipeline", {}))
    return cfg


def safe_file_name(name: str) -> str:
    keep = "".join(c if (c.isalnum() or c in "-_.") else "-" for c in name.strip())
    while "--" in keep:
        keep = keep.replace("--", "-")
    keep = keep.strip("-.") or "magazine"
    return keep if keep.lower().endswith(".pdf") else keep + ".pdf"


def write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        f.write(data)


def encode_webp(img, quality: int, method: int) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=quality, method=method)
    return buf.getvalue()


# ------------------------------------------------------------ page workers

_DOC = None


def _worker_init(pdf_path: str) -> None:
    global _DOC
    import pymupdf

    pymupdf.TOOLS.set_icc(True)  # honour embedded ICC profiles; output is sRGB
    _DOC = pymupdf.open(pdf_path)


def render_page(job: dict) -> dict:
    """Render one page; write its page and thumbnail files into the staging dir."""
    import pymupdf
    from PIL import Image

    index = job["index"]
    opts = job["opts"]
    staging = Path(job["staging"])
    page = _DOC[index]
    rect = page.rect
    long_pt = max(rect.width, rect.height)

    # Target size keeps the page's own aspect ratio exactly.
    scale = opts["pageLongEdge"] / long_pt
    target = (max(1, round(rect.width * scale)), max(1, round(rect.height * scale)))

    # Supersample, then reduce with Lanczos: cleaner photo detail and edges
    # than rasterising straight at the target size.
    ss = max(1.0, float(opts["supersample"]))
    matrix = pymupdf.Matrix(scale * ss, scale * ss)
    pix = page.get_pixmap(matrix=matrix, colorspace=pymupdf.csRGB, alpha=False, annots=False)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    del pix
    if img.size != target:
        img = img.resize(target, Image.LANCZOS)

    number = index + 1
    page_bytes = encode_webp(img, opts["pageQuality"], opts["webpMethod"])
    page_name = f"p{number:03d}-{sha256_bytes(page_bytes)[:10]}.webp"
    write_bytes(staging / "pages" / page_name, page_bytes)

    t_scale = opts["thumbLongEdge"] / max(target)
    t_size = (max(1, round(target[0] * t_scale)), max(1, round(target[1] * t_scale)))
    thumb = img.resize(t_size, Image.LANCZOS)
    thumb_bytes = encode_webp(thumb, opts["thumbQuality"], opts["webpMethod"])
    thumb_name = f"t{number:03d}-{sha256_bytes(thumb_bytes)[:10]}.webp"
    write_bytes(staging / "thumbs" / thumb_name, thumb_bytes)

    l_scale = opts["lqipLongEdge"] / max(target)
    l_size = (max(1, round(target[0] * l_scale)), max(1, round(target[1] * l_scale)))
    lqip = thumb.resize(l_size, Image.LANCZOS)
    lqip_bytes = encode_webp(lqip, 50, 6)
    avg = img.resize((1, 1), Image.BOX).getpixel((0, 0))

    result = {
        "index": index,
        "width": target[0],
        "height": target[1],
        "pt": [round(rect.width, 2), round(rect.height, 2)],
        "src": f"pages/{page_name}",
        "bytes": len(page_bytes),
        "thumb": {"src": f"thumbs/{thumb_name}", "width": t_size[0], "height": t_size[1], "bytes": len(thumb_bytes)},
        "lqip": "data:image/webp;base64," + base64.b64encode(lqip_bytes).decode("ascii"),
        "color": "#%02x%02x%02x" % tuple(avg[:3]),
    }
    if index == 0:
        # Keep the cover around for the link-preview and icon images.
        cover_path = staging / ".cover-0.png"
        img.save(cover_path, "PNG")
        result["_coverPng"] = str(cover_path)
    return result


# --------------------------------------------------------- derived images

def make_og_image(cover_png: Path, out: Path) -> dict:
    from PIL import Image, ImageFilter

    W, H = 1200, 630
    cover = Image.open(cover_png).convert("RGB")
    ch = 560
    cw = round(cover.width * ch / cover.height)
    cover = cover.resize((cw, ch), Image.LANCZOS)

    canvas = Image.new("RGB", (W, H), CHARCOAL)
    # Soft warm pool of light behind the book.
    glow = Image.new("L", (W, H), 0)
    gw, gh = int(W * 0.7), int(H * 1.1)
    glow_box = Image.new("L", (gw, gh), 0)
    from PIL import ImageDraw

    ImageDraw.Draw(glow_box).ellipse((0, 0, gw, gh), fill=70)
    glow.paste(glow_box, ((W - gw) // 2, (H - gh) // 2))
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    warm = Image.new("RGB", (W, H), (58, 40, 34))
    canvas = Image.composite(warm, canvas, glow)

    x, y = (W - cw) // 2, (H - ch) // 2
    shadow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(shadow).rectangle((x + 6, y + 16, x + cw + 6, y + ch + 14), fill=210)
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    canvas = Image.composite(Image.new("RGB", (W, H), (0, 0, 0)), canvas, shadow)
    canvas.paste(cover, (x, y))

    buf = io.BytesIO()
    canvas.save(buf, "JPEG", quality=88, optimize=True, progressive=True)
    write_bytes(out, buf.getvalue())
    return {"src": out.name, "width": W, "height": H, "bytes": len(buf.getvalue())}


def make_icon(cover_png: Path, out: Path, size: int = 180) -> dict:
    from PIL import Image

    cover = Image.open(cover_png).convert("RGB")
    inner = int(size * 0.86)
    s = inner / max(cover.size)
    cover = cover.resize((max(1, round(cover.width * s)), max(1, round(cover.height * s))), Image.LANCZOS)
    canvas = Image.new("RGB", (size, size), CHARCOAL)
    canvas.paste(cover, ((size - cover.width) // 2, (size - cover.height) // 2))
    buf = io.BytesIO()
    canvas.save(buf, "PNG", optimize=True)
    write_bytes(out, buf.getvalue())
    return {"src": out.name, "width": size, "height": size}


# ------------------------------------------------------------- publishing

def swap_in(staging: Path, out_dir: Path) -> None:
    """Replace out_dir with staging as a unit, so no orphaned pages survive."""
    old = out_dir.with_name(out_dir.name + f".old-{os.getpid()}")
    for attempt in range(12):
        try:
            if out_dir.exists():
                out_dir.rename(old)
            staging.rename(out_dir)
            break
        except PermissionError:
            # Windows: a dev server or explorer window may briefly hold a handle.
            if old.exists() and not out_dir.exists():
                old.rename(out_dir)
            time.sleep(0.25 * (attempt + 1))
    else:
        # Last resort: empty the target in place, then move the new files in.
        out_dir.mkdir(parents=True, exist_ok=True)
        for child in out_dir.iterdir():
            shutil.rmtree(child) if child.is_dir() else child.unlink()
        for child in staging.iterdir():
            shutil.move(str(child), str(out_dir / child.name))
        shutil.rmtree(staging, ignore_errors=True)
    if old.exists():
        shutil.rmtree(old, ignore_errors=True)


def spread_map(count: int) -> str:
    """The reading order the viewer uses: cover alone, facing pairs, back cover alone if even."""
    if count == 0:
        return "(empty)"
    parts = ["[1]"]
    i = 1
    while i < count:
        if i + 1 < count:
            parts.append(f"[{i + 1}|{i + 2}]")
            i += 2
        else:
            parts.append(f"[{i + 1}]")
            i += 1
    return " ".join(parts)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf", type=Path, help="finished magazine PDF")
    ap.add_argument("--config", type=Path, default=ROOT / "site.config.json")
    ap.add_argument("--out", type=Path, help="output dir (default: pipeline.outputDir)")
    ap.add_argument("--long-edge", type=int, dest="pageLongEdge")
    ap.add_argument("--quality", type=int, dest="pageQuality")
    ap.add_argument("--thumb-long-edge", type=int, dest="thumbLongEdge")
    ap.add_argument("--thumb-quality", type=int, dest="thumbQuality")
    ap.add_argument("--supersample", type=float)
    ap.add_argument("--include-pdf", dest="includePdf", action="store_true", default=None)
    ap.add_argument("--no-include-pdf", dest="includePdf", action="store_false")
    ap.add_argument("--pdf-name", dest="pdfFileName")
    ap.add_argument("--jobs", type=int, default=max(1, min(6, (os.cpu_count() or 2) - 1)))
    args = ap.parse_args(argv)

    try:
        import pymupdf  # noqa: F401
        import PIL  # noqa: F401
    except ImportError as exc:
        log(f"Missing dependency: {exc.name}. Run: python -m pip install -r pipeline/requirements.txt")
        return 2

    import pymupdf
    import PIL

    opts = load_config(args.config)
    for key in ("pageLongEdge", "pageQuality", "thumbLongEdge", "thumbQuality", "supersample", "includePdf", "pdfFileName"):
        val = getattr(args, key, None)
        if val is not None:
            opts[key] = val
    out_dir = (args.out or (ROOT / opts["outputDir"])).resolve()

    pdf_path = args.pdf.resolve()
    if not pdf_path.is_file():
        log(f"PDF not found: {pdf_path}")
        return 2
    if out_dir == pdf_path.parent or pdf_path.is_relative_to(out_dir):
        log("Refusing to write the output next to, or over, the input PDF.")
        return 2

    t0 = time.time()
    pdf_sha = sha256_file(pdf_path)
    pdf_bytes = pdf_path.stat().st_size
    with pymupdf.open(pdf_path) as doc:
        if doc.needs_pass:
            log("The PDF is encrypted; export an unencrypted copy first.")
            return 2
        count = doc.page_count
        sizes = [(round(p.rect.width, 2), round(p.rect.height, 2)) for p in doc]
    if count == 0:
        log("The PDF has no pages.")
        return 2

    log(f"Source   {pdf_path.name}  {pdf_bytes / 1e6:.1f} MB  sha256 {pdf_sha[:16]}")
    log(f"Pages    {count}   page sizes (pt): {dict(Counter(sizes))}")
    log(f"Render   {opts['pageLongEdge']} px long edge, WebP q{opts['pageQuality']}, "
        f"supersample x{opts['supersample']}, thumbs {opts['thumbLongEdge']} px q{opts['thumbQuality']}, {args.jobs} jobs")

    out_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = out_dir.with_name(f".{out_dir.name}-staging-{os.getpid()}")
    if staging.exists():
        shutil.rmtree(staging)
    (staging / "pages").mkdir(parents=True)
    (staging / "thumbs").mkdir(parents=True)

    jobs = [{"index": i, "opts": opts, "staging": str(staging), "lastIndex": count - 1} for i in range(count)]
    results: list[dict] = []
    try:
        with ProcessPoolExecutor(max_workers=args.jobs, initializer=_worker_init, initargs=(str(pdf_path),)) as ex:
            for done, res in enumerate(ex.map(render_page, jobs), 1):
                results.append(res)
                if done % 8 == 0 or done == count:
                    log(f"  rendered {done}/{count}")
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    results.sort(key=lambda r: r["index"])
    extras: dict = {}
    cover_png = Path(results[0]["_coverPng"])
    for r in results:
        r.pop("_coverPng", None)
    extras["og"] = make_og_image(cover_png, staging / "og-cover.jpg")
    extras["icon"] = make_icon(cover_png, staging / "icon-180.png")
    for p in staging.glob(".cover-*.png"):
        p.unlink()

    download = None
    if opts["includePdf"]:
        name = safe_file_name(opts["pdfFileName"] or pdf_path.name)
        dest = staging / "download" / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(pdf_path, dest)
        if sha256_file(dest) != pdf_sha:
            shutil.rmtree(staging, ignore_errors=True)
            log("PDF copy does not match the source; aborting.")
            return 1
        download = {"src": f"download/{name}", "bytes": pdf_bytes, "sha256": pdf_sha}

    dims = Counter((r["width"], r["height"]) for r in results)
    (ref_w, ref_h), _ = dims.most_common(1)[0]
    pages = []
    for r in results:
        n = r["index"] + 1
        label = "Front cover" if n == 1 else ("Back cover" if (n == count and count > 2 and count % 2 == 0) else f"Page {n}")
        pages.append({"number": n, "label": label, **{k: v for k, v in r.items() if k != "index"}})

    manifest = {
        "schema": SCHEMA_VERSION,
        "generator": {
            "name": "pipeline/build_publication.py",
            "version": GENERATOR_VERSION,
            "pymupdf": pymupdf.VersionBind,
            "pillow": PIL.__version__,
        },
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "source": {"fileName": pdf_path.name, "bytes": pdf_bytes, "sha256": pdf_sha, "pageCount": count},
        "render": {k: opts[k] for k in ("pageLongEdge", "pageQuality", "thumbLongEdge", "thumbQuality", "lqipLongEdge", "supersample")},
        "pageCount": count,
        "pageSize": {"width": ref_w, "height": ref_h},
        "uniformPageSize": len(dims) == 1,
        "pages": pages,
        "og": extras["og"],
        "icon": extras["icon"],
        "download": download,
        "totals": {
            "pageBytes": sum(p["bytes"] for p in pages),
            "thumbBytes": sum(p["thumb"]["bytes"] for p in pages),
        },
    }
    write_bytes(staging / "manifest.json", (json.dumps(manifest, indent=1, ensure_ascii=False) + "\n").encode("utf-8"))

    # Sanity check before publishing the staging folder.
    from PIL import Image

    problems = []
    expected = {"manifest.json", "og-cover.jpg", "icon-180.png"} | {p["src"] for p in pages} | {p["thumb"]["src"] for p in pages}
    if download:
        expected.add(download["src"])
    found = {str(p.relative_to(staging)).replace("\\", "/") for p in staging.rglob("*") if p.is_file()}
    if found != expected:
        problems.append(f"file set mismatch: extra={sorted(found - expected)[:5]} missing={sorted(expected - found)[:5]}")
    for p in pages:
        with Image.open(staging / p["src"]) as im:
            if im.size != (p["width"], p["height"]):
                problems.append(f"page {p['number']}: {im.size} != {(p['width'], p['height'])}")
    if problems:
        shutil.rmtree(staging, ignore_errors=True)
        for msg in problems:
            log("ERROR " + msg)
        return 1

    swap_in(staging, out_dir)

    total_pages = manifest["totals"]["pageBytes"]
    biggest = max(pages, key=lambda p: p["bytes"])
    log(f"Pages    {total_pages / 1e6:.1f} MB total, avg {total_pages / count / 1e3:.0f} KB, "
        f"largest p{biggest['number']} {biggest['bytes'] / 1e3:.0f} KB")
    log(f"Thumbs   {manifest['totals']['thumbBytes'] / 1e6:.2f} MB total")
    log(f"PDF      {'included as ' + download['src'] if download else 'not included'}")
    log(f"Spreads  {spread_map(count)}")
    if len(dims) > 1:
        log(f"WARNING  {len(dims)} different page sizes; odd ones are letterboxed, never cropped: {dict(dims)}")
    if count % 2 == 1:
        log("WARNING  odd page count: the last page shares a spread instead of standing alone as a back cover.")
    log(f"Wrote    {out_dir.relative_to(ROOT) if out_dir.is_relative_to(ROOT) else out_dir}  in {time.time() - t0:.1f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
