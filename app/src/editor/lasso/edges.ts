/** Multichannel (colour) Sobel edge magnitude, normalized to [0..1].
 *
 *  Unlike a plain grayscale gradient, this uses the Di Zenzo structure tensor
 *  over the R/G/B channels, so a boundary between two colours of *similar
 *  brightness* (e.g. green vs gold) is detected just as strongly as a black/
 *  white one — the magnetic lasso then snaps to colour edges, not only
 *  luminance edges.
 *
 *  `targetW`/`targetH` override the working resolution — pass the mask size so
 *  the gradient map lines up with the mask/edge-graph coordinate system even
 *  when the original image has a different resolution (same aspect ratio). */
export function computeEdgeMap(
  img: HTMLImageElement, targetW?: number, targetH?: number,
): { grad: Float32Array; rgb: Uint8Array; w: number; h: number } {
  const w = targetW ?? img.naturalWidth;
  const h = targetH ?? img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;     // smooth stretch when orig ≠ mask size
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  // Packed RGB (3 bytes/px) for the colour-based magic wand, and per-channel
  // float planes for the Sobel passes below.
  const rgb = new Uint8Array(n * 3);
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
    R[i] = r; G[i] = g; B[i] = b;
  }

  const grad = new Float32Array(n);
  let maxGrad = 1e-6;
  // Sobel gx/gy for one channel plane at index i (interior pixels only).
  const sobel = (P: Float32Array, i: number): [number, number] => {
    const gx =
      -P[i - w - 1] + P[i - w + 1]
      - 2 * P[i - 1] + 2 * P[i + 1]
      - P[i + w - 1] + P[i + w + 1];
    const gy =
      -P[i - w - 1] - 2 * P[i - w] - P[i - w + 1]
      + P[i + w - 1] + 2 * P[i + w] + P[i + w + 1];
    return [gx, gy];
  };
  for (let y = 1; y < h - 1; y++) {
    const off = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = off + x;
      const [rx, ry] = sobel(R, i);
      const [gx, gy] = sobel(G, i);
      const [bx, by] = sobel(B, i);
      // Di Zenzo structure tensor; edge strength = sqrt of its largest
      // eigenvalue (the max directional colour change at this pixel).
      const gxx = rx * rx + gx * gx + bx * bx;
      const gyy = ry * ry + gy * gy + by * by;
      const gxy = rx * ry + gx * gy + bx * by;
      const d = gxx - gyy;
      const lambda = 0.5 * ((gxx + gyy) + Math.sqrt(d * d + 4 * gxy * gxy));
      const mag = Math.sqrt(lambda);
      grad[i] = mag;
      if (mag > maxGrad) maxGrad = mag;
    }
  }
  const inv = 1 / maxGrad;
  for (let i = 0; i < n; i++) grad[i] *= inv;
  return { grad, rgb, w, h };
}
