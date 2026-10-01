/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use client';

import { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { useEditorState, useEditorServices, usePluginSelfConfig, usePluginCommands, usePluginSignals } from '@opengpex/editor/core/context';
import { asWorldShape } from '@opengpex/editor/core/types';
import type { Frame, Layer, WorldShape } from '@opengpex/editor/core/types';
import type { SampledPixels } from '@opengpex/editor/core/engine/types';
import * as P from './protocols';
import { ColorOptionsConfig } from './protocols';
import { fromHex, convertColorGamut, WORKING_GAMUT, type ColorValue } from '@opengpex/editor/core/engine/color';
import type { GamutId } from '@opengpex/editor/core/types/primitives';
import type { ColorOptionsCommandsMap, ColorOptionsSignalsMap } from './commands.d';

/** Backstop on the snapshot's TEXEL dimensions (not its world size).
 *
 *  The ROI is captured at DISPLAY resolution (`scale = min(1, camera.k)`), which
 *  already bounds a side at ~1.2× the viewport in CSS pixels no matter how big the
 *  document is — so on any ordinary display this cap never bites. It exists for the
 *  4K/5K case, where 1.2× viewport would otherwise ask for a ~9MP f32 readback.
 *  When it DOES bite, the snapshot is centred on the cursor (the press point), so
 *  the pressed pixel is always covered. */
const MAX_SNAPSHOT_DIM = 4096;
/** Coverage margin beyond the visible rect, so the snapshot comfortably spans the
 *  viewport around the press point. */
const ROI_PAD_RATIO = 0.1;
/** Side of the 1:1 commit-time micro-capture, in document pixels. Only needs to
 *  cover the centre texel; the margin is there so a fractional world coordinate
 *  cannot land the sample on an edge. */
const EXACT_ROI_DIM = 32;

/** The document's world-space rect. World origin is the artboard CENTRE. */
function docRect(frame: Frame) {
  return { x: -frame.canvas.w / 2, y: -frame.canvas.h / 2, w: frame.canvas.w, h: frame.canvas.h };
}

/**
 * Compute the freeze-snapshot ROI + its capture resolution (§3.4②).
 *
 * THE ROI IS WHAT YOU CAN SEE, THE SCALE IS WHAT YOU CAN RESOLVE. The window is
 * the camera's viewport world box (+ {@link ROI_PAD_RATIO}) ∩ document, and it is
 * captured at `scale = min(1, camera.k)` — i.e. at SCREEN resolution, never finer.
 *
 * WHY: the previous version captured 1:1 document pixels and had to cap the window
 * at 2048 to bound memory, which is the wrong axis to give up. Zoomed out to fit an
 * 8000px document, the eyedropper's preview is already reading a downscaled image —
 * a 1:1 readback spends 64× the memory on detail the cursor cannot address (one
 * screen pixel covers 8×8 document pixels, and only one of them is reachable).
 * Tying the resolution to the camera makes the cost a function of the VIEWPORT
 * (≈1.2× its CSS size, a few MB) instead of the document, and buys back
 * full-viewport coverage — which is what actually stops the re-capture storm while
 * the cursor sweeps a large image.
 *
 * The precision that `scale < 1` gives up is recovered on COMMIT by a 1:1
 * micro-capture around the cursor, so the value handed to `onSample` is always a
 * real document pixel — only the drag-time preview is display-resolution.
 *
 * @param focus World point the capped window must stay centred on (the press
 *   point). Defaults to the viewport centre. This matters ONLY when the cap bites,
 *   which takes a >3400px viewport: centring the window on the cursor guarantees
 *   the pressed pixel is inside the snapshot even on a document wider than the cap.
 */
function computeSnapshotRoi(
  geometry: ReturnType<typeof useEditorServices>['geometry'],
  frame: Frame,
  cam: Frame['camera'],
  vw: number,
  vh: number,
  focus?: { x: number; y: number },
): { roi: WorldShape; scale: number } {
  // `padding` is in SCREEN px (getViewportWorldRect pads the viewport corners
  // before un-projecting), so the world pad follows the zoom automatically.
  const pad = Math.round(ROI_PAD_RATIO * Math.max(vw, vh));
  const world = geometry.camera.getViewportWorldRect({ w: vw, h: vh }, cam, frame.canvas, pad);
  const doc = docRect(frame);

  // Intersect visible-world with the document (background is not GPU-sampleable;
  // the native EyeDropper fallback handles outside-canvas).
  const x1 = Math.max(world.x, doc.x);
  const y1 = Math.max(world.y, doc.y);
  const x2 = Math.min(world.x + world.w, doc.x + doc.w);
  const y2 = Math.min(world.y + world.h, doc.y + doc.h);
  let rx = x1, ry = y1, rw = x2 - x1, rh = y2 - y1;
  if (rw <= 0 || rh <= 0) { rx = doc.x; ry = doc.y; rw = doc.w; rh = doc.h; }

  // Screen resolution, never finer than 1:1 — zooming IN must not magnify the
  // readback, since a document pixel is the finest thing there is to sample.
  const scale = Math.min(1, cam.k > 0 ? cam.k : 1);
  // Cap in TEXELS, so the world window the cap allows grows as we zoom out.
  const maxWorld = MAX_SNAPSHOT_DIM / scale;
  if (rw > maxWorld) {
    const cxw = focus ? focus.x : rx + rw / 2;
    rx = Math.min(Math.max(cxw - maxWorld / 2, rx), rx + rw - maxWorld);
    rw = maxWorld;
  }
  if (rh > maxWorld) {
    const cyw = focus ? focus.y : ry + rh / 2;
    ry = Math.min(Math.max(cyw - maxWorld / 2, ry), ry + rh - maxWorld);
    rh = maxWorld;
  }

  return { roi: asWorldShape({ x: rx, y: ry, w: rw, h: rh }), scale };
}

/**
 * Layer subset for CURRENT-LAYER sampling (§3.3 #5) — what `capture({ layers })`
 * receives instead of the engine's default "all visible, non-host, non-group".
 *
 * The active layer alone, or — when it is a group — every non-group descendant of
 * it. Membership is `groupId` (the user-facing hierarchy); `hostId` satellites
 * (exchange / fragment triplets) stay out, exactly as the engine's own default
 * filter does.
 *
 * VISIBILITY IS DELIBERATELY NOT FILTERED: `renderReadback` forces `visible: true`
 * on a hand-picked subset ("the caller hand-picked this subset"), so a hidden
 * active layer still samples its own pixels rather than collapsing to an empty
 * scene. That is the engine's contract for subsets, not an accident here.
 *
 * `null` = no active layer → fall back to the engine default (all layers), which
 * is the only non-arbitrary answer when there is no "current" layer to mean.
 */
function currentLayerSubset(frame: Frame, activeLayerId: string | null): Layer[] | null {
  if (!activeLayerId) return null;
  const active = frame.layers.byId[activeLayerId];
  if (!active) return null;
  if (active.type !== 'group') return [active];

  // Transitive closure over `groupId`, by fixpoint rather than one pass: nothing
  // guarantees a nested group appears AFTER its parent in `order`.
  const members = new Set<string>([active.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of frame.layers.order) {
      const l = frame.layers.byId[id];
      if (!l || members.has(l.id) || !l.groupId || !members.has(l.groupId)) continue;
      members.add(l.id);
      grew = true;
    }
  }
  // Emit in the frame's DRAW ORDER — `capture()` composites the subset in the
  // order it is handed, so `order` is what keeps a group's internal stacking.
  return frame.layers.order
    .map((id) => frame.layers.byId[id])
    .filter((l) => l && !l.hostId && l.type !== 'group' && members.has(l.id));
}

/**
 * useColorOptions: Command Discovery Hook for the ColorOptions plugin.
 * Transparently passes fillAsLayerCmd reference, component layer explicitly calls .execute() and constructs payload.
 */
export const useColorOptions = () => {
  const { state, activeFrame, activeLayer } = useEditorState();
  const { actions, pixels, geometry, assets } = useEditorServices();
  const {
    fillAsLayerCmd,
    samplerToolSetCmd,
    samplerToolCycleForwardCmd,
    samplerToolCycleBackwardCmd,
    exitSamplerCmd,
  } = usePluginCommands<ColorOptionsCommandsMap>();
  const { samplerActiveSignal } = usePluginSignals<ColorOptionsSignalsMap>();

  // Global pending color for the next fill (persisted in plugin config)
  const [config, setConfig] = usePluginSelfConfig<ColorOptionsConfig>();
  const pendingColor = config.pendingColor || fromHex("#EAB308");

  // ── Sampling scope (§3.3 #5) ──
  // Persisted, and DEFAULTS TO ALL LAYERS: `undefined` config (every existing
  // install) must keep the historical full-composite behaviour.
  //
  // It doubles as the ACTIVE CANVAS TOOL of the sampler strip ('all' ↔ 'layer'):
  // the scope *is* the tool, so there is no second field to keep in sync.
  const sampleAllLayers = config.sampleAllLayers !== false;
  const activeSamplerTool = P.samplerToolFromScope(sampleAllLayers);

  /**
   * The `layers` argument for BOTH capture paths, or `undefined` for the engine
   * default. One value, two consumers — that is the point: the press snapshot and
   * the commit-time 1:1 micro-capture must composite the SAME layer set, or the
   * preview and the committed colour come from different documents.
   *
   * Identity changes only with `activeFrame` / `activeLayer.id` / the mode flag.
   * `requestSnapshot` and `warmPredraw` both close over it, so flipping All ↔
   * Current Layer between presses re-warms and makes the next press capture the new
   * set. (There is no mid-drag switch to worry about: the tool strip is only
   * clickable between picks, never while the button is held.)
   */
  const sampleLayers = useMemo(() => {
    if (sampleAllLayers || !activeFrame) return undefined;
    return currentLayerSubset(activeFrame, activeLayer?.id ?? null) ?? undefined;
  }, [sampleAllLayers, activeFrame, activeLayer?.id]);

  // Canvas color sampler state — driven directly by global interactionMode === 'sample' (Single Source of Truth).
  const isSampling = state.interaction.interactionMode === 'sample';
  const setIsSampling = useCallback(
    (next: boolean) => {
      actions.setInteraction({ interactionMode: next ? 'sample' : 'pan' });
      samplerActiveSignal?.set(next);
    },
    [actions, samplerActiveSignal],
  );

  // Sync the legacy signal with interactionMode for backward compatibility
  useEffect(() => {
    if (samplerActiveSignal && samplerActiveSignal.value !== isSampling) {
      samplerActiveSignal.set(isSampling);
    }
  }, [isSampling, samplerActiveSignal]);

  // Freeze snapshot (§3): captured on the PRESS that starts a pick, indexed
  // in-memory while the button is held, dropped when sampling ends.
  const [snapshot, setSnapshot] = useState<SampledPixels | null>(null);
  // Ref mirror so the overlay's press handler can read the just-captured snapshot
  // synchronously (without waiting for a React re-render). Written ONLY through
  // `applySnapshot` — never during render, so the two can't diverge.
  const snapshotRef = useRef<SampledPixels | null>(null);
  const applySnapshot = useCallback((next: SampledPixels | null) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);
  /** Drop the frozen snapshot (release its `linearPixels` to GC). */
  const releaseSnapshot = useCallback(() => applySnapshot(null), [applySnapshot]);

  // ── Capture serialization ────────────────────────────────────────────────────
  // `capture()` is a GPU render + readback that holds tens of MB alive and shares
  // the engine's buffer ring / texture pool, so two of them must never overlap.
  //
  // The previous guard was a boolean that DROPPED the loser — which broke the fast
  // click: release before the press snapshot landed, and `captureExactAt` bailed on
  // the busy flag, leaving the pick with nothing to commit. Queueing instead of
  // dropping keeps the same "never two at once" property while guaranteeing every
  // caller eventually runs; the release read just waits out the snapshot.
  const captureQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const enqueueCapture = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    // `.then(job, job)` so a rejected predecessor still lets the next job start.
    const run = captureQueueRef.current.then(job, job);
    // The tail must never stay rejected, or every later job inherits the failure.
    captureQueueRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, []);

  /**
   * Monotonic press counter. A snapshot request that is still queued when a NEWER
   * press arrives is stale — its press is over, and running it would decode tens
   * of MB for a readout nobody will see. The queued job compares and bails.
   */
  const snapshotSeqRef = useRef(0);

  /**
   * Capture the freeze snapshot for ONE press (§3.4④). Called from the overlay's
   * `mousedown` — never on tool-enter and never per pointer move, so navigation
   * (pan/zoom) does zero GPU readback: the frame drops that motivated this
   * refactor were the per-move re-capture storm, now gone.
   *
   * The snapshot is a single UN-POOLED `capture()` of the viewport ∩ document at
   * `scale = min(1, camera.k)`, centred on the press point. One readback per press
   * at human cadence produces no GC churn, so the session-resident pool is gone:
   * each press allocates, decodes, and lets the previous snapshot fall to GC.
   *
   * Returns the capture so the caller can sample it immediately, or `null` when
   * there is no frame, the capture failed, or a newer press superseded this one.
   */
  const requestSnapshot = useCallback(
    async (world?: { x: number; y: number }): Promise<SampledPixels | null> => {
      if (!activeFrame) return null;
      const seq = ++snapshotSeqRef.current;
      return enqueueCapture(async () => {
        // Superseded while queued: the newer press captures for itself.
        if (seq !== snapshotSeqRef.current) return snapshotRef.current;
        try {
          const container = document.querySelector('.editor-viewport-container');
          const rect = container?.getBoundingClientRect();
          const vw = rect?.width || window.innerWidth;
          const vh = rect?.height || window.innerHeight;
          const cam = actions.fast.latestCamera(activeFrame.id);
          const plan = computeSnapshotRoi(geometry, activeFrame, cam, vw, vh, world);
          const cap = await pixels.render.capture(activeFrame, {
            roi: plan.roi,
            scale: plan.scale,
            layers: sampleLayers,
          });
          applySnapshot(cap);
          return cap;
        } catch {
          applySnapshot(null);
          return null;
        }
      });
    },
    [activeFrame, actions, geometry, pixels, applySnapshot, sampleLayers, enqueueCapture],
  );

  /**
   * Warm-up predraw for the readback pipeline (§3.4④). A throwaway 1×1 `scale: 1`
   * capture run on tool-enter: it forces the engine to compile the export shaders
   * and warm its high-depth path NOW, so the first real press pays no compile
   * hitch. The result is discarded — only the side effect (a warm GPU pipeline)
   * matters. Same `layers` as the real captures, so the exact pipeline is warmed.
   */
  const warmPredraw = useCallback(async () => {
    if (!activeFrame) return;
    const seq = snapshotSeqRef.current;
    await enqueueCapture(async () => {
      // A press queued behind us before we started: it warms the very same
      // pipeline, so the throwaway readback would only delay the real one.
      if (seq !== snapshotSeqRef.current) return;
      try {
        const doc = docRect(activeFrame);
        await pixels.render.capture(activeFrame, {
          roi: asWorldShape({ x: doc.x, y: doc.y, w: 1, h: 1 }),
          scale: 1,
          layers: sampleLayers,
        });
      } catch {
        /* warm-up only; a failure just means the first press pays the compile. */
      }
    });
  }, [activeFrame, pixels, sampleLayers, enqueueCapture]);

  /**
   * 1:1 micro-capture around a world point, for the sampler's COMMIT path (A′).
   *
   * The press snapshot is captured at screen resolution, so at zoom < 1 its texels
   * are filtered blends. This returns a small `scale: 1` capture centred on the
   * cursor so the committed value is a real document pixel. ~{@link EXACT_ROI_DIM}²
   * texels ≈ 64KB, a handful of ms — it runs once, on release.
   *
   * SAME `layers` AS THE SNAPSHOT — non-negotiable. If this composited the full
   * document while the snapshot showed one layer, the release would land a colour
   * the user never previewed.
   *
   * QUEUED, NOT DROPPED: on a fast click this is issued while the press snapshot
   * is still reading back. It waits its turn rather than bailing — that wait (tens
   * of ms) is the difference between committing a real pixel and committing
   * nothing at all.
   */
  const captureExactAt = useCallback(
    async (world: { x: number; y: number }): Promise<SampledPixels | null> => {
      if (!activeFrame) return null;
      const doc = docRect(activeFrame);
      const half = EXACT_ROI_DIM / 2;
      // Clamp the window into the document, keeping the requested size where the
      // document allows it (a tiny document may be smaller than the window).
      const w = Math.min(EXACT_ROI_DIM, doc.w);
      const h = Math.min(EXACT_ROI_DIM, doc.h);
      const x = Math.min(Math.max(Math.floor(world.x) - half, doc.x), doc.x + doc.w - w);
      const y = Math.min(Math.max(Math.floor(world.y) - half, doc.y), doc.y + doc.h - h);
      return enqueueCapture(async () => {
        try {
          return await pixels.render.capture(activeFrame, {
            roi: asWorldShape({ x, y, w, h }),
            scale: 1,
            layers: sampleLayers,
          });
        } catch {
          return null;
        }
      });
    },
    [activeFrame, pixels, sampleLayers, enqueueCapture],
  );

  // ── Snapshot lifecycle: warm the readback pipeline on enter, drop on exit ──
  // NO capture on enter and NO per-move re-capture — the snapshot is taken on the
  // PRESS that starts a pick (`requestSnapshot`), so pan/zoom cost nothing. Enter
  // only WARMS the pipeline (a throwaway 1×1 readback) so the first press has no
  // shader-compile hitch.
  //
  // The snapshot is dropped in the CLEANUP, not the body: leaving sample mode (or
  // switching frames) tears the effect down, which drops the `linearPixels`
  // reference (§3.4①) without a synchronous setState-in-effect cascade. With the
  // pool gone there is nothing else to release — the previous snapshot simply falls
  // to GC.
  //
  // DEPS ARE FRAME ID, NOT `warmPredraw`: that callback closes over the `activeFrame`
  // OBJECT, whose identity churns on every document mutation — including the
  // `updateLayer` a pick onto a colour layer triggers. Depending on it re-ran this
  // effect mid-session, dropping a live snapshot and firing a spurious warm
  // readback. Routing it through a latest-ref keeps the effect keyed to what
  // actually matters: entering sample mode, and switching frames.
  const warmPredrawRef = useRef(warmPredraw);
  useEffect(() => {
    warmPredrawRef.current = warmPredraw;
  });
  useEffect(() => {
    if (!isSampling || !activeFrame) return;
    warmPredrawRef.current();
    return () => {
      applySnapshot(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSampling, activeFrame?.id, applySnapshot]);

  // (interactionMode === 'sample' is now the single source of truth for isSampling,
  // so any external tool activation like Brush/Clip automatically exits the sampler cleanly)

  // ── While sampling: own the modal keys (§3.4③) ──
  // Swallow undo / redo / delete so the frozen document can't change under us, and
  // route Tab / Shift+Tab to the sampler tool strip.
  //
  // WHY TAB IS BOUND HERE AND NOT AS A COMMAND SHORTCUT: `HotkeyManager` matches
  // the FIRST shortcut whose chord fits and calls `preventDefault()` before the
  // command's own guard, and the registry has no priority order. Tab already
  // belongs to ClipOptions' `cycleToolForward`, so a second declarative claim would
  // either be dead or break clip mode depending on registration order. This
  // listener is capture-phase on `document` while `HotkeyManager` listens on
  // `window` bubble, so stopping propagation here gives the modal overlay first
  // refusal — exactly how its clicks and Esc are already routed. The commands
  // remain the single implementation.
  useEffect(() => {
    if (!isSampling || !activeFrame) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) samplerToolCycleBackwardCmd?.execute();
        else samplerToolCycleForwardCmd?.execute();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const mutating =
        (mod && (k === 'z' || k === 'y')) || k === 'delete' || k === 'backspace';
      if (mutating) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isSampling, activeFrame, samplerToolCycleForwardCmd, samplerToolCycleBackwardCmd]);

  // ── Frame colour identity (§5.4 / decision I) ──
  // Authoritative anchor: StoredAsset via assetId, mirroring
  // `ImageInfoDrawer/hooks.ts`'s `sourceGamut`/`docBitDepth`. Drives the Pro
  // panel's LOCKED view gamut and its auto-expand judgement — this hook
  // computes both so `ColorPickerPro` itself stays frame-agnostic.
  const frameGamut: GamutId = useMemo(() => {
    if (activeFrame?.assetId) {
      return assets.get(activeFrame.assetId)?.gamut ?? 'srgb';
    }
    return (activeFrame?.metadata?.colorSpace as GamutId) ?? 'srgb';
  }, [activeFrame, assets]);

  const frameBitDepth = useMemo(() => {
    if (activeFrame?.assetId) {
      const depth = assets.get(activeFrame.assetId)?.bitDepth;
      if (depth !== undefined) return depth;
    }
    return activeFrame?.metadata?.bitDepth;
  }, [activeFrame, assets]);

  // Criterion: wide gamut OR high bit depth — two INDEPENDENT axes (an 8-bit
  // wide-gamut doc and a 16-bit sRGB doc both qualify), never an AND.
  const autoExpandPro =
    frameGamut !== 'srgb' || (frameBitDepth !== undefined && frameBitDepth > 8);

  const { currentColor, isColorLayer } = useMemo(() => {
    const isColorLayer = activeLayer?.type === "color";
    const currentColor = isColorLayer
      ? activeLayer?.metadata?.fillColor || fromHex("#EAB308")
      : pendingColor;
    return { currentColor, isColorLayer };
  }, [activeLayer, pendingColor]);

  // The single write boundary: `pendingColor` / `metadata.fillColor`'s
  // storage representation is ALWAYS `WORKING_GAMUT`. Callers (widget edits via
  // `ColorPickerPro.onValueChange`, sampler picks via `handleSampled`) hand in a
  // frame/view-gamut value; this is the one place that converts it before it is
  // ever persisted. Converted only on write (sample/edit) — this function IS the write.
  const applyColor = useCallback((newColor: ColorValue) => {
    const stored = convertColorGamut(newColor, WORKING_GAMUT);
    setConfig({ pendingColor: stored });

    // If a color layer is currently active, mutate it live
    if (isColorLayer && activeFrame && activeLayer) {
      actions.updateLayer(activeFrame.id, activeLayer.id, {
        metadata: { ...activeLayer.metadata, fillColor: stored },
      });
    }
  }, [setConfig, isColorLayer, activeFrame, activeLayer, actions]);

  /** Activate canvas color sampler (custom crosshair UI) */
  const sampleColor = useCallback(() => {
    setIsSampling(true);
  }, [setIsSampling]);

  /** Handle sampled color from ColorSampler.
   *  Applies the picked colour but KEEPS the tool active (Photoshop point sample):
   *  a pick is not an exit. The user leaves the sampler via Esc / right-click
   *  (`cancelSampling`), toggling `I`, or switching tools. */
  const handleSampled = useCallback((color: ColorValue) => {
    applyColor(color);
  }, [applyColor]);

  /** Cancel sampling */
  const cancelSampling = useCallback(() => {
    setIsSampling(false);
  }, [setIsSampling]);

  return {
    state,
    currentColor,
    isColorLayer,
    applyColor,
    sampleColor,
    isSampling,
    handleSampled,
    cancelSampling,
    activeFrame,
    // Frame colour identity (§5.4) — locked Pro-panel view gamut + auto-expand.
    frameGamut,
    autoExpandPro,
    // Sampler tool strip (§3.3 #5). The scope IS the active canvas tool, so
    // there is nothing to derive beyond projecting it; the three tools are
    // driven exclusively through the commands below.
    sampleAllLayers,
    activeSamplerTool,
    samplerToolSetCmd,
    exitSamplerCmd,
    // Freeze snapshot + projection deps for ColorSampler (§3.3 #1). The overlay
    // takes the snapshot on press via `onRequestSnapshot`, indexes it in-memory
    // while dragging, and commits with `captureExactAt` on release.
    snapshot,
    onRequestSnapshot: requestSnapshot,
    captureExactAt,
    releaseSnapshot,
    geometry,
    getCamera: useCallback(
      () => (activeFrame ? actions.fast.latestCamera(activeFrame.id) : undefined),
      [actions, activeFrame],
    ),
    // Plugin Command (transparently passed Cmd reference, component layer explicitly calls .execute())
    fillAsLayerCmd,
  };
};
