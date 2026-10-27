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

/**
 * interactions.ts — The vector brush's pointer gesture.
 *
 * @module plugins/base/overlays/BrushOverlay/interactions
 */

import {
  InteractionHandler,
  InteractionEvent,
  Layer,
  StrokeData,
  StrokePoint,
  asLocalShape,
} from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { fromHex, type ColorValue } from '@opengpex/editor/core/engine/color';
import { PERF_MON } from '@opengpex/editor/core/helpers/config';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import { ColorOptionsAPI } from '../../options/ColorOptions/protocols';
import { advanceRope, applyTaper, densifyTaperZones, taperZones, tightenStroke } from './geometry';
import * as P from './protocols';

const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;
const DRAWING_STROKE_KEY = P.BrushOverlayAPI.signals.drawingStroke;

/** Only used when CraftDrawer has no persisted size yet. */
const FALLBACK_BRUSH_SIZE = 12;

/** The paint parameters, frozen at pointerdown so mid-stroke slider edits cannot split a stroke. */
interface PaintParams {
  color: ColorValue;
  /** Tip diameter at pressure 1, logical px. */
  size: number;
  /** 0..1 (the CraftDrawer slider is 0..100). */
  hardness: number;
  /** 0..1 — lands on `layer.opacity`, applied downstream by `drawLayer`. */
  opacity: number;
  /** Edge AA toggle (frozen with the rest of the params at pointerdown). */
  antiAliased: boolean;
  /**
   * Rope-model stabilizer slack in SCREEN px (0 = off). Divided by the camera
   * zoom at sample time so the felt smoothness is zoom-independent.
   */
  stabilizer: number;
  /** Pen pressure → per-point ink opacity (the width lane always follows pressure). */
  pressureOpacity: boolean;
  /** Taper fraction per end (0..1 sliders; 0 = that end keeps its round cap). */
  taperHead: number;
  taperTail: number;
  /** Fast-thin/slow-thick velocity dynamics toggle. */
  velocity: boolean;
}

/** Read the paint parameters out of the shared CraftDrawer / ColorOptions config. */
function readPaintParams(e: InteractionEvent): PaintParams {
  const craft = e.state.pluginConfig[CraftDrawerAPI.configKey] || {};
  const colorCfg = e.state.pluginConfig[ColorOptionsAPI.configKey] || {};

  return {
    // The full structured ColorValue, NOT a hex string: StrokeData carries the
    // wide-gamut currency all the way to `toWorkingLinearRgba` in the mapper.
    // Alpha is pinned to 1: the pending colour may carry a sampled/edited
    // alpha, but stroke coverage is governed by `brushOpacity` alone
    // (Photoshop semantics — the foreground colour has no alpha channel).
    color: {
      ...((colorCfg.pendingColor as ColorValue | undefined) ?? fromHex('#FFFFFF')),
      alpha: 1,
    },
    size: (craft.brushSize as number) ?? FALLBACK_BRUSH_SIZE,
    hardness: ((craft.brushHardness as number) ?? 80) / 100,
    opacity: ((craft.brushOpacity as number) ?? 100) / 100,
    // Normalize the tri-state config field: omitted = AA on.
    antiAliased: (craft.brushAntiAliased as boolean | undefined ?? true) !== false,
    // Input dynamics (all default off / neutral).
    stabilizer: (craft.brushStabilizer as number | undefined) ?? 0,
    pressureOpacity: craft.brushPressureOpacity === true,
    // Per-end taper fractions; fall back to the legacy single-slider key so
    // pre-split configs and old presets keep their behaviour.
    taperHead: ((craft.brushTaperStart as number | undefined) ?? (craft.brushTaper as number | undefined) ?? 0) / 100,
    taperTail: ((craft.brushTaperEnd as number | undefined) ?? (craft.brushTaper as number | undefined) ?? 0) / 100,
    velocity: craft.brushVelocity === true,
  };
}

