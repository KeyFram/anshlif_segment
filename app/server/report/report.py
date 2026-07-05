# -*- coding: utf-8 -*-
"""
Отчёт по проекту (HTML, print-ready A4). Агрегирует по всем обработанным
изображениям реальные метрики; ничего выдуманного (без «уверенности» и т.п.).

Вызов:  python report.py <project_dir>   → HTML в stdout
"""
import os, sys, io, json, datetime
import numpy as np
from PIL import Image
from scipy import ndimage
from jinja2 import Template

Image.MAX_IMAGE_PIXELS = None
PALETTE = [(60, 60, 60), (240, 220, 130), (120, 200, 255), (0, 0, 0)]  # силикат, сульфиды, магнетит, тальк
STRUCT = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]])
DEFAULT = {"minArea": 400, "minThickness": 3.0, "opacity": 0.55}
TALC_THRESHOLD = 10.0   # % талька для класса «оталькованная»


def nearest_idx(rgb):
    r = rgb[..., 0].astype(np.int32); g = rgb[..., 1].astype(np.int32); b = rgb[..., 2].astype(np.int32)
    best = idx = None
    for i, (pr, pg, pb) in enumerate(PALETTE):
        d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
        if best is None:
            best = d; idx = np.zeros(rgb.shape[:2], np.uint8)
        else:
            m = d < best; best = np.where(m, d, best); idx = np.where(m, i, idx).astype(np.uint8)
    return idx


def image_stats(internal_rgb, params):
    """→ counts[4] (силикат,сульфиды,магнетит,тальк), normal_px, thin_px, sizes(list)."""
    idx = nearest_idx(internal_rgb)
    counts = np.bincount(idx.ravel(), minlength=4).astype(np.int64)
    sulf = idx == 1
    normal_px = thin_px = 0; sizes = []
    lab, n = ndimage.label(sulf, structure=STRUCT)
    if n > 0:
        area = np.bincount(lab.ravel(), minlength=n + 1)
        s = sulf; border = np.zeros_like(s)
        border[:-1, :] |= s[:-1, :] & ~s[1:, :]; border[1:, :] |= s[1:, :] & ~s[:-1, :]
        border[:, :-1] |= s[:, :-1] & ~s[:, 1:]; border[:, 1:] |= s[:, 1:] & ~s[:, :-1]
        border[0, :] |= s[0, :]; border[-1, :] |= s[-1, :]; border[:, 0] |= s[:, 0]; border[:, -1] |= s[:, -1]
        perim = np.maximum(np.bincount(lab[border], minlength=n + 1), 1)
        thin = (area < params["minArea"]) | (area / perim < params["minThickness"]); thin[0] = False
        thin_map = thin[lab]
        thin_px = int((s & thin_map).sum()); normal_px = int((s & ~thin_map).sum())
        sizes = area[1:].tolist()
    return counts, normal_px, thin_px, sizes


def load_rgb(p):
    return np.array(Image.open(p).convert("RGB"))


