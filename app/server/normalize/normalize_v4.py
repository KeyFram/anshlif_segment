# -*- coding: utf-8 -*-
"""
Нормализация аншлифов (Норникель) к единому виду — метод v4.

ЗАЧЕМ
  Кадры сняты разными мыльницами без контроля параметров: гуляют цветовой каст
  (зелень/синева) и экспозиция (темень/засвет). Тест на хакатоне может содержать
  такие же «кривые» кадры — этот скрипт приводит любой из них к единому виду.

КАК (две независимые стадии; обе устойчивы к тому, каких фаз в кадре много)
  1) ЦВЕТ. Совмещаем гистограммы каналов: R и B подгоняем к G аффинно
     (только растяжение+сдвиг, форму не меняем). Опоры считаем ТОЛЬКО по
     малонасыщенным (серым) пикселям и в 2 итерации, поэтому жёлтый халькопирит
     и розовый пентландит не загрязняют подгонку и сохраняют свой оттенок.
     Так одновременно уходят «зелёные тени» и «фиолетовые света» —
     то, что один общий множитель починить не может.
  2) ЯРКОСТЬ. Чёрную/белую точки по яркости тянем к эталону (067),
     одинаково по всем каналам — цвет при этом не искажается.

ЗАПУСК
  python normalize_v4.py                 # прогон всей базы SRC -> DST (по умолчанию)
  python normalize_v4.py <вход> <выход>  # файл -> файл, или папка -> папка (рекурсивно)

Требуется: numpy, opencv-python.
"""
import os, sys, time, numpy as np, cv2
from concurrent.futures import ProcessPoolExecutor

# ---------- пути по умолчанию (режим "вся база") ----------
SRC = r"C:\projects\nornikel\nornikel_data"
DST = r"C:\projects\nornikel\nornikel_data_norm"
# Эталон яркости: env NORMALIZE_REF, иначе бандл рядом со скриптом (портативно при
# деплое). Если и его нет — ref_tone() падает на вшитый фолбэк REF_BLACK/WHITE.
REF = os.environ.get("NORMALIZE_REF") or os.path.join(os.path.dirname(__file__), "ref_067.jpg")

# ---------- параметры метода ----------
NEUTRAL_P = 45.0         # доля самых малонасыщенных пикселей, считаемых "серыми"
ALO, AHI  = 2.0, 98.0    # перцентили-опоры для аффинного совмещения каналов
ITERS     = 2            # итераций уточнения (каст сам себя не маскирует)
BLACK_P, WHITE_P = 0.3, 99.7   # перцентили чёрной/белой точки по яркости
# эталонные тоновые точки (sRGB, посчитаны с 067) — фолбэк, если REF недоступен:
REF_BLACK, REF_WHITE = 0.0621, 0.7400

# ---------- производительность / память ----------
JPEG_Q        = 95
BIG_BYTES     = 40_000_000    # файлы крупнее -> отдельный "тяжёлый" пул (напр. pans 574 МП)
SMALL_WORKERS = 12
BIG_WORKERS   = 2
IMG_EXT       = (".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff")
cv2.setNumThreads(2)

