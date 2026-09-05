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

import { InteractionHandler, InteractionEvent, GeometryService, Layer, Frame, MarkerData, ArrowMarkerData, LocalRect, asWorldRect, asLocalShape } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { InteractionTransaction } from '@opengpex/editor/stage/interaction/Transaction';
import { createTransformHandler, ResizeHandle } from '@opengpex/editor/stage/interaction/handlers/TransformHandler';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import type { CraftDrawerConfig } from '../../drawers/CraftDrawer/protocols';
import { MARKER_REGISTRY } from './registry';
import { _CMD_PLACE_UID, MarkerOverlayAPI } from './protocols';

/** Shared signal keys (cross-plugin constants) */
const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;
const DRAWING_MARKER_KEY = MarkerOverlayAPI.signals.drawingMarker;

/** Minimum drag distance (canvas-local px) below which a draw is discarded. */
const MIN_DRAG_PX = 8;

// ─── Draw Preview Store (module-level, cross-React-boundary) ─────────────────────
//
// Mirrors BrushOverlay's getStrokeBuffer/getStrokeVersion pattern: the draw
// handler writes the in-progress marker geometry here (canvas-local), and the
// SVG overlay component polls it via useFastSync + a version counter for a
// 60fps preview without React re-renders during the drag.

/** Live marker preview during a drag (null = not drawing). */
export interface MarkerDrawPreview {
  markerData: MarkerData;
  bounding: { w: number; h: number };
  /** Top-left of the bounding box in canvas-local space. */
  topLeftLocal: { x: number; y: number };
}

let _preview: MarkerDrawPreview | null = null;
let _previewVersion = 0;

export function getMarkerPreview(): MarkerDrawPreview | null {
  return _preview;
}

export function getMarkerPreviewVersion(): number {
  return _previewVersion;
}

function setMarkerPreview(next: MarkerDrawPreview | null): void {
  _preview = next;
  _previewVersion++;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────

/**
 * Finds the topmost hit layer that is a marker (`type:'vector' + markerData`).
 * Accepts a canvas-local point and converts to world via the geometry service.
 */
function findMarkerLayerAtPoint(geometry: GeometryService, frame: Frame, point: { x: number; y: number }): Layer | null {
  const worldPoint = geometry.space.localToWorld(point.x, point.y, frame);
  const hits = geometry.space.pickLayersAt(worldPoint, frame.layers);
  return hits.find((l: Layer) => l.type === 'vector' && !!l.markerData) || null;
}

/** Reads the active marker kind + pending style from CraftDrawer's config. */
function resolveMarkerData(e: { state: { pluginConfig: Record<string, unknown> } }): MarkerData | null {
  const config = e.state.pluginConfig[CraftDrawerAPI.configKey] as CraftDrawerConfig | undefined;
  const order = MARKER_REGISTRY.kinds();
  if (order.length === 0) return null;

  const kind = config?.activeMarkerKind ?? order[0];
  const def = MARKER_REGISTRY.get(kind);
  if (!def) return null;

  // Base defaults, then overlay any pending stroke/fill/cornerRadius the user chose.
  const base = def.defaults();
  const pending = config?.pendingMarkerData;
  if (pending) {
    if (pending.stroke) base.stroke = { ...base.stroke, ...pending.stroke };
    if (pending.fill) base.fill = { ...base.fill, ...pending.fill };
    // cornerRadius is rect-only; apply when the resolved kind supports it.
    if (typeof pending.cornerRadius === 'number' && base.kind === 'rect') {
      (base as { cornerRadius: number }).cornerRadius = pending.cornerRadius;
    }
  }
  return base;
}

// ─── MarkerMoveHandler ─────────────────────────────────────────────────────────

/**
 * MarkerMoveHandler: drag an existing marker layer to move it.
 *
 * Priority 155 (> MarkerDrawHandler 145): when pointerdown lands on an existing
 * marker, we MOVE it instead of starting a new draw. Both handlers are gated to
 * craft mode + activeCraft==='marker', so their priorities only matter relative
 * to each other (all text handlers 150–170 are text-gated). Uses
 * InteractionTransaction for undo support (same shape as TextMoveHandler).
 */
export const createMarkerMoveHandler = (): InteractionHandler => {
  let startCanvas = { x: 0, y: 0 };
  let startLayerPos = { x: 0, y: 0 };
  let targetLayerId: string | null = null;
  let tx: InteractionTransaction | null = null;

  return {
    id: 'marker-move',
    priority: 155,

    test: (e) => {
      if (e.state.interaction.interactionMode !== 'craft') return false;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'marker') return false;

      // Exclude UI element clicks (buttons, panels, resize handles).
      const target = e.nativeEvent.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [data-handle], [data-gizmo-handle]')) return false;

      const hitLayer = findMarkerLayerAtPoint(e.geometry, e.activeFrame, e.point.canvas);
      if (hitLayer) {
        targetLayerId = hitLayer.id;
        return true;
      }
      return false;
    },

    onStart: (e) => {
      if (!targetLayerId) return;
      const frame = e.activeFrame;
      const layer = frame.layers.byId[targetLayerId];
      if (!layer) return;

      // Select the marker so MarkerPanel binds to its properties.
      e.actions.setActiveLayer(frame.id, targetLayerId);

      startCanvas = { x: e.point.canvas.x, y: e.point.canvas.y };
      startLayerPos = { x: layer.cx, y: layer.cy };

      tx = new InteractionTransaction(e);
      tx.begin(false);
      e.actions.fast.setCursor('grabbing');
    },

    onMove: (e) => {
      if (!targetLayerId || !tx) return;
      const dx = e.point.canvas.x - startCanvas.x;
      const dy = e.point.canvas.y - startCanvas.y;
      tx.update({ cx: startLayerPos.x + dx, cy: startLayerPos.y + dy }, 'layer', targetLayerId);
    },

    onEnd: (e) => {
      if (tx) {
        tx.commit();
        tx = null;
      }
      targetLayerId = null;
      e.actions.fast.setCursor(null);
    },

    onCancel: () => {
      if (tx) {
        tx.abort();
        tx = null;
      }
      targetLayerId = null;
    },
  };
};

