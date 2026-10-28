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

import { EditorCommand, EditorContextValue, type PenPathData } from '@opengpex/editor/core/types';
import { writeFrameDraft } from '@opengpex/editor/core/state/drafts';
import { LayerFactory } from '@opengpex/editor/core/layer/factory';
import { asLocalRect, asLocalPolygon, asLocalShape, type LocalPolygon } from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { penBoundsPad, rebasePenDataToBounds } from './pen/transform';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import type { ColorValue } from '@opengpex/editor/core/engine/color';
import * as P from './protocols';
import { committableSubpaths, draftToPenPathData } from './pen/penState';
import { flattenSubPath, penDataToFrameSubPaths, ringsToPenSubPathsBudgeted } from './pen/geometry';
import {
  composePenToolState,
  getPenCommittedSelection,
  getPenDraft,
  publishPenPhase,
  replacePenDraft,
  setPenCommittedSelection,
  PEN_TOOL_ID,
} from './interactions';
import {
  srgbHexToColorValue,
  PEN_DEFAULT_FILL_HEX,
  L0_OPS,
  type PenShapeStylePayload,
} from './contribution';

// ─── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Clears the frame's pen draft inside the CALLING command's undoable step:
 * the caller has already triggered (or will trigger) the step via its own
 * undoable command execution, and both writes land between the same
 * pre-execution checkpoint and the next commit — undo restores the mask /
 * selection / shape TOGETHER with the draft (the "undo brings the path
 * back" contract).
 */
function clearPenDraftInStep(ctx: EditorContextValue, frameId: string): void {
  const frame = ctx.state.frames.byId[frameId];
  if (!frame?.drafts?.[PEN_TOOL_ID]) return;
  ctx.actions.updateFrame(frameId, writeFrameDraft(frame, PEN_TOOL_ID, null));
}

/**
 * Flattens the session's committable subpaths (frame-local) to point rings.
 * Closed subpaths become closed rings; open subpaths become polylines (they
 * still mask fine as degenerate-thin rings — same as the lasso's open shape —
 * but the primary mask path is closed rings).
 */
function flattenDraftRings(ctx: EditorContextValue): { closed: { x: number; y: number }[][]; open: { x: number; y: number }[][] } {
  const ops = ctx.geometry.bezier;
  const frame = ctx.activeFrame;
  const closed: { x: number; y: number }[][] = [];
  const open: { x: number; y: number }[][] = [];
  if (!frame) return { closed, open };
  const state = composePenToolState(frame);
  for (const sub of committableSubpaths(state)) {
    const pts = flattenSubPath(sub, ops, P.PEN_FLATTEN_TOLERANCE_DOC_PX);
    if (!pts) continue;
    (sub.closed ? closed : open).push(pts);
  }
  return { closed, open };
}

/**
 * Orders rings OUTER-FIRST: containment-depth ascending, stable within a
 * depth. Downstream selection-slot consumers (boolean ops via `poly-clip`,
 * layer intersection) require every hole to appear AFTER its container; the
 * pen session yields rings in DRAW order, and a hole drawn before its
 * outline would otherwise be misread as an island. Depth (how many other
 * rings contain this one) increases monotonically into the nesting, so a
 * stable sort by depth satisfies the contract for any containment
 * structure. Even-odd consumers (ants, masks) are order-agnostic anyway.
 */
export function orderRingsOuterFirst(rings: { x: number; y: number }[][]): { x: number; y: number }[][] {
  const contains = (outer: { x: number; y: number }[], pt: { x: number; y: number }): boolean => {
    let inside = false;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const xi = outer[i].x, yi = outer[i].y;
      const xj = outer[j].x, yj = outer[j].y;
      if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  const depth = rings.map((r) => {
    if (r.length === 0) return 0;
    let count = 0;
    for (const other of rings) {
      if (other !== r && other.length >= 3 && contains(other, r[0])) count++;
    }
    return count;
  });
  return rings
    .map((r, i) => ({ r, d: depth[i], i }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((e) => e.r);
}

function toLocalPolygon(rings: { x: number; y: number }[][]): LocalPolygon | null {
  const usable = orderRingsOuterFirst(rings.filter((r) => r.length >= 3));
  if (usable.length === 0) return null;
  const bounds = asLocalRect(ringsBounds(usable));
  return asLocalPolygon(usable as LocalPolygon['rings'], bounds);
}

function ringsBounds(rings: { x: number; y: number }[][]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ─── Commands ──────────────────────────────────────────────────────────────────

/**
 * cmd.pen_apply_mask — "Apply as Mask": flattens the session's closed rings
 * (0.25 doc-px tolerance), converts them to an evenodd path shape, projects
 * frame-local → active-layer-local, and appends a feathered VectorMask.
 *
 * Deliberately commits LINEAR pathData, not cubics: the whole path-mask
 * ecosystem (parsePathDataToRings, boolean clipping, polygonToShape) speaks
 * M/L/Z only, and its parser silently drops C/Q commands — so curve data must
 * never enter the mask pipeline unflattened.
 *
 * undoable: true → one mask application is one undo step.
 */
const applyMaskCommand: EditorCommand<{ feather?: number }, void> = {
  id: P.CMD_APPLY_MASK,
  name: 'Apply Pen Path as Mask',
  undoable: true,
  execute: (ctx: EditorContextValue, payload?: { feather?: number }) => {
    const frame = ctx.activeFrame;
    const layer = ctx.activeLayer;
    if (!frame) return;
    if (!layer) {
      ctx.actions.setInteraction({ hud: { message: 'Select a layer first', type: 'error' } });
      return;
    }
    if (layer.locked) {
      ctx.actions.setInteraction({ hud: { message: 'Layer is locked', type: 'error' } });
      return;
    }

    const { closed, open } = flattenDraftRings(ctx);
    const rings = [...closed, ...open];
    const poly = toLocalPolygon(rings);
    if (!poly) {
      ctx.actions.setInteraction({ hud: { message: 'No closed path to apply', type: 'error' } });
      return;
    }

    // Ring coordinates are frame-local; the mask must land in layer-local.
    const layerPoly = ctx.geometry.polygon.frameLocalToLayerLocal(poly, frame, layer);
    const shape = ctx.geometry.polygon.polygonToShape(layerPoly);
    const feather = payload?.feather ?? 0;

    ctx.layers.updateLayer(frame.id, (tx) => {
      tx.edit(layer.id).applyMask(shape, { feather });
    });
    // Commit semantics: the draft is cleared INSIDE this same undoable step
    // (undo restores the mask AND the path together — "undo brings the path
    // back"). The pen tool exits so the user lands on the canvas to inspect
    // the result.
    clearPenDraftInStep(ctx, frame.id);
    publishPenPhase(ctx.actions.setStateSignal, 'idle');
    ctx.actions.executeCommand(CraftDrawerAPI.commands.deactivate.uid);
  },
} as EditorCommand<{ feather?: number }, void>;

/**
 * cmd.pen_to_selection — "Convert to Selection": flattens the session's
 * closed rings into a LocalPolygon and stores it as the frame's selection
 * (the lasso slot — an irregular polygon like any other), then shows the
 * marching ants by switching to clip mode with latestClipTool='lasso'.
 *
 * undoable: the selection write and the same-step draft clear ride the
 * frame's undoable update path (undo restores selection AND draft).
 */
const toSelectionCommand: EditorCommand<void, void> = {
  id: P.CMD_TO_SELECTION,
  name: 'Convert Pen Path to Selection',
  undoable: true,
  execute: (ctx: EditorContextValue) => {
    const frame = ctx.activeFrame;
    if (!frame) return;

    const { closed, open } = flattenDraftRings(ctx);
    // Open subpaths close implicitly (SVG fill semantics) — the same rule
    // the mask and shape-layer targets apply, so a frozen polyline is a
    // selectable region on every commit path.
    const poly = toLocalPolygon([...closed, ...open]);
    if (!poly) {
      ctx.actions.setInteraction({ hud: { message: 'No path to select', type: 'error' } });
      return;
    }

    ctx.actions.setInteraction({ interactionMode: 'clip' });
    // The selection lands in the lasso slot — an irregular polygon like any
    // other, consumed by the existing selection machinery and re-importable
    // via Apply-as-Bezier. The draft clears in this same undoable step (undo
    // restores the selection AND the path together).
    ctx.actions.updateFrame(frame.id, { latestClipTool: 'lasso', confinement: poly });
    clearPenDraftInStep(ctx, frame.id);
    publishPenPhase(ctx.actions.setStateSignal, 'idle');
  },
} as EditorCommand<void, void>;

/**
 * cmd.pen_apply_as_bezier — "Apply as Bezier": converts the frame's
 * current selection (`latestClipTool` slot) into an editable pen draft via
 * Schneider fitting (1.0 doc-px default). The draft replaces any existing
 * one — a non-empty draft requires a second press within the confirm
 * window (HUD-confirmed destructive swap).
 *
 * undoable: true → the conversion is one history step; undo restores the
 * previous draft (or no draft).
 */
const applyAsBezierCommand: EditorCommand<void, void> = {
  id: P.CMD_APPLY_AS_BEZIER,
  name: 'Apply Selection as Bezier',
  undoable: true,
  execute: (ctx: EditorContextValue) => {
    const frame = ctx.activeFrame;
    if (!frame) return;

    const box = getClipBox(frame);
    if (!box || box.rings.length === 0) {
      ctx.actions.setInteraction({ hud: { message: 'No selection to convert', type: 'error' } });
      return;
    }

    // HUD-confirmed swap: the first press while a draft is alive only arms
    // the confirm; the second press (however much later) performs the swap.
    if (getPenDraft(frame) !== null && !applyConfirmArmed) {
      applyConfirmArmed = true;
      ctx.actions.notifyHUD('Applying replaces the current pen draft — press again to confirm', 'error');
      return;
    }
    applyConfirmArmed = false;

    // Land the user in the pen tool first: the conversion's whole point is
    // anchor editing, and the phase signal the activation publishes is what
    // the panel keys off.
    ctx.actions.executeCommand(CraftDrawerAPI.commands.activatePen.uid);

    // Anchor budget (pen panel slider, persisted in the CraftDrawer config):
    // the fit tolerance adapts until the draft fits within the budget, so a
    // dense AI contour (thousands of vertices) converts to an editable
    // anchor count instead of freezing the overlay.
    const craftConfig = (ctx.state.pluginConfig[CraftDrawerAPI.configKey] ?? {}) as { penAnchorBudget?: number };
    const budget = craftConfig.penAnchorBudget ?? P.PEN_IMPORT_DEFAULT_ANCHOR_BUDGET;

    const fit = ringsToPenSubPathsBudgeted(box.rings, ctx.geometry.bezier, budget, P.PEN_IMPORT_FIT_TOLERANCE_DOC_PX);
    const subs = fit.subs;
    if (subs.length === 0) {
      ctx.actions.setInteraction({ hud: { message: 'Selection is too small to convert', type: 'error' } });
      return;
    }

    // Destructive swap: the replaced draft dies with this same undoable step
    // (the HUD confirm above owns the warning; undo restores the old draft).
    replacePenDraft(ctx.actions, frame, { subpaths: subs });
    ctx.actions.notifyHUD(
      `Converted to ${fit.anchorCount} anchors (from ${fit.vertexCount} vertices)`,
      'info',
    );
  },
} as EditorCommand<void, void>;

/** Confirm latch for the destructive draft swap (armed by the first press). */
let applyConfirmArmed = false;

/**
 * cmd.pen_update_data — patches (or clears) a committed layer's `penData`.
 * Undoable; used by the edit-side Delete-key anchor deletion and any future
 * panel edits on committed paths.
 */
const updatePenDataCommand: EditorCommand<{ frameId: string; layerId: string; penData: PenPathData | null }, void> = {
  id: P.CMD_UPDATE_PEN_DATA,
  name: 'Update Pen Path Data',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layerId: string; penData: PenPathData | null }) => {
    const frame = ctx.state.frames.byId[payload.frameId];
    const layer = frame?.layers.byId[payload.layerId];
    if (!frame || !layer || layer.type !== 'vector') return;
    ctx.actions.updateLayer(frame.id, layer.id, { penData: payload.penData ?? undefined });
  },
};

/**
 * cmd.pen_cancel_draft — "Clear Draft": clears the frame's pen draft.
 * Undoable (undo restores the whole draft), so the press-and-hold
 * destructive confirmation the panel used to require is retired — a
 * mistake is one Cmd+Z away.
 */
const cancelDraftCommand: EditorCommand<void, void> = {
  id: P.CMD_CANCEL_DRAFT,
  name: 'Clear Pen Draft',
  undoable: true,
  execute: (ctx: EditorContextValue) => {
    const frame = ctx.activeFrame;
    if (!frame) return;
    if (!getPenDraft(frame)) return;
    replacePenDraft(ctx.actions, frame, null);
    publishPenPhase(ctx.actions.setStateSignal, 'idle');
  },
} as EditorCommand<void, void>;

/**
 * cmd.pen_create_shape — "Create Shape Layer": commits the session's paths as
 * a NEW `type:'vector'` layer carrying `penData` + `penStyle`, rendered by the
 * engine's face renderer (Phase 3). Open subpaths participate with SVG
 * auto-close semantics (a 2-anchor sliver has zero area and contributes
 * nothing visible). Anchors are shifted so the layer-local origin sits at the
 * flattened path bounds' top-left; `cx/cy` land at the box center in WORLD
 * space (marker `cmd.place` convention).
 *
 * undoable: true → one shape creation is one undo step. Session ends on
 * success (endDraftSession): the fence lifts, phase returns to idle.
 */
const createShapeCommand: EditorCommand<PenShapeStylePayload | undefined, void> = {
  id: P.CMD_CREATE_SHAPE,
  name: 'Create Pen Shape Layer',
  undoable: true,
  execute: (ctx: EditorContextValue, payload?: PenShapeStylePayload) => {
    const frame = ctx.activeFrame;
    if (!frame) return;

    const state = composePenToolState(frame);
    const subs = committableSubpaths(state);
    if (subs.length === 0) {
      ctx.actions.setInteraction({ hud: { message: 'No path to commit', type: 'error' } });
      return;
    }

    // Flatten (frame-local == layer-local for the DRAFT) to measure bounds.
    const rings: { x: number; y: number }[][] = [];
    for (const sub of subs) {
      const closedSub = { ...sub, closed: true };
      const pts = flattenSubPath(closedSub, L0_OPS, P.PEN_FLATTEN_TOLERANCE_DOC_PX);
      if (pts && pts.length >= 3) rings.push(pts);
    }
    if (rings.length === 0) {
      ctx.actions.setInteraction({ hud: { message: 'Path is too small for a shape layer', type: 'error' } });
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) {
      for (const pt of ring) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
      }
    }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);

    const style: PenShapeStylePayload = {
      fill: payload?.fill ?? srgbHexToColorValue(PEN_DEFAULT_FILL_HEX),
      stroke: payload?.stroke ?? null,
    };
    // The boundary band extends HALF the stroke width beyond the path bounds
    // (round joins keep every band vertex within hw of the path; fill-only
    // faces keep a 0.75px AA hairline rim) — the layer's bounding must cover
    // it or the GPU transient (sized from the bounding) clips the outer band
    // on all four sides. The anchors shift by the same pad so the layer-local
    // origin stays the INFLATED bounds' top-left; symmetric padding keeps the
    // center (and therefore cx/cy) unchanged.
    const bandHalf = style.stroke ? style.stroke.width / 2 : 0.375;
    const pad = Math.ceil(bandHalf + 1); // +1px AA headroom

    // Shift anchors so the payload is layer-local (origin = inflated bounds top-left).
    const penData: PenPathData = {
      paths: subs.map((sub) => ({
        closed: sub.closed,
        anchors: sub.anchors.map((a) => ({ ...a, x: a.x - minX + pad, y: a.y - minY + pad })),
      })),
    };

    const worldCenter = ctx.geometry.space.localToWorld(minX + w / 2, minY + h / 2, frame);
    const layersArray = frame.layers.order.map((id) => frame.layers.byId[id]);
    const layer = LayerFactory.getNewLayer({
      name: LayerFactory.getNewLayerName(layersArray, 'Pen Shape'),
      type: 'vector',
      cx: worldCenter.x,
      cy: worldCenter.y,
      bounding: { w: w + pad * 2, h: h + pad * 2 },
      visible: true,
      penData,
      penStyle: style,
      metadata: { sourceTool: 'pen' },
    });

    const below = LayerFactory.resolveActiveHostLayer(frame);
    const insertAt = LayerFactory.getInsertIndexAbove(frame, below?.id);
    ctx.layers.addLayer(frame.id, layer, insertAt);
    ctx.layers.activate(frame.id, layer.id);

    // Same-step draft clear: undo restores the shape layer AND the path.
    clearPenDraftInStep(ctx, frame.id);
    publishPenPhase(ctx.actions.setStateSignal, 'idle');
  },
} as EditorCommand<PenShapeStylePayload | undefined, void>;

/** Confirm latch for the destructive release swap (armed by the first press). */
let releaseConfirmArmed = false;

/**
 * cmd.pen_release_to_draft — "Release Path to Draft" (LayerMenu on pen shape
 * layers): maps the layer's `penData` (layer-local) back into frame-local
 * draft subpaths, seeds the frame's draft with it and removes the layer.
 * Both writes ride this ONE undoable step: undo re-adds the layer AND
 * restores the previous draft.
 */
const releaseToDraftCommand: EditorCommand<{ frameId: string; layerId: string }, void> = {
  id: P.CMD_RELEASE_TO_DRAFT,
  name: 'Release Pen Path to Draft',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layerId: string }) => {
    const frame = ctx.state.frames.byId[payload.frameId];
    const layer = frame?.layers.byId[payload.layerId];
    if (!frame || !layer || layer.type !== 'vector' || !layer.penData) return;
    if (layer.role && layer.role !== 'host') return; // never release engine clones

    // HUD-confirmed swap when a draft is already alive (same latch
    // discipline as Apply-as-Bezier).
    if (getPenDraft(frame) !== null && !releaseConfirmArmed) {
      releaseConfirmArmed = true;
      ctx.actions.notifyHUD('Releasing replaces the current pen draft — press again to confirm', 'error');
      return;
    }
    releaseConfirmArmed = false;

    // Layer-local → frame-local with handle rebasing (handles are relative).
    const matrix = ctx.geometry.transform.getLayerLocalMatrix(layer, frame);
    const subs = penDataToFrameSubPaths(layer.penData, (p) => matrix.apply(p));
    if (subs.length === 0) {
      ctx.actions.setInteraction({ hud: { message: 'Layer holds no path to release', type: 'error' } });
      return;
    }

    // The draft write and the layer removal land inside this command's
    // single undoable step.
    replacePenDraft(ctx.actions, frame, { subpaths: subs });
    publishPenPhase(ctx.actions.setStateSignal, 'drawing');
    if (getPenCommittedSelection()?.layerId === layer.id) setPenCommittedSelection(null);

    ctx.layers.removeLayers(frame.id, layer.id);
    ctx.actions.notifyHUD(`Path released to the pen tool (${subs.length} subpath${subs.length > 1 ? 's' : ''})`, 'info');
  },
} as EditorCommand<{ frameId: string; layerId: string }, void>;