def collect(pdir, project):
    agg = np.zeros(4, np.int64)   # силикат, сульфиды, магнетит, тальк
    normal_px = thin_px = 0
    sizes_norm = []               # размеры включений как доля площади кадра
    per_image = []
    n_single = n_pano = 0
    deposits = set()

    for img in project.get("images", []):
        dep = (img.get("meta") or {}).get("deposit", "").strip()
        if dep:
            deposits.add(dep)
        c = np.zeros(4, np.int64); npx = tpx = 0; szs = []; area_total = 0
        try:
            if img["kind"] == "panorama":
                if not img.get("tiles"):
                    continue
                n_pano += 1
                for t in img["tiles"]:
                    tp = os.path.join(pdir, "masks", f"tile_{t['id']}.png")
                    if not os.path.exists(tp):
                        continue
                    m = load_rgb(tp)
                    cb, fb = t["cropBox"], t["fullBox"]
                    ox, oy = cb["x"] - fb["x"], cb["y"] - fb["y"]
                    crop = m[oy:oy + cb["h"], ox:ox + cb["w"]]
                    cc, nn, tt, ss = image_stats(crop, t.get("previewParams") or DEFAULT)
                    c += cc; npx += nn; tpx += tt
                    a = crop.shape[0] * crop.shape[1]; area_total += a
                    szs += [s / a for s in ss]
            else:
                if img.get("status") != "done":
                    continue
                n_single += 1
                mp = os.path.join(pdir, "masks", f"single_{img['id']}.png")
                if not os.path.exists(mp):
                    continue
                m = load_rgb(mp)
                cc, nn, tt, ss = image_stats(m, img.get("previewParams") or DEFAULT)
                c += cc; npx += nn; tpx += tt
                a = m.shape[0] * m.shape[1]; area_total += a
                szs += [s / a for s in ss]
        except Exception as e:
            print(f"<!-- ERR {img.get('name')}: {e!r} -->", file=sys.stderr)
            continue

        agg += c; normal_px += npx; thin_px += tpx; sizes_norm += szs
        tot = int(c.sum()) or 1
        per_image.append({
            "name": img["name"], "kind": img["kind"],
            "sulf": 100 * c[1] / tot, "talc": 100 * c[3] / tot,
            "incl": len(szs),
        })

    return {
        "agg": agg, "normal_px": normal_px, "thin_px": thin_px,
        "sizes": sizes_norm, "per_image": per_image,
        "n_single": n_single, "n_pano": n_pano, "deposits": sorted(deposits),
    }


def build_context(project, st):
    tot = int(st["agg"].sum()) or 1
    silic, sulf, magn, talc = (100 * st["agg"] / tot)
    sulf_px = int(st["agg"][1]) or 1
    thin = 100 * st["thin_px"] / sulf_px if (st["thin_px"] + st["normal_px"]) else 0
    normal = 100 - thin if (st["thin_px"] + st["normal_px"]) else 0

    # класс руды (экспертное правило)
    if talc > TALC_THRESHOLD:
        verdict = "Оталькованная руда"; vclass = "talc"
        vsub = f"Доля талька {talc:.1f}% превышает порог {TALC_THRESHOLD:.0f}% — руда склонна к оталькованию."
    elif thin > normal:
        verdict = "Труднообогатимая руда"; vclass = "thin"
        vsub = "В структуре сульфидов преобладают тонкие срастания — повышенные потери при обогащении."
    else:
        verdict = "Рядовая руда"; vclass = "common"
        vsub = "Сульфиды представлены преимущественно обычными (крупными) срастаниями."

    # донат: 4 сегмента (offset по кругу 100)
    segs, off = [], 25.0
    for val, var in [(silic, "silic"), (magn, "magn"), (sulf, "thin"), (talc, "talc")]:
        segs.append({"len": round(val, 2), "gap": round(100 - val, 2), "off": round(off, 2), "var": var})
        off -= val

    # гистограмма размеров: 7 логарифмических бинов по доле площади кадра
    edges = [0, 1e-5, 3e-5, 1e-4, 3e-4, 1e-3, 3e-3, 1.0]
    hist = [0] * (len(edges) - 1)
    for s in st["sizes"]:
        for i in range(len(edges) - 1):
            if s < edges[i + 1]:
                hist[i] += 1; break
    hmax = max(hist) or 1
    bars = [{"h": round(48 * v / hmax + 2, 1), "y": round(60 - (48 * v / hmax + 2), 1)} for v in hist]

    return {
        "project": project.get("name", "Проект"),
        "date": datetime.datetime.now().strftime("%d.%m.%Y, %H:%M"),
        "n_images": st["n_single"] + st["n_pano"], "n_single": st["n_single"], "n_pano": st["n_pano"],
        "deposits": ", ".join(st["deposits"]) if st["deposits"] else "не указано",
        "verdict": verdict, "vclass": vclass, "vsub": vsub,
        "sulf": round(sulf, 1), "talc": round(talc, 1), "silic": round(silic, 1), "magn": round(magn, 1),
        "thin": round(thin), "normal": round(normal),
        "incl": len(st["sizes"]),
        "segs": segs, "bars": bars,
        "images": st["per_image"],
        "talc_thr": int(TALC_THRESHOLD),
    }


