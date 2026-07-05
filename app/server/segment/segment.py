# -*- coding: utf-8 -*-
"""
Сегментация одного изображения через fal (Qwen-Image-Edit-2511 + наша LoRA).

Пайплайн:  вход → ресайз 1024×768 → загрузка в fal storage → fal(LoRA) →
           сырая маска → постобработка clean_edges (k=число фаз) → snap к палитре
           → ресайз маски обратно в натив (NEAREST) → PNG.

Вызов:     python segment.py <input_image> <output_mask.png>
Читает:    FAL_KEY, LORA_URL из окружения.
Печатает:  в stdout JSON {"phases":[{name,color,fraction},...]} — доли фаз.
"""
import os, sys, io, json
import numpy as np
from PIL import Image
import requests
import fal_client

sys.path.insert(0, os.path.dirname(__file__))
import clean_edges as ce

ENDPOINT = "fal-ai/qwen-image-edit-2511/lora"

# Разрешения, которые поддерживает Qwen (кратны 16). Вход подгоняется к тому,
# чьё соотношение сторон ближе всего к исходному, растяжением (деформация не
# мешает распознаванию фаз; маску возвращаем в натив). Панорамные тайлы 2208×1656
# — это ровно 4:3, поэтому попадают в 1472×1104 чистым уменьшением без деформации.
TARGETS = [
    (1472, 1104),   # 4:3
    (1104, 1472),   # 3:4
    (1584, 1056),   # 3:2
    (1056, 1584),   # 2:3
    (1664, 928),    # 16:9
    (928, 1664),    # 9:16
]


def pick_target(w: int, h: int):
    """Разрешение из TARGETS, чьё соотношение ближе всего к w:h."""
    ar = w / h if h else 1.0
    return min(TARGETS, key=lambda t: abs((t[0] / t[1]) - ar))

# --- Полная палитра фаз. Силикат присутствует ВСЕГДА; остальные модель раскрашивает
#     только если видит на снимке. Постобработка сама определяет, сколько фаз реально
#     пришло (по доле пикселей каждого цвета), и клинит только по активным. ---
PHASES = [
    ("Силикат",  (60,  60,  60),  True),    # матрица — всегда
    ("Сульфиды", (240, 220, 130), False),
    ("Магнетит", (120, 200, 255), False),
    ("Тальк",    (0,   0,   0),   False),
]
FULL_PAL = np.array([c for _, c, _ in PHASES], dtype=np.uint8)
MIN_FRAC = 0.015   # доля пикселей, ниже которой опциональная фаза считается отсутствующей

PROMPT = (
    "Построй цветовую маску минеральных фаз аншлифа: замени каждую присутствующую "
    "фазу плоским сплошным цветом, без градиентов и текстур, с резкими границами "
    "между зонами.\n\n"
    "Силикатная матрица присутствует всегда; остальные фазы могут быть или "
    "отсутствовать — определи сам, какие есть на снимке, и раскрась только их:\n\n"
    "Силикат (матрица, есть всегда) — тёмная гладкая нерудная фаза, заполняет "
    "межзерновое пространство, образует прожилки, трещины, каверны и тёмные поля по "
    "краям. rgb(60, 60, 60).\n\n"
    "Сульфиды — яркие бежево-кремовые до желтоватых и слегка розоватых зёрна, самая "
    "светлая фаза кадра. rgb(240, 220, 130).\n\n"
    "Магнетит — ровные серо-сиреневые пятна, темнее сульфидов и светлее силиката, "
    "форма угловатая или рваная. rgb(120, 200, 255).\n\n"
    "Тальк — тёмно-серая шероховатая «ворсистая» фаза с мелким питтингом и "
    "чешуйчатыми штрихами, образует связные пятна внутри силикатной матрицы. "
    "rgb(0, 0, 0).\n\n"
    "Выдели все прожилки и границы, разбери снимок по фазам подробно, без упрощения."
)