def load(path):
    b = cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_COLOR)
    if b is None:
        raise IOError("не читается изображение")
    return cv2.cvtColor(b, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0

def lum(x):
    return x[..., 0]*0.299 + x[..., 1]*0.587 + x[..., 2]*0.114

def align_channels(img):            # in-place; G не трогаем
    for _ in range(ITERS):
        chroma = img.max(2) - img.min(2)
        thr = np.percentile(chroma, NEUTRAL_P)
        nm = chroma <= thr
        if nm.sum() < 2000:          # почти нет серых — берём весь кадр
            nm = np.ones(chroma.shape, bool)
        g = img[..., 1][nm]; glo, ghi = np.percentile(g, [ALO, AHI])
        for c in (0, 2):
            cc = img[..., c][nm]; clo, chi = np.percentile(cc, [ALO, AHI])
            s = np.float32((ghi - glo) / max(chi - clo, 1e-6))
            ch = img[..., c]; ch -= np.float32(clo); ch *= s; ch += np.float32(glo)
            np.clip(ch, 0, 1, out=ch)
        del chroma, nm
    return img

def normalize(img, rb, rw):
    align_channels(img)
    y = lum(img)
    b = np.percentile(y, BLACK_P); w = np.percentile(y, WHITE_P); del y
    s = np.float32((rw - rb) / max(w - b, 1e-6))
    img -= np.float32(b); img *= s; img += np.float32(rb)
    np.clip(img, 0, 1, out=img)
    return img

def ref_tone():
    """Тоновые точки эталона: с 067, иначе — вшитый фолбэк."""
    try:
        im = align_channels(load(REF)); y = lum(im)
        return float(np.percentile(y, BLACK_P)), float(np.percentile(y, WHITE_P))
    except Exception as e:
        print(f"(эталон 067 недоступен: {e} -> беру вшитые числа)", flush=True)
        return REF_BLACK, REF_WHITE

def process(args):
    pin, pout, rb, rw = args
    try:
        img = normalize(load(pin), rb, rw)
        img *= 255.0; img += 0.5
        u8 = img.astype(np.uint8); del img
        bgr = cv2.cvtColor(u8, cv2.COLOR_RGB2BGR)
        out = os.path.splitext(pout)[0] + ".jpg"      # результат всегда .jpg
        ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q])
        buf.tofile(out)
        return (pin, None)
    except Exception as e:
        return (pin, repr(e))

def gather(src, dst):
    """Собираем задачи (вход->выход). src может быть файлом или папкой."""
    small, big = [], []
    if os.path.isfile(src):
        pairs = [(src, dst if dst.lower().endswith(IMG_EXT) else
                  os.path.join(dst, os.path.basename(src)))]
    else:
        pairs = []
        for root, _, files in os.walk(src):
            rel = os.path.relpath(root, src)
            for fn in files:
                if not fn.lower().endswith(IMG_EXT): continue
                if fn.startswith("_preview"): continue
                pairs.append((os.path.join(root, fn), os.path.join(dst, rel, fn)))
    for pin, pout in pairs:
        os.makedirs(os.path.dirname(pout) or ".", exist_ok=True)
        (big if os.path.getsize(pin) > BIG_BYTES else small).append((pin, pout))
    return small, big

def run_pool(tasks, rb, rw, workers, label):
    if not tasks: return 0
    t0 = time.time(); done = 0; errs = 0; n = len(tasks)
    args = [(pin, pout, rb, rw) for pin, pout in tasks]
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for pin, err in ex.map(process, args):
            done += 1
            if err: errs += 1; print("ERR", pin, err, flush=True)
            if done % 25 == 0 or done == n:
                dt = time.time() - t0
                print(f"[{label}] {done}/{n}  {dt:.0f}s  {done/max(dt,1e-9):.1f} img/s  errs={errs}", flush=True)
    return errs

def main():
    if len(sys.argv) >= 3:
        src, dst = sys.argv[1], sys.argv[2]
    else:
        src, dst = SRC, DST
        print(f"режим по умолчанию: {src} -> {dst}", flush=True)
    rb, rw = ref_tone(); print("тоновые точки эталона:", round(rb, 4), round(rw, 4), flush=True)
    small, big = gather(src, dst)
    print(f"мелких: {len(small)}  тяжёлых: {len(big)}", flush=True)
    t0 = time.time()
    e = run_pool(small, rb, rw, SMALL_WORKERS, "small")
    e += run_pool(big, rb, rw, BIG_WORKERS, "big")
    print(f"ГОТОВО: {len(small)+len(big)} файлов, ошибок {e}, {time.time()-t0:.0f}s", flush=True)

if __name__ == "__main__":
    main()