// ─── MarkerResizeHandler ───────────────────────────────────────────────────────

/**
 * MarkerResizeHandler: drag a corner/edge handle to resize the selected marker.
 *
 * Priority 160 (> MarkerMoveHandler 155 > MarkerDrawHandler 145): a pointerdown
 * on a resize handle must win over move / draw. Built on the shared
 * `createTransformHandler` (same infra as TextOverlay's text-resize), gated to
 * craft mode + activeCraft==='marker'. The handles are DOM dots rendered by the
 * overlay carrying `data-gizmo-handle`; `test` only fires when one is hit.
 *
 * onUpdate writes the new bounding + recentered cx/cy to the fast track. For
 * arrow markers the tail/head endpoints are rescaled proportionally so the
 * arrow tracks the box. Non-silent → a single undoable checkpoint per resize.
 */
export const createMarkerResizeHandler = (): InteractionHandler => {
  // Snapshot of the marker being resized, captured at gesture start.
  let resizeLayerId: string | null = null;
  let startMarkerData: MarkerData | null = null;
  let startBounding = { w: 0, h: 0 };
  // Orientation-aware resize snapshot (non-null only for rotated/mirrored markers):
  // the world centre and the local-axes rect at gesture start, used to map the
  // local resize result back to world cx/cy.
  let startCenter: { cx: number; cy: number } | null = null;
  let startLocalRect: { x: number; y: number; w: number; h: number } | null = null;

  /** Minimum bounding side (canvas px) so a marker can never collapse to 0. */
  const MIN_SIZE = 8;

  return createTransformHandler({
    id: 'marker-resize',
    priority: 160,

    test: (e) => {
      if (e.state.interaction.interactionMode !== 'craft') return null;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'marker') return null;

      const target = e.nativeEvent.target as HTMLElement;
      const handleEl = target.closest('[data-gizmo-handle]') as HTMLElement | null;
      if (!handleEl) return null;

      const handle = handleEl.dataset.gizmoHandle;
      if (!handle) return null;

      // Bind to the currently active marker layer.
      const frame = e.activeFrame;
      const activeId = frame.activeLayerId;
      const layer = activeId ? frame.layers.byId[activeId] : null;
      if (!layer || layer.type !== 'vector' || !layer.markerData) return null;

      resizeLayerId = layer.id;
      startMarkerData = layer.markerData;
      startBounding = { w: layer.bounding.w, h: layer.bounding.h };

      return { category: 'resize', handle: handle as ResizeHandle };
    },

    getInitialState: (e) => {
      const frame = e.activeFrame;
      const layer = resizeLayerId ? frame.layers.byId[resizeLayerId] : null;
      const canvas = frame.canvas;
      if (!layer) return { x: 0, y: 0, w: 0, h: 0 } as LocalRect;

      // Rotated / mirrored marker → work in the layer's LOCAL axes.
      // Origin is the bounding-box top-left, so the rect is simply (0,0,w,h);
      // the framework maps pointer deltas into this space via getOrientation.
      if (e.geometry.transform.isRotatedPose(layer)) {
        startCenter = { cx: layer.cx, cy: layer.cy };
        startLocalRect = { x: 0, y: 0, w: layer.bounding.w, h: layer.bounding.h };
        return startLocalRect as LocalRect;
      }

      // Axis-aligned marker → canvas-local rect (original behaviour, keeps
      // canvas clamping / edge snapping semantics unchanged).
      startCenter = null;
      startLocalRect = null;
      return {
        x: canvas.w / 2 + layer.cx - layer.bounding.w / 2,
        y: canvas.h / 2 + layer.cy - layer.bounding.h / 2,
        w: layer.bounding.w,
        h: layer.bounding.h,
      } as LocalRect;
    },

    // Opt into orientation-aware resize: after a canvas Rotate Left/Right the
    // marker layer carries a non-zero `rotation` while its `bounding` is
    // unchanged, so the resize math must run in the layer's own axes.
    // cx/cy are supplied so the framework can project the local rect back into
    // canvas space for rotation-aware edge snapping (snapEdgeRotated).
    getOrientation: (e) => {
      const layer = resizeLayerId ? e.activeFrame.layers.byId[resizeLayerId] : null;
      if (!layer) return null;
      return { rotation: layer.rotation, flip: layer.flip, cx: layer.cx, cy: layer.cy };
    },

    // Free-form resize (no aspect lock unless Shift, handled by the framework);
    // unclamped so markers can extend to the canvas edge like text boxes.
    getConstraints: () => ({ aspect: undefined, clamp: false }),

    onUpdate: (e, newRect, tx, context) => {
      if (!resizeLayerId || !startMarkerData) return;
      const frame = e.activeFrame;
      const canvas = frame.canvas;

      const finalW = Math.max(MIN_SIZE, newRect.w);
      const finalH = Math.max(MIN_SIZE, newRect.h);

      // Recover the new world centre.
      let newCx: number;
      let newCy: number;

      if (context.orientation && startCenter && startLocalRect) {
        // Orientation-aware path: newRect is in the layer's LOCAL axes. Recover
        // the world centre via the shared core helper, which uses the renderer's
        // own O = R × F convention (no hand-rolled sin/cos here on purpose).
        const worldCenter = e.geometry.space.localToWorldCenter(
          startCenter,
          startLocalRect,
          { x: newRect.x, y: newRect.y, w: finalW, h: finalH },
          context.orientation
        );
        newCx = worldCenter.x;
        newCy = worldCenter.y;
      } else {
        // Axis-aligned path: canvas-local rect → world cx/cy (unchanged).
        newCx = newRect.x + finalW / 2 - canvas.w / 2;
        newCy = newRect.y + finalH / 2 - canvas.h / 2;
      }

      // Rescale marker geometry that is stored in layer-local coords.
      let nextMarkerData: MarkerData = startMarkerData;
      if (startMarkerData.kind === 'arrow' && startBounding.w > 0 && startBounding.h > 0) {
        const sx = finalW / startBounding.w;
        const sy = finalH / startBounding.h;
        const src = startMarkerData as ArrowMarkerData;
        nextMarkerData = {
          ...src,
          tail: { x: src.tail.x * sx, y: src.tail.y * sy },
          head: { x: src.head.x * sx, y: src.head.y * sy },
        };
      }

      tx.update({
        cx: newCx,
        cy: newCy,
        bounding: { w: finalW, h: finalH },
        visibleShape: asLocalShape({ x: 0, y: 0, w: finalW, h: finalH }),
        markerData: nextMarkerData,
      }, 'layer', resizeLayerId);
    },

    onEnd: () => {
      resizeLayerId = null;
      startMarkerData = null;
      startCenter = null;
      startLocalRect = null;
    },

    onCancel: () => {
      resizeLayerId = null;
      startMarkerData = null;
      startCenter = null;
      startLocalRect = null;
    },
  });
};

