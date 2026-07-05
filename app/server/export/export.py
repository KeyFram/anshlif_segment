# -*- coding: utf-8 -*-
"""
Экспорт результатов проекта в ZIP.

Вызов:  python export.py <project_dir> <out_zip>
Опции:  env EXPORT_OPTS = JSON {"mask":bool, "orig":bool, "overlay":bool}

Для каждого обработанного изображения кладёт выбранные варианты:
  <base>_mask.png     — competition-маска (зелёный=обычные, красный=тонкие,
                        синий=тальк, чёрный=силикат/магнетит)
  <base>_orig.<ext>   — исходное изображение
  <base>_overlay.png  — маска полупрозрачно поверх оригинала
Панорамы склеиваются в целое полотно (по cropBox, без нахлёста).
"""
import os, sys, io, json, zipfile
import numpy as np
from PIL import Image
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None

# Палитра исходной маски (зеркало segment.py): силикат, сульфиды, магнетит, тальк
PALETTE = [(60, 60, 60), (240, 220, 130), (120, 200, 255), (0, 0, 0)]
# Цвета competition-маски
C_NORMAL = (0, 200, 0); C_THIN = (235, 30, 30); C_TALC = (40, 90, 235); C_BG = (0, 0, 0)
DEFAULT = {"minArea": 400, "minThickness": 3.0, "opacity": 0.55}
STRUCT = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]])


def nearest_class(rgb):
    """HxWx3 → класс на пиксель: 0 фон(силикат/магнетит), 1 тальк, 2 сульфид."""
    r = rgb[..., 0].astype(np.int32); g = rgb[..., 1].astype(np.int32); b = rgb[..., 2].astype(np.int32)
    best = idx = None
    for i, (pr, pg, pb) in enumerate(PALETTE):
        d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
        if best is None:
            best = d; idx = np.zeros(rgb.shape[:2], np.uint8)
        else:
            m = d < best; best = np.where(m, d, best); idx = np.where(m, i, idx).astype(np.uint8)
    cls = np.zeros(rgb.shape[:2], np.uint8)
    cls[idx == 3] = 1    # тальк
    cls[idx == 1] = 2    # сульфиды
    return cls


def competition_mask(internal_rgb, params):
    """Исходная маска (RGB) → competition-маска (RGB) по параметрам классификации."""
    cls = nearest_class(internal_rgb)
    out = np.zeros(internal_rgb.shape, np.uint8)
    out[cls == 0] = C_BG
    out[cls == 1] = C_TALC
    sulf = cls == 2
    lab, n = ndimage.label(sulf, structure=STRUCT)
    if n > 0:
        area = np.bincount(lab.ravel(), minlength=n + 1)
        # периметр: сульфидный пиксель с не-сульфидным 4-соседом или на краю
        s = sulf
        border = np.zeros_like(s)
        border[:-1, :] |= s[:-1, :] & ~s[1:, :]; border[1:, :] |= s[1:, :] & ~s[:-1, :]
        border[:, :-1] |= s[:, :-1] & ~s[:, 1:]; border[:, 1:] |= s[:, 1:] & ~s[:, :-1]
        border[0, :] |= s[0, :]; border[-1, :] |= s[-1, :]; border[:, 0] |= s[:, 0]; border[:, -1] |= s[:, -1]
        perim = np.maximum(np.bincount(lab[border], minlength=n + 1), 1)
        thin = (area < params["minArea"]) | (area / perim < params["minThickness"])
        thin[0] = False
        thin_px = thin[lab]
        out[s & thin_px] = C_THIN
        out[s & ~thin_px] = C_NORMAL
    return out


def blend(orig_rgb, mask_rgb, opacity):
    o = np.clip(opacity, 0.0, 1.0)
    return (orig_rgb.astype(np.float32) * (1 - o) + mask_rgb.astype(np.float32) * o).astype(np.uint8)


def load_rgb(path):
    return np.array(Image.open(path).convert("RGB"))


def single_internal(pdir, img):
    return load_rgb(os.path.join(pdir, "masks", f"single_{img['id']}.png"))


def stitch_panorama_mask(pdir, img):
    """Собрать competition-полотно панорамы: каждый тайл классифицируем по его
    параметрам, красим, обрезаем до cropBox и кладём на место (бесшовно)."""
    W, H = img["width"], img["height"]
    canvas = np.zeros((H, W, 3), np.uint8)
    for t in img.get("tiles", []):
        tp = os.path.join(pdir, "masks", f"tile_{t['id']}.png")
        if not os.path.exists(tp):
            continue
        tile_rgb = load_rgb(tp)
        params = t.get("previewParams") or DEFAULT
        col = competition_mask(tile_rgb, params)
        fb, cb = t["fullBox"], t["cropBox"]
        ox, oy = cb["x"] - fb["x"], cb["y"] - fb["y"]
        crop = col[oy:oy + cb["h"], ox:ox + cb["w"]]
        canvas[cb["y"]:cb["y"] + cb["h"], cb["x"]:cb["x"] + cb["w"]] = crop
    return canvas


def main(pdir, out_zip):
    opts = json.loads(os.environ.get("EXPORT_OPTS", "{}"))
    want_mask = opts.get("mask", True)
    want_orig = opts.get("orig", False)
    want_overlay = opts.get("overlay", False)

    project = json.load(open(os.path.join(pdir, "project.json"), encoding="utf-8"))
    zf = zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED)
    count = 0

    for img in project.get("images", []):
        base = os.path.splitext(img["name"])[0]
        try:
            if img["kind"] == "panorama":
                if not img.get("tiles"):
                    continue
                mask_rgb = stitch_panorama_mask(pdir, img)
                orig_path = os.path.join(pdir, "orig", img["origFile"])
                opacity = (img.get("previewParams") or DEFAULT)["opacity"]
            else:
                if img.get("status") != "done":
                    continue
                internal = single_internal(pdir, img)
                params = img.get("previewParams") or DEFAULT
                mask_rgb = competition_mask(internal, params)
                orig_path = os.path.join(pdir, "orig", img["origFile"])
                opacity = params["opacity"]

            def put(name, arr, fmt="PNG"):
                buf = io.BytesIO()
                Image.fromarray(arr).save(buf, format=fmt, quality=92)
                zf.writestr(name, buf.getvalue())

            if want_mask:
                put(f"{base}_mask.png", mask_rgb)
            if (want_orig or want_overlay) and os.path.exists(orig_path):
                orig_rgb = load_rgb(orig_path)
                if orig_rgb.shape[:2] != mask_rgb.shape[:2]:
                    orig_rgb = np.array(Image.fromarray(orig_rgb).resize((mask_rgb.shape[1], mask_rgb.shape[0])))
                if want_orig:
                    ext = os.path.splitext(img["origFile"])[1].lower()
                    if ext in (".jpg", ".jpeg"):
                        put(f"{base}_orig.jpg", orig_rgb, "JPEG")
                    else:
                        put(f"{base}_orig.png", orig_rgb)
                if want_overlay:
                    put(f"{base}_overlay.png", blend(orig_rgb, mask_rgb, opacity))
            count += 1
        except Exception as e:
            print(f"ERR {img.get('name')}: {e!r}", file=sys.stderr)

    zf.close()
    print(json.dumps({"images": count}))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: export.py <project_dir> <out_zip>", file=sys.stderr); sys.exit(2)
    main(sys.argv[1], sys.argv[2])