/**
 * Pen pressure for this sample, clamped to (0, 1].
 *
 * A MOUSE reports 0.5 whenever a button is down (PointerEvent spec), which
 * would silently halve the painted tip against both the size slider and the
 * on-screen cursor ring — so mouse input is pinned to 1. Pen and touch keep
 * their reported pressure, with 0 (unsupported / hover) falling back to 0.5.
 */
function samplePressure(e: InteractionEvent): number {
  const type = e.pointer.pointerType;
  if (type !== 'pen' && type !== 'touch') return 1;
  const raw = e.pointer.pressure;
  return raw > 0 ? Math.min(1, raw) : 0.5;
}

/**
 * Build the stroke payload for the given trajectory. `box` is the trajectory's
 * own box (the in-drag preview uses the canvas-sized box, `points` being canvas
 * coordinates; the commit path re-based them via `tightenStroke` first). The
 * taper envelope is applied HERE (not on the gesture's raw point stream) so
 * the live preview and the committed stroke share one code path.
 */
const buildStrokeData = (
  params: PaintParams,
  points: StrokePoint[],
  box: { x: number; y: number; w: number; h: number },
  confinement?: StrokeData['confinement'],
): StrokeData => {
  // One clamped zone set for BOTH passes: the densifier and the envelope
  // locate the taper regions by arc distance and must agree on where each
  // ends. Head and tail are independent (per-end sliders, linkable in the UI).
  const { head, tail } = taperZones(
    points,
    params.size * P.TAPER_LENGTH_PER_SIZE,
    params.taperHead,
    params.taperTail,
  );
  return {
    points: applyTaper(
      densifyTaperZones(points, head, tail, P.MIN_SAMPLE_DISTANCE_PX),
      head,
      tail,
      params.pressureOpacity === true,
    ),
    box,
    color: params.color,
    size: params.size,
    hardness: params.hardness,
    antiAliased: params.antiAliased,
    confinement,
  };
};

// ─── BrushStrokeHandler ───────────────────────────────────────────────────────

/**
 * BrushStrokeHandler: drag on the canvas to paint a brush stroke.
 *
 * Priority 145, the same rung as marker-draw — the two are mutually exclusive
 * through the `activeCraft` gate, so they never compete for the same event.
 */
