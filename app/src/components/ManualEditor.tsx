import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CanvasView, type Mode, type RegionClick, type LassoCut,
} from "../editor/CanvasView";
import { Toolbar, type Tool } from "../editor/Toolbar";
import { PhasesPanel } from "../editor/PhasesPanel";
import { RegionMenu } from "../editor/RegionMenu";
import {
  type MaskData, type Phase,
  computeComponents, reassignComponent, maskToPngBase64, pickUnusedColor,
} from "../editor/mask";
import { CommentRetryPanel } from "./CommentRetryPanel";
import { PreviewMask } from "./PreviewMask";
import { type PhaseFraction, type PreviewParams, DEFAULT_PREVIEW_PARAMS } from "../../shared/types";

const HISTORY_LIMIT = 80;

type Props = {
  projectId: string;
  itemKey: string;            // single_<id> | tile_<id>
  origSrc: string;            // photo under outlines (normalized/raw per toggle)
  maskSrc: string;            // current mask PNG
  phasesJson: Phase[];        // authoritative phase names + colours
  fractions?: PhaseFraction[];// server-computed area shares (for the legend)
  previewParams?: PreviewParams;
  onSaveParams: (p: PreviewParams) => void;
  onRetry: (comment: string) => void;
  retrying?: boolean;
};

/** The full manual-editing workspace for one segmented item: the editor toolbar
 *  (Превью / Ручное редактирование + tools), the editor canvas over the cloud
 *  mask, and a bottom panel that is the comment/Retry bar in preview mode and the
 *  phases panel in edit mode. Adapted from the standalone editor's App.tsx, saving
 *  to the project's mask endpoint instead of the local dataset. */