TEMPLATE = Template(r"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Отчёт · {{project}}</title>
<style>
:root{--violet:#5B2FE0;--violet-2:#7B4DFF;--mint:#3DE0B0;--ink:#1B1C33;--ink-2:#565A7A;--line:#E6E8F0;--bg-card:#FFF;--page:#F4F6FA;
--c-common:#22B573;--c-thin:#E8465B;--c-talc:#3B82F6;--c-magn:#3A3E55;--c-silic:#C7CEDB}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--page);font-family:'Segoe UI',Inter,Arial,sans-serif;color:var(--ink);-webkit-print-color-adjust:exact;print-color-adjust:exact}
@page{size:A4 portrait;margin:0}
.sheet{width:210mm;min-height:297mm;margin:0 auto;padding:11mm 12mm 9mm;position:relative;overflow:hidden}
.sheet::before{content:"";position:absolute;top:-90mm;right:-70mm;width:180mm;height:180mm;background:radial-gradient(circle,rgba(61,224,176,.5),rgba(61,224,176,0) 62%);z-index:0}
.sheet::after{content:"";position:absolute;bottom:-70mm;left:-60mm;width:140mm;height:140mm;background:radial-gradient(circle,rgba(91,47,224,.14),rgba(91,47,224,0) 65%);z-index:0}
.layer{position:relative;z-index:1}
header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6mm}
.brand{display:flex;align-items:center;gap:9px}.logo{width:34px;height:34px}
.brand .name{font-weight:800;letter-spacing:.5px;font-size:15px}.brand .sub{font-size:9px;color:var(--ink-2);letter-spacing:1.5px;text-transform:uppercase;margin-top:1px}
.doc-meta{text-align:right;font-size:9.5px;color:var(--ink-2);line-height:1.7}.doc-meta b{color:var(--ink)}
h1.title{font-size:20px;font-weight:800;margin-bottom:2px}
.title-line{width:46px;height:4px;border-radius:3px;background:linear-gradient(90deg,var(--mint),var(--violet));margin-bottom:6mm}
.hero{display:flex;align-items:center;gap:16px;padding:14px 18px;border-radius:16px;background:linear-gradient(120deg,var(--violet),var(--violet-2));color:#fff;margin-bottom:6mm;box-shadow:0 8px 22px rgba(91,47,224,.22)}
.hero .verdict-label{font-size:9px;letter-spacing:2px;text-transform:uppercase;opacity:.8}
.hero .verdict{font-size:23px;font-weight:800;line-height:1.05;margin-top:2px}
.hero .verdict-sub{font-size:10.5px;opacity:.92;margin-top:5px;max-width:120mm}
.hero .side{margin-left:auto;text-align:center;flex:none}.hero .side .n{font-size:30px;font-weight:800;line-height:1}
.hero .side .l{font-size:8.5px;letter-spacing:1.2px;text-transform:uppercase;opacity:.85;margin-top:3px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-bottom:6mm}
.kpi{background:var(--bg-card);border:1px solid var(--line);border-radius:12px;padding:11px 12px}
.kpi .k-lab{font-size:8.5px;color:var(--ink-2);text-transform:uppercase;letter-spacing:.6px;line-height:1.3}
.kpi .k-val{font-size:22px;font-weight:800;margin-top:5px}.kpi .k-val small{font-size:12px;font-weight:700;color:var(--ink-2)}
.kpi .k-bar{height:4px;border-radius:3px;background:var(--line);margin-top:7px;overflow:hidden}.kpi .k-bar>i{display:block;height:100%;border-radius:3px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.card{background:var(--bg-card);border:1px solid var(--line);border-radius:12px;padding:12px 13px}
.card h3{font-size:11px;font-weight:700;margin-bottom:9px;display:flex;align-items:center;gap:6px}
.card h3::before{content:"";width:8px;height:8px;border-radius:2px;background:var(--mint)}
.card.wide{grid-column:1/-1}
.legend{display:flex;flex-wrap:wrap;gap:9px 14px;font-size:9px;color:var(--ink-2)}
.legend .li{display:flex;align-items:center;gap:5px}.legend .sw{width:10px;height:10px;border-radius:3px}.legend b{color:var(--ink);font-weight:600}
.rows{display:flex;flex-direction:column;gap:8px;margin-top:2px}
.row{display:grid;grid-template-columns:78px 1fr 40px;align-items:center;gap:8px;font-size:9.5px}
.row .rl{color:var(--ink-2)}.row .track{height:10px;background:var(--line);border-radius:6px;overflow:hidden}.row .track>i{display:block;height:100%;border-radius:6px}
.row .rv{text-align:right;font-weight:700;font-size:10px}
.flow{display:flex;align-items:stretch;gap:8px}
.node{flex:1;border:1.5px solid var(--line);border-radius:10px;padding:9px 10px;font-size:9px;color:var(--ink-2);position:relative;background:#fff}
.node .q{font-weight:700;color:var(--ink);font-size:9.5px;margin-bottom:3px}
.node.active{border-color:var(--violet);background:rgba(91,47,224,.05)}
.node.result{border-color:var(--c-thin);background:rgba(232,70,91,.06)}
.node .tag{position:absolute;top:-8px;left:10px;font-size:7.5px;background:#fff;padding:0 5px;letter-spacing:.5px}
.arrow{align-self:center;color:var(--violet);font-weight:800;font-size:13px}
.stat-note{font-size:8.5px;color:var(--ink-2);margin-top:8px;line-height:1.5}
.tbl{width:100%;border-collapse:collapse;font-size:9px}
.tbl th{text-align:left;color:var(--ink-2);font-weight:600;padding:3px 6px;border-bottom:1px solid var(--line);text-transform:uppercase;font-size:8px;letter-spacing:.4px}
.tbl td{padding:4px 6px;border-bottom:1px solid var(--line)}.tbl tr:last-child td{border-bottom:none}
.tbl .mono{font-variant-numeric:tabular-nums;text-align:right}
.verdict-box{background:linear-gradient(120deg,rgba(61,224,176,.16),rgba(91,47,224,.10));border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-size:10.5px;line-height:1.55}
.verdict-box b{color:var(--violet)}
footer{display:flex;justify-content:space-between;align-items:center;margin-top:6mm;padding-top:6px;border-top:1px solid var(--line);font-size:8px;color:var(--ink-2)}
.printbar{position:fixed;top:10px;right:10px;z-index:99}
.printbar button{background:var(--violet);color:#fff;border:none;border-radius:8px;padding:9px 16px;font:inherit;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(91,47,224,.3)}
@media print{.printbar{display:none}}
</style></head><body>
<div class="printbar"><button onclick="window.print()">🖶 Сохранить PDF</button></div>
<div class="sheet"><div class="layer">
 <header>
  <div class="brand">
   <svg class="logo" viewBox="0 0 40 40" fill="none"><rect width="40" height="40" rx="9" fill="#1B1C33"/><path d="M12 28V12l16 16V12" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
   <div><div class="name">НОРНИКЕЛЬ</div><div class="sub">AI Science Hack</div></div>
  </div>
  <div class="doc-meta">Проект: <b>{{project}}</b><br>Сформирован: <b>{{date}}</b><br>Месторождение: <b>{{deposits}}</b></div>
 </header>
 <h1 class="title">Отчёт классификации руды по проекту</h1>
 <div class="title-line"></div>

 <div class="hero">
  <div>
   <div class="verdict-label">Класс руды (по проекту)</div>
   <div class="verdict">{{verdict}}</div>
   <div class="verdict-sub">{{vsub}}</div>
  </div>
  <div class="side"><div class="n">{{n_images}}</div><div class="l">изображений</div></div>
 </div>

 <div class="kpis">
  <div class="kpi"><div class="k-lab">Изображений</div><div class="k-val">{{n_images}}</div><div class="k-bar"><i style="width:100%;background:var(--violet)"></i></div>
   <div class="stat-note" style="margin-top:4px">одиночных {{n_single}} · панорам {{n_pano}}</div></div>
  <div class="kpi"><div class="k-lab">Доля сульфидов</div><div class="k-val">{{sulf}}<small>%</small></div><div class="k-bar"><i style="width:{{sulf}}%;background:linear-gradient(90deg,var(--c-common),var(--c-thin))"></i></div></div>
  <div class="kpi"><div class="k-lab">Доля талька</div><div class="k-val">{{talc}}<small>%</small></div><div class="k-bar"><i style="width:{{talc}}%;background:var(--c-talc)"></i></div></div>
  <div class="kpi"><div class="k-lab">Тонкие срастания<br>(от сульфидов)</div><div class="k-val">{{thin}}<small>%</small></div><div class="k-bar"><i style="width:{{thin}}%;background:var(--c-thin)"></i></div></div>
 </div>

 <div class="grid">
  <div class="card">
   <h3>Фазовый состав (по площади)</h3>
   <div style="display:flex;align-items:center;gap:14px">
    <svg width="112" height="112" viewBox="0 0 42 42">
     <circle cx="21" cy="21" r="15.9155" fill="none" stroke="#EEF0F6" stroke-width="7"/>
     {% for s in segs %}<circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--c-{{s.var}})" stroke-width="7" stroke-dasharray="{{s.len}} {{s.gap}}" stroke-dashoffset="{{s.off}}"/>{% endfor %}
     <text x="21" y="20" text-anchor="middle" font-size="6.5" font-weight="800" fill="#1B1C33">100%</text>
     <text x="21" y="26" text-anchor="middle" font-size="3.1" fill="#565A7A">площади</text>
    </svg>
    <div class="legend" style="flex-direction:column;gap:7px">
     <div class="li"><span class="sw" style="background:var(--c-silic)"></span><b>Силикат</b> — {{silic}}%</div>
     <div class="li"><span class="sw" style="background:var(--c-magn)"></span><b>Магнетит</b> — {{magn}}%</div>
     <div class="li"><span class="sw" style="background:var(--c-thin)"></span><b>Сульфиды</b> — {{sulf}}%</div>
     <div class="li"><span class="sw" style="background:var(--c-talc)"></span><b>Тальк</b> — {{talc}}%</div>
    </div>
   </div>
  </div>

  <div class="card">
   <h3>Структура срастаний сульфидов</h3>
   <div class="rows">
    <div class="row"><span class="rl">Обычные</span><span class="track"><i style="width:{{normal}}%;background:var(--c-common)"></i></span><span class="rv">{{normal}}%</span></div>
    <div class="row"><span class="rl">Тонкие</span><span class="track"><i style="width:{{thin}}%;background:var(--c-thin)"></i></span><span class="rv">{{thin}}%</span></div>
   </div>
   <div class="stat-note">Обычные — крупные изолированные сульфиды (маркер рядовой руды). Тонкие — мелкие/ветвистые срастания, существенно замещённые нерудной фазой (маркер труднообогатимой руды). Классификация по площади и толщине (площадь/периметр) — параметры настраиваются в превью на каждый файл.</div>
  </div>

  <div class="card wide">
   <h3>Логика классификации (экспертное правило)</h3>
   <div class="flow">
    <div class="node {{'result' if vclass=='talc' else 'active'}}"><span class="tag">шаг 1</span><div class="q">Доля талька &gt; {{talc_thr}} %?</div>{{talc}} % → <b>{{ 'да' if vclass=='talc' else 'нет' }}</b>.</div>
    <div class="arrow">→</div>
    <div class="node {{'result' if vclass=='thin' else 'active'}}"><span class="tag">шаг 2</span><div class="q">Какие срастания преобладают?</div>Тонкие {{thin}} % {{ '&gt;' if thin>normal else '≤' }} обычные {{normal}} %.</div>
    <div class="arrow">→</div>
    <div class="node result"><span class="tag">итог</span><div class="q">{{verdict}}</div>По агрегату всех {{n_images}} изображений проекта.</div>
   </div>
  </div>

  <div class="card">
   <h3>Сводка по изображениям</h3>
   <table class="tbl"><thead><tr><th>Изображение</th><th>Тип</th><th class="mono">Сульфиды</th><th class="mono">Тальк</th></tr></thead><tbody>
   {% for im in images[:9] %}<tr><td>{{im.name}}</td><td>{{ 'панорама' if im.kind=='panorama' else 'одиночное' }}</td><td class="mono">{{'%.1f'|format(im.sulf)}}%</td><td class="mono">{{'%.1f'|format(im.talc)}}%</td></tr>{% endfor %}
   </tbody></table>
   {% if images|length > 9 %}<div class="stat-note">…и ещё {{images|length - 9}}.</div>{% endif %}
  </div>

  <div class="card">
   <h3>Распределение включений по размеру</h3>
   <svg width="100%" height="72" viewBox="0 0 220 72" preserveAspectRatio="none">
    <line x1="6" y1="60" x2="214" y2="60" stroke="#E6E8F0" stroke-width="1"/>
    {% for b in bars %}<rect x="{{ 12 + loop.index0*28 }}" y="{{b.y}}" width="20" height="{{b.h}}" rx="2" fill="{{ 'var(--violet)' if loop.index0<3 else '#7B4DFF' if loop.index0<5 else '#9E79FF' }}"/>{% endfor %}
   </svg>
   <div class="stat-note">По оси X — размер включения (доля площади кадра, мелкие → крупные), по Y — количество. Всего сульфидных включений: <b>{{incl}}</b>.</div>
  </div>
 </div>

 <div class="verdict-box" style="margin-top:9px">
  <b>Заключение.</b> По агрегату {{n_images}} изображений проекта («{{project}}») руда классифицирована как <b>{{verdict}}</b>. Доля сульфидов — {{sulf}} % площади, талька — {{talc}} % (порог оталькования {{talc_thr}} %). В структуре сульфидов тонкие срастания составляют {{thin}} %, обычные — {{normal}} %.
 </div>

 <div class="legend" style="margin-top:9px;justify-content:center">
  <span style="font-size:8.5px;color:var(--ink-2)">Цвета маски:</span>
  <div class="li"><span class="sw" style="background:var(--c-common)"></span><b>обычные срастания</b></div>
  <div class="li"><span class="sw" style="background:var(--c-thin)"></span><b>тонкие срастания</b></div>
  <div class="li"><span class="sw" style="background:var(--c-talc)"></span><b>тальк</b></div>
  <div class="li"><span class="sw" style="background:var(--c-magn)"></span><b>магнетит</b></div>
  <div class="li"><span class="sw" style="background:var(--c-silic)"></span><b>силикат</b></div>
 </div>

 <footer>
  <span>Норникель · AI Science Hack · Автоматическая классификация руд по OM-изображениям</span>
  <span>пайплайн: Qwen-Image-Edit-2511 + LoRA · пост-обработка clean_edges</span>
 </footer>
</div></div></body></html>""")


def main(pdir):
    project = json.load(open(os.path.join(pdir, "project.json"), encoding="utf-8"))
    st = collect(pdir, project)
    ctx = build_context(project, st)
    sys.stdout.reconfigure(encoding="utf-8")
    print(TEMPLATE.render(**ctx))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: report.py <project_dir>", file=sys.stderr); sys.exit(2)
    main(sys.argv[1])