export const createBrushStrokeHandler = (): InteractionHandler => {
  let tx: InteractionTransaction | null = null;
  let layerId: string | null = null;
  let points: StrokePoint[] = [];
  let params: PaintParams | null = null;
  let drawing = false;
  // Rope-model stabilizer state (canvas px). Only advances when the stabilizer
  // is on; otherwise the raw pointer position samples directly.
  let ropeX = 0;
  let ropeY = 0;
  // Velocity-dynamics reference: previous sample position/time (canvas px, ms),
  // plus the smoothed time delta and speed — both are EMAs because raw pointer
  // event timing and trackpad speeds are noise-dominated, and an unsmoothed
  // speed signal makes the width pulse instead of tracking real velocity.
  let lastRawX = 0;
  let lastRawY = 0;
  let lastRawT = 0;
  let velocityReady = false;
  let smoothDtMs = 1;
  let smoothV = 0;
  // Selection confinement, captured at GESTURE START (frozen semantics): the
  // live selection object is held by reference — it is never mutated in place
  // (the reducer replaces it), so this reference IS the gesture-start state and
  // the selection cannot change mid-drag anyway. The in-drag layer is
  // canvas-sized with cx=cy=0, so its layer-local space IS canvas coordinates
  // and the canvas-space snapshot attaches verbatim for the live preview; at
  // commit the snapshot is re-based by the same (x0, y0) shift as the
  // trajectory (core translatePolygon) and deep-copied. `null` = unconstrained stroke.
  let confinement: StrokeData['confinement'] = undefined;
  // Coordinates of the last LANDED sample — the fixed reference the sampling
  // threshold accumulates against. Kept separate from `points[n-1]` because the
  // transient tail (below) continuously moves that point; comparing against it
  // would reset the accumulation every event and slow drags would never land a
  // new sample (the ribbon degenerates to one anchor→cursor segment that
  // pivots with the pointer).
  let anchorX = 0;
  let anchorY = 0;

  const reset = (e: InteractionEvent) => {
    tx = null;
    layerId = null;
    points = [];
    params = null;
    drawing = false;
    confinement = undefined;
    e.actions.setStateSignal(DRAWING_STROKE_KEY, false);
  };

  /** Build the stroke's OWN layer (legacy single-stroke payload while drawing). */
  const buildLayer = (
    e: InteractionEvent,
    strokeData: StrokeData,
    geom: { w: number; h: number; cx: number; cy: number },
  ): Layer => {
    const frame = e.activeFrame;
    const layersArray = frame.layers.order.map((id) => frame.layers.byId[id]);

    return LayerFactory.getNewLayer({
      name: LayerFactory.getNewLayerName(layersArray, 'Stroke'),
      type: 'vector',
      cx: geom.cx,
      cy: geom.cy,
      bounding: { w: geom.w, h: geom.h },
      visibleShape: asLocalShape({ x: 0, y: 0, w: geom.w, h: geom.h }),
      visible: true,
      opacity: params?.opacity ?? 1,
      strokeData,
      metadata: { sourceTool: 'brush' },
    });
  };

  /**
   * Place the stroke's REAL layer + open the silent transaction on the first
   * sample pair that can actually draw something. The layer starts CANVAS-SIZED
   * (`cx = cy = 0`, trajectory in plain canvas coordinates) — per-move
   * tightening is avoided: a stable full-canvas box keeps the stroke's vector
   * transient at fixed dims frame-to-frame, which is the precondition for the
   * engine's resident-transient reuse (mechanism B). The box is tightened once
   * at pointerup (`onEnd`, through the same silent track) so the committed
   * layer is snug in the layers panel / transforms / export (see geometry.ts).
   *
   * `cmd.place` is undoable and IS the gesture's only checkpoint — and it runs
   * at drag start, not pointerup: the layer the user watches grow IS the
   * committed layer, so nothing is created, renamed, or swapped at the end of
   * the gesture. Idempotent; returns false if there is nothing to place yet.
   */
  const ensureLayer = (e: InteractionEvent): boolean => {
    if (layerId) return true;
    if (!params) return false;

    const { w, h } = e.activeFrame.canvas;
    const layer = buildLayer(
      e,
      buildStrokeData(params, points, { x: 0, y: 0, w, h }, confinement ?? undefined),
      { w, h, cx: 0, cy: 0 },
    );

    // [PERF_MON] Isolate the drag-start hitch: this dispatch is the ONE store
    // commit of the whole gesture — ADD_LAYER → a synchronous React re-render
    // cascade the volatile drag path avoids on every subsequent move.
    // `syncMs` = the store dispatch itself; `paintMs` (double-rAF) = the full
    // stall until the browser next paints, i.e. React reconcile + the first
    // composite of the brand-new vector layer.
    const _t0 = PERF_MON ? performance.now() : 0;
    e.actions.executeCommand(P._CMD_PLACE_UID, { frameId: e.activeFrame.id, layer });
    layerId = layer.id;

    // silent: `cmd.place` already took the gesture's undo checkpoint.
    // Vector source redefinition → opt this gesture into Incremental Compositing.
    tx = new InteractionTransaction(e, { useIncreComp: true });
    tx.begin(true);

    if (PERF_MON) {
      const syncMs = performance.now() - _t0;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const paintMs = performance.now() - _t0;
          console.warn(
            `[Brush.dragStart] stage+txBegin sync=${syncMs.toFixed(2)}ms → next-paint=${paintMs.toFixed(2)}ms (canvas ${w}×${h})`,
          );
        }),
      );
    }
    return true;
  };

  /**
   * One trajectory sample: rope position + pressure composed from the input
   * dynamics. Pen pressure (or the mouse's pinned 1) drives the WIDTH lane
   * always; pressure-opacity and velocity dynamics fold into the same
   * effective pressure — pressure-opacity multiplies it into the per-point
   * ALPHA lane, velocity scales the width for fast-thin/slow-thick.
   *
   * `advanceVelocity` gates whether this sample advances the velocity
   * estimator's reference frame (last position/time). Sub-threshold micro
   * moves pass false: they advance the preview TAIL but feed the estimator
   * 0.1px-per-event pseudo speeds that would drag the smoothed velocity far
   * below the real hand speed — the estimator must only ever observe REAL
   * landed samples.
   */
  const samplePoint = (e: InteractionEvent, x: number, y: number, advanceVelocity = true): StrokePoint => {
    if (!params) return { x, y, pressure: 1 };
    const base = samplePressure(e);

    let velocityFactor = 1;
    if (params.velocity) {
      if (advanceVelocity) {
        const now = performance.now();
        const rawDt = Math.max(1, now - lastRawT);
        // Speed must be measured in SCREEN pixels — the hand moves the screen,
        // not the canvas. In canvas coordinates a zoomed-in view divides the
        // same physical gesture by the zoom (dynamics go dead at 300%) and a
        // zoomed-out view multiplies it (a flick bottoms out the width at
        // 33%). Multiply by camera zoom to recover the true hand speed.
        const dist = Math.hypot(x - lastRawX, y - lastRawY) * (e.activeFrame.camera.k || 1);
        lastRawX = x;
        lastRawY = y;
        lastRawT = now;
        if (!velocityReady) {
          // The very first pair of samples has no history to blend against —
          // seed the EMAs with the raw values and keep the stroke at full width.
          smoothDtMs = rawDt;
          smoothV = dist / rawDt / P.VELOCITY_REFERENCE_PXMS;
          velocityReady = true;
        } else {
          // Two-stage exponential smoothing: blend the time delta first (the
          // dominant noise source — event timing jitter), then the speed derived
          // from the blended delta. Both operate on the speed NORMALIZED by the
          // reference (1.0 = a deliberate hand) — the GIMP-style adaptive factor
          // min(SMOOTHING, normV) only differentiates speeds when its input is
          // a ratio; fed a raw px/ms value it saturates at SMOOTHING and
          // collapses into a fixed EMA.
          smoothDtMs = smoothDtMs * (1 - P.VELOCITY_SMOOTHING) + rawDt * P.VELOCITY_SMOOTHING;
          const normV = dist / smoothDtMs / P.VELOCITY_REFERENCE_PXMS;
          const f = Math.min(P.VELOCITY_SMOOTHING, Math.max(P.VELOCITY_MIN_NORM, normV));
          smoothV = smoothV * (1 - f) + normV * f;
        }
      }
      // Progressive fast-thin curve: the width factor is `1 / normalized
      // speed`, which is exactly 1 at the reference speed and decays smoothly
      // above it — there is no threshold step, so ordinary hand speeds sit on
      // the visible part of the curve instead of below a dead zone.
      velocityFactor =
        smoothV <= 1
          ? 1
          : Math.max(P.VELOCITY_MIN_FACTOR, 1 / smoothV);
    }

    const pressure = Math.min(1, base * velocityFactor);
    return { x, y, pressure, alpha: params.pressureOpacity ? pressure : 1 };
  };

  /** Stream the (tapered) trajectory into the preview layer's volatile slot. */
  const streamPreview = (e: InteractionEvent) => {
    if (!params || !layerId) return;
    const { w, h } = e.activeFrame.canvas;
    tx?.update(
      { strokeData: buildStrokeData(params, points, { x: 0, y: 0, w, h }, confinement ?? undefined) },
      'layer',
      layerId,
    );
  };

  /** Drop the staged preview layer (cancel / degenerate click). */
  const discardLayer = (e: InteractionEvent) => {
    tx?.abort();
    if (layerId) e.actions.removeLayers(e.activeFrame.id, [layerId]);
  };

  return {
    id: 'brush-stroke',
    priority: 145,

    test: (e) => {
      if (e.state.interaction.interactionMode !== 'craft') return false;
      const craft = e.state.interaction.signals[ACTIVE_CRAFT_KEY];
      if (craft !== 'brush') return false;

      const target = e.nativeEvent.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [data-handle], [data-gizmo-handle]')) return false;

      const frame = e.activeFrame;
      return e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
      });
    },

    onStart: (e) => {
      params = readPaintParams(e);
      confinement = e.activeFrame.confinement ?? undefined;

      // Every stroke commits into its OWN fresh collection layer — the
      // append-into-existing-collection merge was deliberately removed: it
      // required the resolved active host to be an unposed brush collection,
      // and the tangle of guards (triplet resolution, rotation/flip refusal,
      // implicit "whatever happens to be selected owns the stroke") bought
      // little over one-layer-per-stroke plus manual grouping in the layers
      // panel. The commit always creates the layer, inserted above the active
      // layer, so implicit z-order still follows the current selection.

      const p = e.point.canvas;
      points = [samplePoint(e, p.x, p.y)];
      ropeX = p.x;
      ropeY = p.y;
      anchorX = p.x;
      anchorY = p.y;
      lastRawX = p.x;
      lastRawY = p.y;
      lastRawT = performance.now();
      velocityReady = false;
      smoothV = 0;
      drawing = true;
      e.actions.setStateSignal(DRAWING_STROKE_KEY, true);
    },

    onMove: (e) => {
      if (!drawing || !params) return;
      // Crash-prevention guard (see MAX_STROKE_POINTS): once hit, the stroke
      // drawn so far just stops extending — no new samples are recorded.
      if (points.length >= P.MAX_STROKE_POINTS) return;

      const raw = e.point.canvas;

      // Rope-model stabilizer: the rope chases the pointer, moving only the
      // slack EXCESS, so tremor inside the slack never enters the stroke. The
      // slack is configured in screen px and divided by the camera zoom so the
      // felt smoothness is zoom-independent. With the stabilizer off the rope
      // IS the pointer.
      const slack = params.stabilizer > 0 ? params.stabilizer / (e.activeFrame.camera.k || 1) : 0;
      const rp = advanceRope({ x: ropeX, y: ropeY }, raw, slack);
      ropeX = rp.x;
      ropeY = rp.y;

      // Sampling guard (see MIN_SAMPLE_DISTANCE_PX): a new sample only lands
      // when the ROPE has travelled ≥ threshold from the last LANDED one (the
      // anchor), so sub-threshold displacement still accumulates across
      // events. Below the threshold, drag the trailing endpoint along as a
      // preview-only tail — no new sample, no quad growth, the last segment
      // follows the rope and the trail-tip gap never appears. (With a single
      // point nothing is painted yet, so the stroke origin stays put.)
      if (Math.hypot(rp.x - anchorX, rp.y - anchorY) < P.MIN_SAMPLE_DISTANCE_PX) {
        if (points.length >= 2) {
          // Preview tail only — do NOT advance the velocity reference frame
          // (see samplePoint: micro moves are estimator poison).
          points[points.length - 1] = samplePoint(e, rp.x, rp.y, false);
          streamPreview(e);
        }
        return;
      }

      points.push(samplePoint(e, rp.x, rp.y));
      anchorX = rp.x;
      anchorY = rp.y;

      // Full-canvas preview: the box is fixed for the whole drag, so a new
      // sample is just appended and only the growing trajectory is streamed —
      // no per-move tighten, no re-base, no box write. A single point draws
      // nothing (`cs_extrude` emits `pointCount - 1` quads), so wait for the
      // second sample before staging the preview layer.
      if (points.length < 2 || !ensureLayer(e) || !layerId) return;

      streamPreview(e);
    },

    onEnd: (e) => {
      if (!drawing || !params) {
        reset(e);
        return;
      }

      // The final sample always lands, whatever the sampling threshold says —
      // the stroke has to end exactly where the pointer was released (the RAW
      // release point, not the lagging rope: the tail is the one place where
      // exactness beats smoothing).
      const last = points[points.length - 1];
      const x = e.point.canvas.x;
      const y = e.point.canvas.y;
      if (x !== last.x || y !== last.y) {
        points.push(samplePoint(e, x, y));
      }

      const frame = e.activeFrame;

      // A click that never moved has no segment (`cs_extrude` emits
      // pointCount-1 quads), but the shader's degenerate-segment fallback
      // renders a coincident a==b pair as a full round dab — so a single tap
      // paints a dot by duplicating the point. The dab diameter follows the
      // sample's pressure (width = size × pressure), same as any segment.
      const strokePoints =
        points.length === 1 ? [points[0], { ...points[0] }] : points;
      // Selection intersection: clamp the committed box to the selection's
      // bounding rect (+1px AA margin) — coverage outside is zero, so those
      // texels would be allocated for nothing. The snapshot is frozen
      // (deep copy, re-based into the tightened box) so the committed stroke
      // is replay-self-sufficient: undo/redo re-renders it identically even
      // after the selection changes or clears.
      const clipRect = confinement
        ? { x: confinement.rect.x - 1, y: confinement.rect.y - 1, w: confinement.rect.w + 2, h: confinement.rect.h + 2 }
        : undefined;
      const tight = tightenStroke(strokePoints, params.size, frame.canvas, clipRect);

      if (!tight) {
        discardLayer(e);
        reset(e);
        return;
      }

      // The committed stroke payload: box-local trajectory + the CANVAS-SPACE
      // commit box (the commit command re-bases it into the collection
      // layer's local space) + the confinement snapshot re-based by the same
      // box-origin shift (PAIRING OBLIGATION — snapshot and points land in
      // one coordinate frame; never re-read the live selection here, undo
      // replay self-sufficiency). The taper envelope rides along because
      // `buildStrokeData` applies it.
      const strokeData = buildStrokeData(
        params,
        tight.points,
        tight.box,
        confinement ? e.geometry.polygon.translatePolygon(confinement, -tight.box.x, -tight.box.y) : undefined,
      );

      if (layerId && tx) {
        // Tighten and commit in one shot through the same silent track that
        // carried the in-progress trajectory — onto the layer cmd.place placed
        // at drag start. Pixel-invariant by construction (see geometry.ts), so
        // there is no jump between the last live frame and the committed
        // layer; the single legacy strokeData payload converts to the strokes
        // collection schema (one entry, box origin = layer-local origin).
        tx.update(
          {
            strokes: [{ ...strokeData, box: { x: 0, y: 0, w: tight.box.w, h: tight.box.h } }],
            bounding: { w: tight.box.w, h: tight.box.h },
            visibleShape: asLocalShape({ x: 0, y: 0, w: tight.box.w, h: tight.box.h }),
            cx: tight.cx,
            cy: tight.cy,
          },
          'layer',
          layerId,
        );
        tx.commit();
      } else {
        // Drag too small to have crossed the sampling threshold mid-gesture, so
        // no layer was ever placed — place the finished one directly.
        e.actions.executeCommand(P._CMD_PLACE_UID, {
          frameId: frame.id,
          layer: buildLayer(e, strokeData, {
            w: tight.box.w,
            h: tight.box.h,
            cx: tight.cx,
            cy: tight.cy,
          }),
        });
      }

      reset(e);
    },

    onCancel: (e) => {
      discardLayer(e);
      reset(e);
    },
  };
};