export function ManualEditor({ projectId, itemKey, origSrc, maskSrc, phasesJson, fractions, previewParams, onSaveParams, onRetry, retrying }: Props) {
  const [mode, setMode] = useState<Mode>("preview");
  const [pparams, setPparams] = useState<PreviewParams>(previewParams ?? DEFAULT_PREVIEW_PARAMS);
  // Reset preview params when switching item.
  useEffect(() => { setPparams(previewParams ?? DEFAULT_PREVIEW_PARAMS); }, [itemKey]);  // eslint-disable-line react-hooks/exhaustive-deps
  const pSaveTimer = useRef<number | null>(null);
  const onParamsChange = (p: PreviewParams) => {
    setPparams(p);
    if (pSaveTimer.current) window.clearTimeout(pSaveTimer.current);
    pSaveTimer.current = window.setTimeout(() => onSaveParams(p), 500);
  };
  const [tool, setTool] = useState<Tool>("cursor");
  const [wandThreshold, setWandThreshold] = useState(12);
  const [wandFillArea, setWandFillArea] = useState(4);
  const [wandSmooth, setWandSmooth] = useState(1);
  const [lassoThreshold, setLassoThreshold] = useState(10);
  const [brushSize, setBrushSize] = useState(16);
  const [targetPhaseIdx, setTargetPhaseIdx] = useState(0);
  const [influenceOn, setInfluenceOn] = useState(false);
  const [influenceAllowed, setInfluenceAllowed] = useState<boolean[]>([]);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [mask, setMask] = useState<MaskData | null>(null);
  const [regionMenu, setRegionMenu] = useState<RegionClick | null>(null);
  const [, setLassoBusy] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const maskRef = useRef<MaskData | null>(null); maskRef.current = mask;
  const pastRef = useRef<MaskData[]>([]);
  const futureRef = useRef<MaskData[]>([]);
  const [, setHistTick] = useState(0);
  const bumpHist = () => setHistTick((t) => t + 1);
  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;

  const components = useMemo(
    () => (mask ? computeComponents(mask.labels, mask.width, mask.height) : null),
    [mask?.labels, mask?.width, mask?.height],
  );

  // -------- Saving --------
  const doSave = useCallback(async () => {
    const m = maskRef.current;
    if (!m) return;
    setSaveState("saving");
    try {
      const pngBase64 = await maskToPngBase64(m);
      const res = await fetch(`/api/projects/${projectId}/mask/${itemKey}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pngBase64, phases: m.phases }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSaveState("saved");
    } catch (e) {
      console.error("mask save failed:", e);
      setSaveState("error");
    }
  }, [projectId, itemKey]);

  const saveTimer = useRef<number | null>(null);
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void doSave(); }, 600);
  }, [doSave]);

  const commitMask = useCallback((next: MaskData) => {
    if (maskRef.current) pastRef.current = [...pastRef.current, maskRef.current].slice(-HISTORY_LIMIT);
    futureRef.current = [];
    setMask(next);
    bumpHist();
    scheduleSave();
  }, [scheduleSave]);

  const undo = useCallback(() => {
    const prev = pastRef.current[pastRef.current.length - 1];
    if (!prev || !maskRef.current) return;
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [maskRef.current, ...futureRef.current];
    setMask(prev); bumpHist(); scheduleSave();
  }, [scheduleSave]);

  const redo = useCallback(() => {
    const next = futureRef.current[0];
    if (!next || !maskRef.current) return;
    futureRef.current = futureRef.current.slice(1);
    pastRef.current = [...pastRef.current, maskRef.current];
    setMask(next); bumpHist(); scheduleSave();
  }, [scheduleSave]);

  // Reset history when the item changes.
  useEffect(() => {
    setMask(null); setRegionMenu(null); setSaveState("idle");
    setTargetPhaseIdx(0); setInfluenceOn(false); setInfluenceAllowed([]);
    pastRef.current = []; futureRef.current = []; bumpHist();
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
  }, [itemKey]);

  useEffect(() => {
    if (saveState === "saved") setSaveState("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mask]);

  // -------- Keyboard (tools, undo/redo, save, space/shift) --------
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const onDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = isTyping(e.target);
      if (e.key === "Shift") { setShiftHeld(true); return; }
      if (mod && e.code === "KeyS") { e.preventDefault(); void doSave(); return; }
      if (mod && !typing && e.code === "KeyZ") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && !typing && e.code === "KeyY") { e.preventDefault(); redo(); return; }
      if (mod) return;
      if (e.code === "KeyV" && !typing) { setTool("cursor"); return; }
      if (e.code === "KeyL" && !typing) { setTool("lasso"); return; }
      if (e.code === "KeyW" && !typing) { setTool("wand"); return; }
      if (e.code === "KeyB" && !typing) { setTool("brush"); return; }
      if (e.code === "KeyC" && !typing) { setTool("colorrange"); return; }
      if (e.code !== "Space" || typing) return;
      e.preventDefault();
      if (!e.repeat) setSpaceHeld(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") { setShiftHeld(false); return; }
      if (e.code !== "Space" || isTyping(e.target)) return;
      e.preventDefault(); setSpaceHeld(false);
    };
    const onBlur = () => { setSpaceHeld(false); setShiftHeld(false); };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [doSave, undo, redo]);

  const onMaskLoaded = useCallback((_id: string, m: MaskData) => {
    setMask(m);
    setInfluenceAllowed(new Array(m.phases.length).fill(true));
    setTargetPhaseIdx((cur) => (cur < m.phases.length ? cur : 0));
  }, []);

  const canEditPhase = (phaseIdx: number) => !influenceOn || influenceAllowed[phaseIdx] === true;
  const onToggleInfluence = (v: boolean) => {
    if (v) setInfluenceAllowed(new Array(mask?.phases.length ?? 0).fill(false));
    setInfluenceOn(v);
  };
  const onToggleAllowed = (i: number) => {
    setInfluenceAllowed((arr) => {
      const next = arr.length ? arr.slice() : new Array(mask?.phases.length ?? 0).fill(false);
      next[i] = !(next[i] === true);
      return next;
    });
  };

  const onPhasesChange = (next: MaskData["phases"]) => {
    if (!mask) return;
    setMask({ ...mask, phases: next });
    scheduleSave();
  };
  // Add a specific palette phase (chosen from the missing set in the panel).
  const onAddPhase = (phase: Phase) => {
    if (!mask) return;
    if (mask.phases.some((p) => p.color.join() === phase.color.join())) return;
    commitMask({ ...mask, phases: [...mask.phases, phase] });
    setInfluenceAllowed((a) => [...a, false]);
  };

  const assignComponent = (cid: number, newIdx: number, curPhase: number) => {
    if (!mask || !components || newIdx === curPhase) return;
    if (!canEditPhase(curPhase)) return;
    commitMask({ ...mask, labels: reassignComponent(mask.labels, components, cid, newIdx) });
  };
  const applyCut = (cutMask: Uint8Array, newIdx: number) => {
    if (!mask) return;
    const labels = new Uint8Array(mask.labels);
    let changed = false;
    for (let i = 0; i < labels.length; i++) {
      if (cutMask[i] && canEditPhase(labels[i])) { labels[i] = newIdx; changed = true; }
    }
    if (changed) commitMask({ ...mask, labels });
  };

  const onRegionClick = (click: RegionClick | null) => {
    if (click && !canEditPhase(click.phaseIdx)) return;
    setRegionMenu(click);
  };
  const onAssignPhase = (newIdx: number) => {
    if (regionMenu) assignComponent(regionMenu.cid, newIdx, regionMenu.phaseIdx);
    setRegionMenu(null);
  };
  const onLassoCut = (cut: LassoCut) => applyCut(cut.cutMask, targetPhaseIdx);

  return (
    <div className="editor">
      <Toolbar
        mode={mode} onModeChange={setMode}
        tool={tool} onToolChange={setTool}
        onSave={doSave} saveState={saveState} canSave={!!mask}
        onUndo={undo} onRedo={redo} canUndo={canUndo} canRedo={canRedo}
        wandThreshold={wandThreshold} onWandThreshold={setWandThreshold}
        wandFillArea={wandFillArea} onWandFillArea={setWandFillArea}
        wandSmooth={wandSmooth} onWandSmooth={setWandSmooth}
        lassoThreshold={lassoThreshold} onLassoThreshold={setLassoThreshold}
        brushSize={brushSize} onBrushSize={setBrushSize}
        phases={mask?.phases ?? []}
        targetPhaseIdx={targetPhaseIdx} onTargetPhase={setTargetPhaseIdx}
      />
      {mode === "edit" ? (
        <CanvasView
          id={itemKey}
          origSrc={origSrc}
          maskSrc={maskSrc}
          phasesJson={phasesJson}
          mode={mode}
          tool={tool}
          spaceHeld={spaceHeld}
          shiftHeld={shiftHeld}
          mask={mask}
          components={components}
          wandThreshold={wandThreshold}
          onWandThreshold={setWandThreshold}
          wandFillArea={wandFillArea}
          wandSmooth={wandSmooth}
          lassoThreshold={lassoThreshold}
          onLassoThreshold={setLassoThreshold}
          brushSize={brushSize}
          onBrushSize={setBrushSize}
          targetPhaseIdx={targetPhaseIdx}
          onTargetPhase={setTargetPhaseIdx}
          phases={mask?.phases ?? []}
          influenceOn={influenceOn}
          influenceAllowed={influenceAllowed}
          onMaskLoaded={onMaskLoaded}
          onRegionClick={onRegionClick}
          onLassoCut={onLassoCut}
          onLassoBusyChange={setLassoBusy}
        />
      ) : (
        <PreviewMask
          origSrc={origSrc}
          maskSrc={maskSrc}
          params={pparams}
          onParamsChange={onParamsChange}
        />
      )}
      {mode === "preview" ? (
        <CommentRetryPanel onRetry={onRetry} busy={retrying} />
      ) : (
        <PhasesPanel
          phases={mask?.phases ?? []}
          onAddPhase={onAddPhase}
          canAddPhase={!!mask}
          influenceOn={influenceOn}
          onToggleInfluence={onToggleInfluence}
          influenceAllowed={influenceAllowed}
          onToggleAllowed={onToggleAllowed}
        />
      )}
      {regionMenu && mask && (
        <RegionMenu
          x={regionMenu.x} y={regionMenu.y}
          phases={mask.phases}
          excludeIdx={regionMenu.phaseIdx}
          onPick={onAssignPhase}
          onClose={() => setRegionMenu(null)}
        />
      )}
    </div>
  );
}
