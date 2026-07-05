# Инференс дообученной LoRA (сегментация фаз шлифов) через fal.ai — гайд для интеграции в сайт

## Что это
LoRA поверх **Qwen-Image-Edit-2511**, дообученная превращать RLM-микрофотографию шлифа руды в
**цветовую маску фаз**: на вход фото + текстовый промпт (перечень фаз и каких цветом залить),
на выходе — маска, где каждая минеральная фаза залита своим плоским цветом.

Инференс идёт через **fal.ai** (не нужен свой GPU): endpoint `fal-ai/qwen-image-edit-2511/lora`,
в него подаётся наша LoRA по URL. Один вызов ~5–13 сек.

Пайплайн: `фото → fal (Qwen-Image-Edit-2511 + наша LoRA) → сырая маска → постобработка (clean_edges + snap к палитре) → чистая маска`.

---

## 1. Ключи и артефакты
- **fal API key**: нужен свой (fal.ai → dashboard). В запрос идёт заголовком `Authorization: Key <KEY>`.
- **LoRA-файл**: `step-3000.safetensors` (~472 МБ). Лежит в приватном HF-репо `Vlad183565/nornikel-qwen-ore-seg` (папка `lora/`) и локально у владельца.
  fal требует LoRA по **публичному URL**. Варианты сделать постоянный URL (выбрать один):
  - залить один раз на fal storage: `url = fal_client.upload_file("step-3000.safetensors")` → постоянный `https://…fal.media/…` URL;
  - или сделать HF-репо публичным и брать `https://huggingface.co/Vlad183565/nornikel-qwen-ore-seg/resolve/main/lora/step-3000.safetensors`;
  - или публичный объект в GCS/S3.
- **Постобработка**: файл `clean_edges.py` (в том же HF-репо, папка `scripts/`, и локально у владельца). Обязателен — без него сырой выход шумный.

---

## 2. Вызов fal (Python)
```python
import fal_client, os
os.environ["FAL_KEY"] = "<ВАШ_FAL_KEY>"

res = fal_client.subscribe(
    "fal-ai/qwen-image-edit-2511/lora",
    arguments={
        "image_urls": [ORIG_PUBLIC_URL],   # публичный URL входного фото (загрузить через fal_client.upload_file)
        "prompt": PROMPT,                   # см. §3
        "loras": [{"path": LORA_URL, "scale": 1}],
        "num_inference_steps": 30,          # 30 лучше, чем меньше (на 20 качество падает)
        # "guidance_scale": 4.5,            # деф. 4.5; поднять (6-7) если модель слабо слушает промпт
    },
)
result_url = res["images"][0]["url"]        # PNG с сырой маской
```
Схема входа endpoint: `image_urls: list<str>`, `prompt: str`, `loras: list<{path, scale}>` (до 3),
`num_inference_steps` (деф 28), `guidance_scale` (деф 4.5), `seed`, `image_size`, `acceleration`.
`zero_cond_t` endpoint 2511 применяет сам — передавать не надо.

**Вход**: фото ресайзить до размеров, кратных 16, разумно **1024×768** (4:3) или **768×768** — как училась модель.

---

## 3. Формат промпта (важно!)
Модель обучена на строго структурированном промпте. Шаблон:
```
Цветовая маску фаз микрофотографии. Замени каждую фазу плоским сплошным цветом – без градиентов, без текстур, с резкими границами между зонами. Всего N фаз:

1. <описание фазы 1: цвет/блеск/морфология/где>. Залей <название цвета> rgb(R, G, B).

2. <описание фазы 2>. Залей <название цвета> rgb(R, G, B).
...
N. <описание фазы N>. Залей <название цвета> rgb(R, G, B).
```
Правила:
- `N` = реальное число фаз. Цвета — **различимые** (далеко в RGB), это важно для последующего snap.
- Для **мелких/тёмных фаз** (особенно чёрной) добавляй усиление в конце — это реально поднимает их долю:
  `КРИТИЧЕСКИ ВАЖНО: выдели ВСЕ чёрные точки, трещины и тёмные поля чистым чёрным rgb(0,0,0), не пропусти. Ровно N фаз.`
- Описания фаз можно генерировать через VLM (Claude/Gemini), глядя на фото: цвет, блеск, форма (поля/зёрна/прожилки/точки), где расположено.

---

## 4. Постобработка (обязательна)
Сырой выход fal — «почти маска», но с текстурой/шумом. Приводим к чистым фазам:
```python
import numpy as np, requests, io
from PIL import Image
import clean_edges as ce                    # из репо scripts/

pred = np.array(Image.open(io.BytesIO(requests.get(result_url).content)).convert("RGB").resize((1024,768)))
PAL  = np.array([[R1,G1,B1],[R2,G2,B2],...])# те же rgb, что в промпте (палитра фаз)
k    = len(PAL)                             # число фаз

labels, centers = ce.quantize_kmeans(pred, k)          # KMeans к k кластерам
b0, pc, bi, _   = ce.find_bad_components(labels, k)     # найти шумные компоненты
bf, _           = ce.promote_contrasted(b0, labels, centers, pc, bi, k)
nl, _           = ce.fill_bad(labels, centers, bf)      # залить шум
d = ((centers[:,None,:].astype(int) - PAL[None,:,:])**2).sum(2)
final = PAL[d.argmin(1)].astype(np.uint8)[nl]           # привязать центры к палитре
Image.fromarray(final).save("mask.png")                 # чистая маска
```
Нюанс: `k` берётся по числу фаз в промпте. Если модель фазу слила — жёсткий `k` создаёт искусственное
дробление; на будущее можно сделать `k` адаптивным (по фактическому числу цветов). Для snap лучше не
евклид, а perceptual (deltaE, `skimage.color.deltaE_ciede2000`) — точнее на близких оттенках.

---

## 5. Быстрые факты / тюнинг
- Один вызов fal: ~5–13 сек (первый с новой LoRA дольше — merge; далее кэш).
- Качество: ~70% pixel-accuracy на holdout после постобработки; на чётких шлифах 90%+.
- Модель отлично отделяет структуру фаз; точные цвета/чистоту даёт постобработка.
- Если фаза недобирается — усилить её в промпте (см. §3) и/или поднять `guidance_scale`.
- Зависимости: `fal-client`, `pillow`, `numpy`, `requests`, `scikit-learn`, `scikit-image`, `scipy` (последние три — для clean_edges).

Модель и все скрипты (clean_edges.py, генерация промптов, обучение) — в HF-репо `Vlad183565/nornikel-qwen-ore-seg`.