// ─── MarkerDrawHandler ─────────────────────────────────────────────────────────

/**
 * MarkerDrawHandler: drag on empty canvas to draw a new marker.
 *
 * Priority 145 (< MarkerMoveHandler 155). Lifecycle:
 *   test:    craft mode + activeCraft==='marker' + NOT hitting an existing marker
 *   onStart: record drag start (canvas-local), set drawing signal
 *   onMove:  compute geometry via MARKER_REGISTRY[kind].computeFromDrag, write
 *            the live preview (rendered by the SVG overlay via core markerToSvg)
 *   onEnd:   finalize → LayerFactory.getNewLayer(type:'vector') → place command;
 *            discard if the drag is below MIN_DRAG_PX (mis-click guard)
 */
export const createMarkerDrawHandler = (): InteractionHandler => {
  let startCanvas = { x: 0, y: 0 };
  let markerData: MarkerData | null = null;
  let drawing = false;

  const clearPreview = (e: InteractionEvent) => {
    drawing = false;
    markerData = null;
    setMarkerPreview(null);
    e.actions.setStateSignal(DRAWING_MARKER_KEY, false);
  };

  return {
    id: 'marker-draw',
    priority: 145,

    test: (e) => {
      if (e.state.interaction.interactionMode !== 'craft') return false;
      if (e.state.interaction.signals[ACTIVE_CRAFT_KEY] !== 'marker') return false;

      const target = e.nativeEvent.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [data-handle], [data-gizmo-handle]')) return false;

      // Must be within the canvas and NOT over an existing marker (move wins).
      const frame = e.activeFrame;
      const inCanvas = e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
      });
      if (!inCanvas) return false;
      if (findMarkerLayerAtPoint(e.geometry, frame, e.point.canvas)) return false;
      return true;
    },

    onStart: (e) => {
      markerData = resolveMarkerData(e);
      if (!markerData) return;
      startCanvas = { x: e.point.canvas.x, y: e.point.canvas.y };
      drawing = true;
      e.actions.setStateSignal(DRAWING_MARKER_KEY, true);
    },

    onMove: (e) => {
      if (!drawing || !markerData) return;
      const def = MARKER_REGISTRY.get(markerData.kind);
      if (!def) return;

      const { bounding, centerLocal, patch } = def.computeFromDrag(
        { startX: startCanvas.x, startY: startCanvas.y, endX: e.point.canvas.x, endY: e.point.canvas.y },
        markerData as never,
        { shiftKey: e.keys.shift },
      );

      const previewData = { ...markerData, ...patch } as MarkerData;
      setMarkerPreview({
        markerData: previewData,
        bounding,
        topLeftLocal: { x: centerLocal.x - bounding.w / 2, y: centerLocal.y - bounding.h / 2 },
      });
    },

    onEnd: (e) => {
      if (!drawing || !markerData) {
        clearPreview(e);
        return;
      }

      const dx = e.point.canvas.x - startCanvas.x;
      const dy = e.point.canvas.y - startCanvas.y;
      const dist = Math.hypot(dx, dy);

      const def = MARKER_REGISTRY.get(markerData.kind);
      if (!def || dist < MIN_DRAG_PX) {
        // Mis-click / too-small drag → discard, no layer created.
        clearPreview(e);
        return;
      }

      const frame = e.activeFrame;
      const { bounding, centerLocal, patch } = def.computeFromDrag(
        { startX: startCanvas.x, startY: startCanvas.y, endX: e.point.canvas.x, endY: e.point.canvas.y },
        markerData as never,
        { shiftKey: e.keys.shift },
      );

      // Pixel-align the bounding box, then convert its center to world space.
      const alignedRect = e.geometry.snapping.snapRectToPixel(
        asWorldRect({ x: centerLocal.x - bounding.w / 2, y: centerLocal.y - bounding.h / 2, w: bounding.w, h: bounding.h }),
        frame.canvas,
      );
      const alignedCenterLocal = e.geometry.space.getRectCenter(alignedRect);
      const worldCenter = e.geometry.space.localToWorld(alignedCenterLocal.x, alignedCenterLocal.y, frame);

      const finalData = { ...markerData, ...patch } as MarkerData;

      const layersArray = frame.layers.order.map(id => frame.layers.byId[id]);
      const smartName = LayerFactory.getNewLayerName(layersArray, def.label);

      const markerLayer = LayerFactory.getNewLayer({
        name: smartName,
        type: 'vector',
        cx: worldCenter.x,
        cy: worldCenter.y,
        bounding: { w: alignedRect.w, h: alignedRect.h },
        visible: true,
        markerData: finalData,
      });

      e.actions.executeCommand(_CMD_PLACE_UID, {
        frameId: frame.id,
        layer: markerLayer,
      });

      clearPreview(e);
    },

    onCancel: (e) => {
      clearPreview(e);
    },
  };
};