def segment(inp: str, outp: str):
    lora_url = os.environ.get("LORA_URL")
    if not lora_url:
        raise RuntimeError("LORA_URL не задан в окружении")

    src = Image.open(inp).convert("RGB")
    native_w, native_h = src.size

    # Подгоняем к ближайшему поддерживаемому разрешению (панорамный тайл 2208×1656
    # → 1472×1104 без деформации; одиночное — к своему соотношению).
    target = pick_target(native_w, native_h)
    small = src.resize(target, Image.LANCZOS)
    tmp_in = outp + ".in.png"
    small.save(tmp_in)
    try:
        img_url = fal_client.upload_file(tmp_in)
    finally:
        try: os.remove(tmp_in)
        except OSError: pass

    # Пользовательская подсказка (из панели Retry) клеится в конец промпта как есть.
    hint = os.environ.get("SEGMENT_HINT", "").strip()
    prompt = PROMPT + ("\n\n" + hint if hint else "")

    res = fal_client.subscribe(ENDPOINT, arguments={
        "image_urls": [img_url],
        "prompt": prompt,
        "loras": [{"path": lora_url, "scale": 1}],
        "num_inference_steps": 30,
    })
    mask_url = res["images"][0]["url"]
    pred = np.array(
        Image.open(io.BytesIO(requests.get(mask_url, timeout=180).content))
        .convert("RGB").resize(target)
    )

    final_t, active = postprocess(pred)              # чистая плоская маска в target-разрешении
    act_pal = FULL_PAL[active]

    # Растягиваем чистую маску до натива ПЛАВНО (бикубик) и заново привязываем к
    # активной палитре: границы получаются в нативном разрешении гладкой кривой, без
    # ступенчатых блоков (nearest их давал), а re-snap убивает антиалиасинг интерполяции.
    up = np.asarray(Image.fromarray(final_t).resize((native_w, native_h), Image.BICUBIC), dtype=np.int32)
    final = act_pal[snap_labels(up, act_pal)].astype(np.uint8)
    Image.fromarray(final).save(outp)

    # Доли только активных фаз (проценты; абсолютные площади — позже по µm/pixel).
    px = final.reshape(-1, 3)
    phases = []
    for i, col in zip(active, act_pal):
        frac = float(np.all(px == col, axis=1).mean())
        phases.append({"name": PHASES[i][0], "color": [int(v) for v in col], "fraction": frac})
    print(json.dumps({"phases": phases}, ensure_ascii=False))


def snap_labels(img, pal):
    """Индекс ближайшего цвета палитры на пиксель (память-лёгкий цикл по палитре)."""
    best = lab = None
    for j in range(len(pal)):
        dj = ((img - pal[j].astype(np.int32)) ** 2).sum(2)
        if best is None:
            best, lab = dj, np.zeros(dj.shape, np.int32)
        else:
            m = dj < best
            best = np.where(m, dj, best)
            lab = np.where(m, j, lab)
    return lab


def postprocess(pred):
    """Сырой выход fal (HxWx3 uint8) → (чистая маска HxWx3, список индексов активных фаз).

    Определяет, сколько фаз реально пришло: каждый пиксель относим к ближайшему цвету
    палитры, фаза активна если её доля >= MIN_FRAC (силикат — всегда). Затем прямое
    назначение к активной палитре + чистка шумных компонент (clean_edges)."""
    flat = pred.reshape(-1, 3).astype(np.int32)
    d_all = ((flat[:, None, :] - FULL_PAL[None, :, :].astype(np.int32)) ** 2).sum(2)  # N×P
    fracs0 = np.bincount(d_all.argmin(1), minlength=len(PHASES)) / len(flat)
    active = [i for i, (_, _, always) in enumerate(PHASES) if always or fracs0[i] >= MIN_FRAC]
    act_pal = FULL_PAL[active]
    k = len(act_pal)

    if k == 1:
        return np.broadcast_to(act_pal[0], pred.shape).astype(np.uint8).copy(), active

    labels = d_all[:, active].argmin(1).reshape(pred.shape[:2]).astype(np.int32)
    centers = act_pal.astype(np.uint8)
    b0, pc, bi, _ = ce.find_bad_components(labels, k)
    bf, _ = ce.promote_contrasted(b0, labels, centers, pc, bi, k)
    nl, _ = ce.fill_bad(labels, centers, bf)
    return act_pal[nl].astype(np.uint8), active


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: segment.py <input> <output.png>", file=sys.stderr)
        sys.exit(2)
    segment(sys.argv[1], sys.argv[2])
