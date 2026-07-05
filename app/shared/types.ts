// Shared domain types used by both the React app (src/) and the Express
// server (server/). Kept framework-free so both sides import the same shapes.

export type Domain = "microscopy" | "xrd";

export type ImageKind = "single" | "panorama";

/** Processing lifecycle of an image / tile. In M1 masks are not produced yet,
 *  so everything sits at "new"; "processing"/"done" are wired when fal lands. */
export type ProcStatus = "new" | "processing" | "done" | "error";

export type Box = { x: number; y: number; w: number; h: number };

/** Acquisition parameters — separate fields (prefilled from EXIF where possible,
 *  focal length deliberately omitted since it lies on these shots). */
export type ShootingParams = {
  camera: string;    // Make + Model
  aperture: string;  // f/…
  shutter: string;   // exposure time (1/x s)
  iso: string;
};

/** User-supplied acquisition metadata. `umPerPixel` unlocks absolute areas
 *  (computed later); the rest we simply record per the task's requirements. */
export type ImageMeta = {
  umPerPixel: number | null;
  shooting: ShootingParams;            // «условия съёмки» — separate fields
  deposit: string;                     // месторождение — free text
  exif?: Record<string, string>;       // raw EXIF we kept, for the record
};

/** A segmented phase with its mask colour and area share (0..1). */
export type PhaseFraction = {
  name: string;
  color: [number, number, number];
  fraction: number;
};

/** Post-processing params for the competition preview mask (per image/tile).
 *  Sulfide ("срастания") components are classed thin (red) vs normal (green) by
 *  area and by thickness ≈ area/perimeter (catches branchy-but-thin shapes). */
export type PreviewParams = {
  minArea: number;       // component area (px) below this → тонкое
  minThickness: number;  // component area/perimeter below this → тонкое
  opacity: number;       // overlay opacity 0..1
};
export const DEFAULT_PREVIEW_PARAMS: PreviewParams = { minArea: 400, minThickness: 3, opacity: 0.55 };

/** Competition mask colours (RGB). */
export const PREVIEW_COLORS = {
  normal: [0, 200, 0] as [number, number, number],   // обычные срастания
  thin:   [235, 30, 30] as [number, number, number], // тонкие срастания
  talc:   [40, 90, 235] as [number, number, number], // тальк
  bg:     [0, 0, 0] as [number, number, number],      // силикат + магнетит
};

/** One panorama sub-image. `fullBox` is the overlapping window (used later to
 *  send to fal); `cropBox` is the seam-trimmed region shown in the preview and
 *  used for seamless re-assembly. */
export type Tile = {
  id: string;
  col: number;
  row: number;
  fullBox: Box;
  cropBox: Box;
  status: ProcStatus;
  phases?: PhaseFraction[];   // set once segmented
  previewParams?: PreviewParams;
};

export type ProjectImage = {
  id: string;
  name: string;                        // original filename
  kind: ImageKind;
  origFile: string;                    // path relative to the project's orig/
  width: number;
  height: number;
  meta: ImageMeta;
  status: ProcStatus;
  phases?: PhaseFraction[];            // set once segmented (single images)
  previewParams?: PreviewParams;
  tiles?: Tile[];                      // panorama only
};

export type Project = {
  id: string;
  name: string;
  domain: Domain;
  createdAt: number;
  images: ProjectImage[];
};

/** Lightweight project card for the hub grid. */
export type ProjectSummary = {
  id: string;
  name: string;
  domain: Domain;
  createdAt: number;
  imageCount: number;
  coverImageId: string | null;         // first image, for the card thumbnail
};

/** Qwen canvas size — the single-image target and the panorama downscale
 *  target (a 2208×1656 tile is downscaled to this before fal, mask upscaled back). */
export const TILE_W = 1472;
export const TILE_H = 1104;

/** Panorama native tile size: 1.5× the Qwen canvas, so each tile covers more
 *  physical area (more phases / more signal). Cut at this native size, then
 *  downscaled to TILE_W×TILE_H for fal, and the returned mask upscaled back. */
export const PANO_TILE_W = 2208;
export const PANO_TILE_H = 1656;

export const PANORAMA_THRESHOLD = 5000; // max(w,h) above this ⇒ panorama (≤5k = single)
export const MIN_OVERLAP = 144;         // px; enforce at least this much seam

/** Fixed mineral-phase palette — MUST mirror server/segment/segment.py PHASES.
 *  The editor is bound to these: no free colours, add only from the missing set. */
export const PALETTE: { name: string; color: [number, number, number] }[] = [
  { name: "Силикат",  color: [60, 60, 60] },
  { name: "Сульфиды", color: [240, 220, 130] },
  { name: "Магнетит", color: [120, 200, 255] },
  { name: "Тальк",    color: [0, 0, 0] },
];
