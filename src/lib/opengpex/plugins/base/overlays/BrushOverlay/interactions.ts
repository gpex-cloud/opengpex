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
import { tightenStroke } from './geometry';
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
}

/** Read the paint parameters out of the shared CraftDrawer / ColorOptions config. */
function readPaintParams(e: InteractionEvent): PaintParams {
  const craft = e.state.pluginConfig[CraftDrawerAPI.configKey] || {};
  const colorCfg = e.state.pluginConfig[ColorOptionsAPI.configKey] || {};

  return {
    // The full structured ColorValue, NOT a hex string: StrokeData carries the
    // wide-gamut currency all the way to `toWorkingLinearRgba` in the mapper.
    color: (colorCfg.pendingColor as ColorValue | undefined) ?? fromHex('#FFFFFF'),
    size: (craft.brushSize as number) ?? FALLBACK_BRUSH_SIZE,
    hardness: ((craft.brushHardness as number) ?? 80) / 100,
    opacity: ((craft.brushOpacity as number) ?? 100) / 100,
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

const buildStrokeData = (params: PaintParams, points: StrokePoint[]): StrokeData => ({
  points,
  color: params.color,
  size: params.size,
  hardness: params.hardness,
});

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

  const reset = (e: InteractionEvent) => {
    tx = null;
    layerId = null;
    points = [];
    params = null;
    drawing = false;
    e.actions.setStateSignal(DRAWING_STROKE_KEY, false);
  };

  /** Build the stroke layer at the given box-local geometry. */
  const buildLayer = (
    e: InteractionEvent,
    strokeData: StrokeData,
    geom: { w: number; h: number; cx: number; cy: number },
  ): Layer => {
    const frame = e.activeFrame;
    const layersArray = frame.layers.order.map((id) => frame.layers.byId[id]);
    const { w, h, cx, cy } = geom;

    return LayerFactory.getNewLayer({
      name: LayerFactory.getNewLayerName(layersArray, 'Stroke'),
      type: 'vector',
      cx,
      cy,
      bounding: { w, h },
      visibleShape: asLocalShape({ x: 0, y: 0, w, h }),
      visible: true,
      opacity: params?.opacity ?? 1,
      strokeData,
      metadata: { sourceTool: 'brush' },
    });
  };

  /**
   * Create the layer + open the silent transaction on the first sample that can
   * actually draw something. The in-drag layer wears a CANVAS-SIZED box
   * (`cx = cy = 0`, trajectory in plain canvas coordinates) — per-move
   * tightening is avoided: a stable full-canvas box keeps the
   * stroke's vector transient at fixed dims frame-to-frame, which is the
   * precondition for the engine's resident-transient reuse (mechanism B). The
   * box is tightened once at commit (`onEnd`) so the committed layer is still
   * snug in the layers panel / transforms / export (see geometry.ts).
   * Idempotent; returns false if there is nothing to place yet.
   */
  const ensureLayer = (e: InteractionEvent): boolean => {
    if (layerId) return true;
    if (!params) return false;

    const { w, h } = e.activeFrame.canvas;
    const geom = { w, h, cx: 0, cy: 0 };
    const layer = buildLayer(e, buildStrokeData(params, points), geom);

    // [PERF_MON] Isolate the drag-start hitch (see RCA §6): `executeCommand(place)`
    // is the ONE store commit of the whole gesture — history diff + ADD_LAYER +
    // activate → a synchronous React re-render cascade the volatile drag path
    // avoids on every subsequent move. `syncMs` = the store dispatch itself;
    // `paintMs` (double-rAF) = the full stall until the browser next paints, i.e.
    // React reconcile + the first composite of the brand-new vector layer.
    const _t0 = PERF_MON ? performance.now() : 0;
    e.actions.executeCommand(P._CMD_PLACE_UID, { frameId: e.activeFrame.id, layer });
    layerId = layer.id;

    // silent: `cmd.place` already took the gesture's undo checkpoint.
    tx = new InteractionTransaction(e);
    tx.begin(true);

    if (PERF_MON) {
      const syncMs = performance.now() - _t0;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const paintMs = performance.now() - _t0;
          console.warn(
            `[Brush.dragStart] place+txBegin sync=${syncMs.toFixed(2)}ms → next-paint=${paintMs.toFixed(2)}ms (canvas ${w}×${h})`,
          );
        }),
      );
    }
    return true;
  };

  /** Drop the layer created mid-gesture (cancel / degenerate click). */
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
      points = [{ x: e.point.canvas.x, y: e.point.canvas.y, pressure: samplePressure(e) }];
      drawing = true;
      e.actions.setStateSignal(DRAWING_STROKE_KEY, true);
    },

    onMove: (e) => {
      if (!drawing || !params) return;
      // Crash-prevention guard (see MAX_STROKE_POINTS): once hit, the stroke
      // drawn so far just stops extending — no new samples are recorded.
      if (points.length >= P.MAX_STROKE_POINTS) return;

      const last = points[points.length - 1];
      const x = e.point.canvas.x;
      const y = e.point.canvas.y;
      // Sampling guard (see MIN_SAMPLE_DISTANCE_PX): sub-pixel samples add
      // signature cost every frame without adding a pixel.
      if (Math.hypot(x - last.x, y - last.y) < P.MIN_SAMPLE_DISTANCE_PX) return;

      points.push({ x, y, pressure: samplePressure(e) });

      // Full-canvas layer: the box is fixed for the
      // whole drag, so a new sample is just appended and only the growing
      // trajectory is streamed — no per-move tighten, no re-base, no box write.
      // A single point draws nothing (`cs_extrude` emits `pointCount - 1` quads),
      // so wait for the second sample before placing the layer.
      if (points.length < 2 || !ensureLayer(e) || !layerId) return;

      tx?.update({ strokeData: buildStrokeData(params, points) }, 'layer', layerId);
    },

    onEnd: (e) => {
      if (!drawing || !params) {
        reset(e);
        return;
      }

      // The final sample always lands, whatever the sampling threshold says —
      // the stroke has to end exactly where the pointer was released.
      const last = points[points.length - 1];
      const x = e.point.canvas.x;
      const y = e.point.canvas.y;
      if (x !== last.x || y !== last.y) {
        points.push({ x, y, pressure: samplePressure(e) });
      }

      const frame = e.activeFrame;
      const tight = points.length >= 2 ? tightenStroke(points, params.size, frame.canvas) : null;

      // A click that never moved has no segment, so `cs_extrude` would emit no
      // geometry: discard it instead of leaving an invisible empty layer behind
      // (same spirit as marker-draw's mis-click guard). Round caps — which would
      // let a single tap paint a dab — are not part of the ribbon shader yet.
      if (!tight) {
        discardLayer(e);
        reset(e);
        return;
      }

      const strokeData = buildStrokeData(params, tight.points);
      const geom = { w: tight.box.w, h: tight.box.h, cx: tight.cx, cy: tight.cy };

      if (layerId && tx) {
        // Tighten and commit in one shot. Pixel-invariant by construction
        // (see geometry.ts), so there is no jump between the last preview
        // frame and the committed layer.
        tx.update(
          {
            strokeData,
            bounding: { w: geom.w, h: geom.h },
            visibleShape: asLocalShape({ x: 0, y: 0, w: geom.w, h: geom.h }),
            cx: geom.cx,
            cy: geom.cy,
          },
          'layer',
          layerId,
        );
        tx.commit();
      } else {
        // Drag too small to have crossed the sampling threshold mid-gesture, so
        // no layer was ever previewed — place the finished one directly.
        e.actions.executeCommand(P._CMD_PLACE_UID, {
          frameId: frame.id,
          layer: buildLayer(e, strokeData, geom),
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
