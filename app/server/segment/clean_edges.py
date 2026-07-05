"""
Edge cleanup for quantized masks.

Pipeline:
  1. KMeans quantize (k clusters).
  2. For each connected component (4-conn) of each class:
       - find boundary pixels (at least one 4-neighbor of a different class).
       - for each boundary pixel, count rays (L/R/U/D) of length >= 2 inside
         its own component.
       - pixel is "bad" if it has < 2 such rays.
       - component is "bad" if < 70% of its boundary pixels are good
         (equivalently: > 30% of boundary pixels are bad).
  3. Build a single mask of ALL pixels in bad components.
  4. Fill them simultaneously: each bad pixel takes the label of the nearest
     GOOD pixel (one distance_transform_edt call — bad regions cannot
     contaminate each other).

Outputs (next to input):
  <stem>_quantized.png   raw KMeans result
  <stem>_badmask.png     red overlay of bad-component pixels on quantized
  <stem>_cleaned.png     after fill
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, label as cc_label
from skimage import color
from sklearn.cluster import KMeans


def quantize_kmeans(rgb, k, seed=0):
    h, w, _ = rgb.shape
    pixels = rgb.reshape(-1, 3).astype(np.float64)
    km = KMeans(n_clusters=k, n_init=10, random_state=seed).fit(pixels)
    labels = km.predict(pixels).reshape(h, w).astype(np.int32)
    centers = np.round(km.cluster_centers_).astype(np.uint8)
    return labels, centers


def ray_lengths(labels):
    """For each pixel, length of the same-label run that follows it in each
    of the 4 directions (NOT counting the pixel itself)."""
    h, w = labels.shape
    L = np.zeros((h, w), dtype=np.int32)
    R = np.zeros((h, w), dtype=np.int32)
    U = np.zeros((h, w), dtype=np.int32)
    D = np.zeros((h, w), dtype=np.int32)

    same_h = labels[:, :-1] == labels[:, 1:]
    for j in range(w - 2, -1, -1):
        R[:, j] = np.where(same_h[:, j], R[:, j + 1] + 1, 0)
    for j in range(1, w):
        L[:, j] = np.where(same_h[:, j - 1], L[:, j - 1] + 1, 0)

    same_v = labels[:-1, :] == labels[1:, :]
    for i in range(h - 2, -1, -1):
        D[i, :] = np.where(same_v[i, :], D[i + 1, :] + 1, 0)
    for i in range(1, h):
        U[i, :] = np.where(same_v[i - 1, :], U[i - 1, :] + 1, 0)

    return L, R, U, D


def boundary_mask(labels):
    """True where the pixel has at least one 4-neighbor of a different class
    (image edge also counts as boundary)."""
    h, w = labels.shape
    b = np.zeros((h, w), dtype=bool)
    b[:, 0] = True; b[:, -1] = True; b[0, :] = True; b[-1, :] = True
    b[:, 1:]  |= labels[:, 1:]  != labels[:, :-1]
    b[:, :-1] |= labels[:, :-1] != labels[:, 1:]
    b[1:, :]  |= labels[1:, :]  != labels[:-1, :]
    b[:-1, :] |= labels[:-1, :] != labels[1:, :]
    return b


def find_bad_components(labels, n_classes, min_long=2, good_thresh=0.7):
    """Returns:
      bad_mask         — bool mask of all pixels in bad components.
      per_class_cc     — {k: (cc_array, n_components)} for later lookup.
      bad_ids_per_class — {k: array of cc ids that are bad}.
      stats            — (n_bad, n_total) for logging.
    """
    L, R, U, D = ray_lengths(labels)
    long_count = ((L >= min_long).astype(np.int8)
                  + (R >= min_long).astype(np.int8)
                  + (U >= min_long).astype(np.int8)
                  + (D >= min_long).astype(np.int8))
    is_bad_pixel = long_count < 2

    boundary = boundary_mask(labels)
    structure = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]])

    bad_mask = np.zeros(labels.shape, dtype=bool)
    per_class_cc = {}
    bad_ids_per_class = {}
    n_bad_comps = 0
    n_total_comps = 0

    for k in range(n_classes):
        class_mask = labels == k
        if not class_mask.any():
            per_class_cc[k] = (None, 0)
            bad_ids_per_class[k] = np.array([], dtype=np.int64)
            continue
        cc, n = cc_label(class_mask, structure=structure)
        per_class_cc[k] = (cc, n)
        n_total_comps += n
        if n == 0:
            bad_ids_per_class[k] = np.array([], dtype=np.int64)
            continue
        cc_flat = cc.ravel()
        comp_boundary = (class_mask & boundary).ravel()
        comp_bad_bnd = (comp_boundary & is_bad_pixel.ravel())
        n_bnd = np.bincount(cc_flat, weights=comp_boundary, minlength=n + 1)
        n_bad = np.bincount(cc_flat, weights=comp_bad_bnd, minlength=n + 1)
        with np.errstate(divide="ignore", invalid="ignore"):
            good_frac = np.where(n_bnd > 0, (n_bnd - n_bad) / n_bnd, 1.0)
        bad_ids = np.where(good_frac[1:] < good_thresh)[0] + 1
        bad_ids_per_class[k] = bad_ids
        if len(bad_ids) == 0:
            continue
        n_bad_comps += len(bad_ids)
        bad_mask |= np.isin(cc, bad_ids)

    return bad_mask, per_class_cc, bad_ids_per_class, (n_bad_comps, n_total_comps)


def deltaE_table(centers):
    """Pairwise ΔE 2000 between all class centers — small (n_classes x n_classes)."""
    n = len(centers)
    lab = color.rgb2lab(
        centers.astype(np.float64).reshape(n, 1, 3) / 255.0
    ).reshape(n, 3)
    table = np.zeros((n, n))
    for i in range(n):
        for j in range(i + 1, n):
            d = color.deltaE_ciede2000(
                lab[i].reshape(1, 1, 3), lab[j].reshape(1, 1, 3)
            )[0, 0]
            table[i, j] = table[j, i] = d
    return table


def complex_neighbors(bad_mask, labels, n_classes):
    """For each connected complex of bad pixels (4-conn, ignoring class),
    return the set of neighboring GOOD-pixel classes.
    Returns: complex_id array (h,w), list[set] of length n_complexes+1."""
    structure = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]])
    complex_id, n_cx = cc_label(bad_mask, structure=structure)

    # Encode (complex_id, neighbor_class) pairs from all 4 directions where
    # a bad pixel touches a good pixel.
    encs = []

    def collect(c_slice, l_slice, m):
        c = c_slice[m].astype(np.int64)
        l = l_slice[m].astype(np.int64)
        encs.append(c * n_classes + l)

    g = ~bad_mask
    # bad at col j, good at col j-1 → neighbor is to the left
    m = bad_mask[:, 1:] & g[:, :-1]
    collect(complex_id[:, 1:], labels[:, :-1], m)
    # bad at col j, good at col j+1 → neighbor to the right
    m = bad_mask[:, :-1] & g[:, 1:]
    collect(complex_id[:, :-1], labels[:, 1:], m)
    # bad at row i, good at row i-1 → neighbor above
    m = bad_mask[1:, :] & g[:-1, :]
    collect(complex_id[1:, :], labels[:-1, :], m)
    # bad at row i, good at row i+1 → neighbor below
    m = bad_mask[:-1, :] & g[1:, :]
    collect(complex_id[:-1, :], labels[1:, :], m)

    nb = [set() for _ in range(n_cx + 1)]
    if encs:
        unique_enc = np.unique(np.concatenate(encs))
        cids = unique_enc // n_classes
        clss = unique_enc % n_classes
        for ci, cl in zip(cids.tolist(), clss.tolist()):
            nb[ci].add(int(cl))
    return complex_id, nb, n_cx


def promote_contrasted(bad_mask, labels, centers, per_class_cc,
                       bad_ids_per_class, n_classes,
                       dE_thresh=30.0, min_area=6):
    """For each bad component, if its color is contrasted enough
    (ΔE2000 > dE_thresh) from EVERY good class neighboring its complex
    AND its area is >= min_area, promote it back to "good"."""
    complex_id, nb, n_cx = complex_neighbors(bad_mask, labels, n_classes)
    if n_cx == 0:
        return bad_mask, 0

    de_tab = deltaE_table(centers)
    new_bad = np.zeros_like(bad_mask)
    n_promoted = 0

    for k in range(n_classes):
        cc, _ = per_class_cc[k]
        if cc is None:
            continue
        for cid in bad_ids_per_class[k]:
            comp_mask = (cc == cid)
            if comp_mask.sum() < min_area:
                new_bad |= comp_mask
                continue
            cx = int(complex_id[comp_mask][0])
            nb_classes = nb[cx]
            if not nb_classes:
                new_bad |= comp_mask
                continue
            min_de = min(de_tab[k, g] for g in nb_classes)
            if min_de > dE_thresh:
                n_promoted += 1
            else:
                new_bad |= comp_mask
    return new_bad, n_promoted


def fill_bad(labels, centers, bad_mask):
    good = ~bad_mask
    # If everything is bad something is very wrong — bail.
    if not good.any():
        raise RuntimeError("No good pixels — cannot fill.")
    _, idx = distance_transform_edt(~good, return_indices=True)
    new_labels = labels[tuple(idx)]
    return new_labels, centers[new_labels]


def main(src, k=5, min_long=2, good_thresh=0.7, dE_thresh=30.0, min_area=6):
    src = Path(src)
    rgb = np.array(Image.open(src).convert("RGB"))
    labels, centers = quantize_kmeans(rgb, k)
    quantized = centers[labels]

    bad_initial, per_class_cc, bad_ids_per_class, (n_bad, n_total) = \
        find_bad_components(labels, n_classes=k, min_long=min_long,
                            good_thresh=good_thresh)
    print(f"Components: {n_bad} bad / {n_total} total")
    print(f"Initial bad pixels: {bad_initial.sum()} "
          f"({100 * bad_initial.mean():.2f}%)")

    bad_final, n_promoted = promote_contrasted(
        bad_initial, labels, centers, per_class_cc,
        bad_ids_per_class, n_classes=k,
        dE_thresh=dE_thresh, min_area=min_area
    )
    promoted = bad_initial & ~bad_final
    print(f"Promoted (saved by contrast > {dE_thresh}): {n_promoted} components, "
          f"{promoted.sum()} pixels")
    print(f"Final bad pixels: {bad_final.sum()} "
          f"({100 * bad_final.mean():.2f}%)")

    new_labels, cleaned = fill_bad(labels, centers, bad_final)

    stem = src.with_suffix("")
    Image.fromarray(quantized).save(stem.parent / f"{stem.name}_quantized.png")
    overlay = quantized.copy()
    overlay[bad_final] = [255, 0, 0]    # стало плохим окончательно
    overlay[promoted] = [0, 100, 255]   # было плохим, спасено контрастом
    Image.fromarray(overlay).save(stem.parent / f"{stem.name}_badmask.png")
    Image.fromarray(cleaned).save(stem.parent / f"{stem.name}_cleaned.png")
    print(f"Saved: {stem.name}_quantized.png, _badmask.png, _cleaned.png")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "mask.png"
    k = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    main(src, k=k)
