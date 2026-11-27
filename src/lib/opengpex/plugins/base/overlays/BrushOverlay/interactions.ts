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

import { InteractionHandler, InteractionEvent, Layer, StrokeData, StrokePoint, asLocalShape } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { fromHex, type ColorValue } from '@opengpex/editor/core/engine/color';
import { VECTOR_TRANSIENT_KEY } from '@opengpex/editor/core/state/volatile/vector';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import { ColorOptionsAPI } from '../../options/ColorOptions/protocols';
import { advanceRope, applyTaper, densifyTaperZones, IncrementalStrokeTrajectory, taperZones, tightenStroke } from './geometry';
import * as P from './protocols';

let ephemeralPreviewSeq = 0;

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
 * their reported pressure. A 0 report needs two different answers: at gesture
 * START it is the digitizer's first-contact artifact, so a small fixed
 * fallback seeds the stroke (0 would collapse the first tip segment to zero
 * width); MID-STROKE it is a hover/grip artifact, so the LAST known good
 * pressure is reused instead of snapping back to a constant (which would
 * jump the width every time the hardware dropped the signal).
 */
const makeSamplePressure = () => {
  let lastPenPressure = P.PEN_INITIAL_FALLBACK_PRESSURE;
  return (rawPressure: number, pointerType: string, isStart: boolean): number => {
    if (pointerType !== 'pen' && pointerType !== 'touch') return 1;
    if (rawPressure > 0) {
      const clamped = Math.min(1, rawPressure);
      lastPenPressure = clamped;
      return clamped;
    }
    return isStart ? P.PEN_INITIAL_FALLBACK_PRESSURE : lastPenPressure;
  };
};

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
  // Shallow-copy `points` so Immer/Redux freezing committed layer payloads
  // never freezes the mutable trajectory array still being extended on move
  // (when taper is off, densifyTaperZones/applyTaper return their input as-is).
  const srcPoints = [...points];
  const { head, tail } = taperZones(
    srcPoints,
    params.size * P.TAPER_LENGTH_PER_SIZE,
    params.taperHead,
    params.taperTail,
  );
  return {
    points: applyTaper(
      densifyTaperZones(srcPoints, head, tail, P.MIN_SAMPLE_DISTANCE_PX),
      head,
      tail,
      params.pressureOpacity === true,
      P.TAPER_MIN_TIP_RATIO,
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
  let previewLayerId: string | null = null;
  let insertAfterLayerId: string | undefined;
  let strokeBuf: IncrementalStrokeTrajectory | null = null;
  let params: PaintParams | null = null;
  let drawing = false;
  // Pen pressure tracker — recreated per gesture so the "last known good
  // pressure" never leaks across strokes.
  let samplePressure = makeSamplePressure();
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
    previewLayerId = null;
    insertAfterLayerId = undefined;
    strokeBuf = null;
    params = null;
    drawing = false;
    confinement = undefined;
    samplePressure = makeSamplePressure();
    e.actions.setStateSignal(DRAWING_STROKE_KEY, false);
  };

  /** Build the persisted stroke layer (committed once on pointer-up). */
  const buildCommittedLayer = (
    e: InteractionEvent,
    strokeData: StrokeData,
    geom: { w: number; h: number; cx: number; cy: number },
  ): Layer => {
    const frame = e.activeFrame;

    return LayerFactory.createLayer('vector', {
      name: e.layers.factory.getNewLayerNameFor(frame, 'Stroke'),
      cx: geom.cx,
      cy: geom.cy,
      bounding: { w: geom.w, h: geom.h },
      visibleShape: asLocalShape({ x: 0, y: 0, w: geom.w, h: geom.h }),
      visible: true,
      opacity: params?.opacity ?? 1,
      strokes: [{ ...strokeData, box: { x: 0, y: 0, w: geom.w, h: geom.h } }],
      metadata: { sourceTool: 'brush' },
    });
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
   *
   * `isStart` feeds the pressure tracker's first-contact fallback (only the
   * gesture's very first sample is a start). `pressureOverride` carries the
   * per-sub-event pressure from a coalesced batch (each historical event
   * reports its own hardware pressure); absent, the live pointer pressure
   * is used.
   */
  const samplePoint = (
    e: InteractionEvent,
    x: number,
    y: number,
    advanceVelocity = true,
    isStart = false,
    pressureOverride?: number,
  ): StrokePoint => {
    if (!params) return { x, y, pressure: 1 };
    const base = samplePressure(
      pressureOverride ?? e.pointer.pressure,
      e.pointer.pointerType,
      isStart,
    );

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

  /** Stream the O(1) incremental trajectory into the engine-neutral ephemeral preview slot. */
  const streamPreview = (e: InteractionEvent, previewTail?: StrokePoint) => {
    if (!params || !previewLayerId || !strokeBuf) return;
    const { w, h } = e.activeFrame.canvas;
    const { points, solidifiedCount } = strokeBuf.buildPointsView(previewTail);
    const previewLayer: Layer = {
      ...LayerFactory.createLayer('vector', {
        name: 'Brush Preview',
        cx: 0,
        cy: 0,
        bounding: { w, h },
        visibleShape: asLocalShape({ x: 0, y: 0, w, h }),
        visible: true,
        opacity: params.opacity,
        blendMode: 'source-over',
        strokeData: {
          points,
          solidifiedCount,
          box: { x: 0, y: 0, w, h },
          color: params.color,
          size: params.size,
          hardness: params.hardness,
          antiAliased: params.antiAliased,
          confinement: confinement ?? undefined,
        },
      }),
      id: previewLayerId,
    };
    e.actions.fast.setTransient(VECTOR_TRANSIENT_KEY, {
      frameId: e.activeFrame.id,
      layer: previewLayer,
      insertAfterLayerId,
    });
    // Stabilizer pull-string guide: publish the pointer↔rope gap so the
    // overlay can draw the lag while dragging (only meaningful when the
    // stabilizer is actually on).
    if (params.stabilizer > 0) {
      e.actions.fast.setTransient(P.BRUSH_STABILIZER_GUIDE_KEY, {
        pointerCanvas: e.point.canvas,
        ropeCanvas: { x: ropeX, y: ropeY },
      });
    }
  };

  /** Clear the ephemeral preview channel and abort the silent interaction transaction. */
  const clearPreview = (e: InteractionEvent) => {
    e.actions.fast.setTransient(VECTOR_TRANSIENT_KEY, null);
    e.actions.fast.setTransient(P.BRUSH_STABILIZER_GUIDE_KEY, null);
    tx?.abort();
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
      previewLayerId = `__ephemeral_vector__-${++ephemeralPreviewSeq}`;
      insertAfterLayerId = e.activeFrame.activeLayerId ?? undefined;
      samplePressure = makeSamplePressure();
      const maxTaperLen = params.size * P.TAPER_LENGTH_PER_SIZE;
      strokeBuf = new IncrementalStrokeTrajectory(
        maxTaperLen * params.taperHead,
        maxTaperLen * params.taperTail,
        params.pressureOpacity === true,
        P.MIN_SAMPLE_DISTANCE_PX,
        P.TAPER_MIN_TIP_RATIO,
      );

      const p = e.point.canvas;
      strokeBuf.push(samplePoint(e, p.x, p.y, true, true));
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

      tx = new InteractionTransaction(e, { useIncreComp: true });
      tx.begin(true);
      streamPreview(e);
      e.actions.setStateSignal(DRAWING_STROKE_KEY, true);
    },

    onMove: (e) => {
      if (!drawing || !params || !strokeBuf) return;

      // One sample step: advance the rope, land the sample when it escapes
      // the sampling threshold, otherwise keep it as a transient preview
      // tail. Re-entry guarded so a coalesced batch cannot overshoot the
      // trajectory's hard point cap (a StrokeRenderer ring-overflow guard).
      let pendingPreviewTail: StrokePoint | undefined;
      const stepSample = (canvasX: number, canvasY: number, pressureOverride?: number) => {
        if (!params || !strokeBuf) return;
        if (strokeBuf.length >= P.MAX_STROKE_POINTS) return;
        const raw = { x: canvasX, y: canvasY };
        const slack = params.stabilizer > 0 ? params.stabilizer / (e.activeFrame.camera.k || 1) : 0;
        const rp = advanceRope({ x: ropeX, y: ropeY }, raw, slack);
        ropeX = rp.x;
        ropeY = rp.y;

        if (Math.hypot(rp.x - anchorX, rp.y - anchorY) < P.MIN_SAMPLE_DISTANCE_PX) {
          if (strokeBuf.length >= 1) {
            pendingPreviewTail = samplePoint(e, rp.x, rp.y, false, false, pressureOverride);
          }
          return;
        }

        strokeBuf.push(samplePoint(e, rp.x, rp.y, true, false, pressureOverride));
        anchorX = rp.x;
        anchorY = rp.y;
        pendingPreviewTail = undefined;
      };

      // High-frequency input: a 240Hz+ digitizer batches several historical
      // events into one pointermove. Feeding them all keeps the rope and the
      // velocity estimator sampling at true input rate instead of the batch
      // rate. Each sub-event's canvas position is recovered by its SCREEN
      // offset from the batch's final event (whose canvas position the
      // interaction layer already computed) divided by camera zoom — valid
      // because the stage projection is a pure translate+scale.
      const native = e.nativeEvent;
      // Duck-typed on purpose: `instanceof PointerEvent` fails in environments
      // that shadow or omit the global (some WebViews, test harnesses) even
      // though the event carries the real coalesced feed — the function check
      // is the only reliable capability test.
      const coalesced =
        typeof (native as Partial<PointerEvent>).getCoalescedEvents === 'function'
          ? (native as PointerEvent).getCoalescedEvents()
          : null;
      if (coalesced && coalesced.length > 1) {
        const k = e.activeFrame.camera.k || 1;
        for (const ev of coalesced) {
          const dxScreen = ev.clientX - native.clientX;
          const dyScreen = ev.clientY - native.clientY;
          stepSample(e.point.canvas.x + dxScreen / k, e.point.canvas.y + dyScreen / k, ev.pressure);
        }
      } else {
        stepSample(e.point.canvas.x, e.point.canvas.y);
      }

      // One preview stream per batch, carrying at most the last sub-threshold tail.
      streamPreview(e, pendingPreviewTail);
    },

    onEnd: (e) => {
      if (!drawing || !params || !strokeBuf) {
        clearPreview(e);
        reset(e);
        return;
      }

      if (params.stabilizer > 0) {
        // Stabilizer on: end at the rope — the last point the drag preview
        // actually painted — so the committed stroke is continuous with the
        // final preview frame (connecting to the raw release would snap a
        // hard straight line across the whole slack distance). The raw
        // release point is deliberately discarded here; see
        // MIN_SAMPLE_DISTANCE_PX's JSDoc for the contract.
        const last = strokeBuf.lastPoint;
        if (!last || Math.hypot(ropeX - last.x, ropeY - last.y) > 0.5) {
          strokeBuf.push(samplePoint(e, ropeX, ropeY, false));
        }
      } else {
        const last = strokeBuf.lastPoint;
        const x = e.point.canvas.x;
        const y = e.point.canvas.y;
        if (!last || x !== last.x || y !== last.y) {
          strokeBuf.push(samplePoint(e, x, y));
        }
      }

      const frame = e.activeFrame;
      const rawPoints = strokeBuf.rawPoints;
      const strokePoints =
        rawPoints.length === 1 ? [rawPoints[0], { ...rawPoints[0] }] : rawPoints;

      const featherPad = confinement?.feather ? Math.ceil(confinement.feather) : 0;
      const clipRect = confinement
        ? {
          x: confinement.rect.x - featherPad - 1,
          y: confinement.rect.y - featherPad - 1,
          w: confinement.rect.w + 2 * featherPad + 2,
          h: confinement.rect.h + 2 * featherPad + 2,
        }
        : undefined;
      const tight = tightenStroke(strokePoints, params.size, frame.canvas, clipRect);

      clearPreview(e);

      if (!tight) {
        reset(e);
        return;
      }

      const strokeData = buildStrokeData(
        params,
        tight.points,
        tight.box,
        confinement ? e.geometry.polygon.translatePolygon(confinement, -tight.box.x, -tight.box.y) : undefined,
      );

      e.actions.executeCommand(P._CMD_PLACE_UID, {
        frameId: frame.id,
        layer: buildCommittedLayer(e, strokeData, {
          w: tight.box.w,
          h: tight.box.h,
          cx: tight.cx,
          cy: tight.cy,
        }),
      });

      reset(e);
    },

    onCancel: (e) => {
      clearPreview(e);
      reset(e);
    },
  };
};