/**
 * cmd.pen_update_style — patches a committed shape layer's `penStyle`
 * (fill / stroke color / stroke width, used by the pen panel's dual-mode
 * binding). Undoable. A stroke WIDTH change re-runs the padded-bounds rebase:
 * the layer's extents key off the stroke width (penBoundsPad), so without the
 * rebase a thinner stroke would leave the shape clipped inside its old
 * visibleShape — same convention as anchor edits on the interaction side.
 */
const updatePenStyleCommand: EditorCommand<{
  frameId: string;
  layerId: string;
  patch: { fill?: ColorValue | null; strokeColor?: ColorValue; strokeWidth?: number };
}, void> = {
  id: P.CMD_UPDATE_PEN_STYLE,
  name: 'Update Pen Shape Style',
  undoable: true,
  execute: (ctx: EditorContextValue, payload: { frameId: string; layerId: string; patch: { fill?: ColorValue | null; strokeColor?: ColorValue; strokeWidth?: number } }) => {
    const frame = ctx.state.frames.byId[payload.frameId];
    const layer = frame?.layers.byId[payload.layerId];
    if (!frame || !layer || layer.type !== 'vector' || !layer.penData) return;
    const current = layer.penStyle ?? {};
    const next = { ...current };
    if (payload.patch.fill !== undefined) next.fill = payload.patch.fill;
    if (payload.patch.strokeColor !== undefined || payload.patch.strokeWidth !== undefined) {
      const color = payload.patch.strokeColor ?? current.stroke?.color ?? null;
      const width = payload.patch.strokeWidth ?? current.stroke?.width ?? 0;
      next.stroke = color ? { color, width } : null;
    }
    const widthChanged =
      payload.patch.strokeWidth !== undefined && payload.patch.strokeWidth !== current.stroke?.width;
    if (!widthChanged) {
      ctx.actions.updateLayer(frame.id, layer.id, { penStyle: next });
      return;
    }
    // Width changed: re-derive the padded bounds and re-anchor the payload so
    // every path point stays exactly where it was on canvas (single undoable
    // write carries geometry + style + frame together).
    const rebase = rebasePenDataToBounds(layer.penData, penBoundsPad(next), ctx.geometry.bezier);
    if (!rebase) {
      ctx.actions.updateLayer(frame.id, layer.id, { penStyle: next });
      return;
    }
    const M = ctx.geometry.transform.getLayerWorldMatrix(layer);
    const growX = (rebase.bounding.w - layer.bounding.w) / 2;
    const growY = (rebase.bounding.h - layer.bounding.h) / 2;
    const dx = rebase.shift.x + growX;
    const dy = rebase.shift.y + growY;
    ctx.actions.updateLayer(frame.id, layer.id, {
      penStyle: next,
      penData: rebase.penData,
      bounding: rebase.bounding,
      visibleShape: asLocalShape({ x: 0, y: 0, w: rebase.bounding.w, h: rebase.bounding.h }),
      cx: layer.cx + M.a * dx + M.c * dy,
      cy: layer.cy + M.b * dx + M.d * dy,
    });
  },
};


// ─── Export ────────────────────────────────────────────────────────────────────

export const PEN_OVERLAY_COMMANDS = [
  applyMaskCommand,
  toSelectionCommand,
  applyAsBezierCommand,
  cancelDraftCommand,
  updatePenDataCommand,
  updatePenStyleCommand,
  createShapeCommand,
  releaseToDraftCommand,
];

/** The frame's live draft as persistent PenPathData (empty when idle). */
export function sessionPenPathData(ctx: EditorContextValue): ReturnType<typeof draftToPenPathData> {
  const frame = ctx.activeFrame;
  if (!frame) return { paths: [] };
  return draftToPenPathData(composePenToolState(frame));
}
