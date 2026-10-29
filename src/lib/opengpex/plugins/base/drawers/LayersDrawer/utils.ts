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

import { Layer, Frame, EditorContextValue, asLocalPolygon, asLocalRect, asLocalPoint, LocalPolygon, NormalizedState, ShapeType, AdjustmentMask } from '@opengpex/editor/core/types';
import { findUpstreamAssetId, findDownstreamFragments } from '@opengpex/editor/core/layer/factory';
import { isIdentityGrade } from '@opengpex/editor/core/helpers/adjustments';

/**
 * Resolved refocus target: either a regular shape (rect/ellipse) or an irregular polygon.
 * Regular ellipse-shaped targets always map to the 'pathellipse' tool slot.
 * All clip boxes are now stored as LocalPolygon — regular shapes are converted via asLocalPolygon.
 */
export type RefocusTarget =
    | { regular: true; clipToolId: 'rect' | 'pathellipse'; shapeType: ShapeType; canvasX: number; canvasY: number; w: number; h: number }
    | { regular: false; clipToolId: string; polygon: LocalPolygon };

/**
 * Commits a resolved RefocusTarget to the frame state:
 *   1. Switches latestClipTool
 *   2. Clears conflicting slots (for regular shapes)
 *   3. Writes the clip box data (always as LocalPolygon)
 *   4. Enters clip mode
 *
 * This is the unified "write to overlay" exit point for all refocus paths
 * (rect, pathellipse, lasso, wand, sam).
 */
export function commitRefocusToOverlay(
    ctx: EditorContextValue,
    frame: Frame,
    target: RefocusTarget
) {
    // 1. Switch active clip tool
    ctx.actions.updateFrame(frame.id, { latestClipTool: target.clipToolId });

    if (target.regular) {
        // NOTE: Opposite regular slot is NOT cleared. `getRegularClipShape`
        // resolves via `frame.latestClipTool`, so inactive slots are harmless.

        // 3a. Write regular shape as LocalPolygon (rect = 4 corners, ellipse = 4 corners)
        const rect = asLocalRect({ x: target.canvasX, y: target.canvasY, w: target.w, h: target.h });
        const { x, y, w, h } = rect;
        const ring = [
            asLocalPoint({ x, y }),
            asLocalPoint({ x: x + w, y }),
            asLocalPoint({ x: x + w, y: y + h }),
            asLocalPoint({ x, y: y + h }),
        ];
        ctx.actions.updateFrame(frame.id, { confinement: asLocalPolygon([ring], rect, true) });
    } else {
        // 3b. Write irregular polygon
        ctx.actions.updateFrame(frame.id, { confinement: target.polygon });
    }

    // 4. Enter clip mode
    ctx.actions.setInteraction({ interactionMode: 'clip' });
}

// ─── Adjustment indicator ─────────────────────────────────────────────────────

/**
 * Returns `true` when a layer carries any ENABLED, non-identity adjustment mask.
 *
 * Used by `LayerItem` to render the purple "has adjustments" indicator dot.
 */
export function hasLayerAdjustments(layer: Layer): boolean {
  return (layer.adjustMasks ?? []).some((m) => m.enabled && !isIdentityGrade(m.grade));
}

// ─── Union merge status ───────────────────────────────────────────────────────

export type UnionStatus = 'green' | 'amber' | 'red';

/**
 * computeUnionStatus — Evaluate the compatibility of selected layers for union merge.
 *
 * Returns:
 *   'green' — Perfect merge (same assetId, rotation/flip, all image, no downstream, consistent props, no displacement)
 *   'amber' — Mergeable with compromise (props differ or fragments displaced from birth position)
 *   'red'   — Cannot merge (different assetId, rotation/flip mismatch, non-image, has downstream, mixed cut+copy, or <2 selected)
 *
 */
export function computeUnionStatus(selection: string[], frame: Frame): UnionStatus {
  if (selection.length < 2) return 'red';

  const layers = selection
    .map(id => frame.layers.byId[id])
    .filter(Boolean) as Layer[];

  if (layers.length < 2) return 'red';

  // All must be image type
  if (layers.some(l => l.type !== 'image')) return 'red';

  // Resolve root assetIds — all must match
  const assetIds = layers.map(l => findUpstreamAssetId(l.id, frame));
  if (assetIds.some(id => !id)) return 'red';
  if (new Set(assetIds).size > 1) return 'red';

  // Rotation/flip must be consistent
  const base = layers[0];
  if (layers.some(l => l.rotation !== base.rotation)) return 'red';
  if (layers.some(l => l.flip.h !== base.flip.h || l.flip.v !== base.flip.v)) return 'red';

  // Downstream fragments check: all downstream of selected layers must also be in selection.
  // If a selected layer has unselected downstream, merging would orphan those fragments.
  const allLayers = frame.layers.order.map(id => frame.layers.byId[id]);
  const selectionSet = new Set(selection);
  for (const layer of layers) {
    const downstream = findDownstreamFragments(layer.id, allLayers);
    if (downstream.some(d => !selectionSet.has(d.id))) return 'red';
  }

  // Mixed cut+copy is disallowed:
  // Some have assocMaskId (cut) and others don't (copy) → hole mask semantics would be inconsistent.
  const hasCut = layers.some(l => l.metadata?.assocMaskId);
  const hasCopy = layers.some(l => l.metadata?.sourceLayerId && !l.metadata?.assocMaskId);
  if (hasCut && hasCopy) return 'red';

  // If we reach here, merge is possible. Check for property consistency + position → green vs amber.
  const propsMatch =
    layers.every(l => l.opacity === base.opacity) &&
    layers.every(l => l.blendMode === base.blendMode) &&
    layers.every(l => JSON.stringify(l.adjustMasks ?? null) === JSON.stringify(base.adjustMasks ?? null));

  // Check if any fragment has been moved from its birth position
  const anyMoved = layers.some(l =>
    l.birthCenter && (l.cx !== l.birthCenter.cx || l.cy !== l.birthCenter.cy)
  );

  return (propsMatch && !anyMoved) ? 'green' : 'amber';
}

// ─── Layer stack reordering ───────────────────────────────────────────────────

/**
 * Re-constructs the full flat layer list based on a reordered host list.
 * Maintains child layer positions relative to their parents.
 * Group members (layers with groupId) are kept adjacent after their group head.
 */
export function calcFullLayerStack(
    hostLayers: Layer[],
    allLayers: NormalizedState<Layer>
): Layer[] {
    const fullLayers: Layer[] = [];

    hostLayers.forEach(host => {
        fullLayers.push(host);
        // Find all children belonging to this host (parentId match)
        const children = allLayers.order.map(id => allLayers.byId[id]).filter(l => l.hostId === host.id);
        fullLayers.push(...children);
    });

    return fullLayers;
}

// ─── Adjustment-mask row summary ──────────────────────────────────────────────

const CATEGORY_LABEL: Record<AdjustmentMask['category'], string> = {
  basic: 'Basic',
  levels: 'Levels',
  curves: 'Curves',
  channelMix: 'Mixer',
  colorBalance: 'Balance',
};

/**
 * One-line summary of an adjustment mask for the layers panel row: the
 * category plus the parameters that deviate from identity (a migrated
 * legacy entry may carry several categories and lists each).
 */
export function summarizeAdjustMask(mask: AdjustmentMask): string {
  const g = mask.grade;
  const parts: string[] = [];
  const a = g.adjustments;
  if (a) {
    if ((a.brightness ?? 100) !== 100) parts.push(`Brightness ${Math.round(a.brightness)}`);
    if ((a.contrast ?? 100) !== 100) parts.push(`Contrast ${Math.round(a.contrast)}`);
    if ((a.saturation ?? 100) !== 100) parts.push(`Saturation ${Math.round(a.saturation)}`);
    if ((a.hueRotate ?? 0) !== 0) parts.push(`Hue ${Math.round(a.hueRotate)}°`);
    if ((a.blur ?? 0) !== 0) parts.push(`Blur ${a.blur.toFixed(1)}`);
    if ((a.edgeFeather ?? 0) !== 0) parts.push(`Feather ${(a.edgeFeather ?? 0).toFixed(1)}`);
  }
  if (g.levels) {
    const l = g.levels;
    parts.push(`Levels ${l.inputBlack}–${l.inputWhite} γ${Number(l.gamma.toFixed(2))}`);
  }
  if (g.curves) {
    const channels = (['rgb', 'red', 'green', 'blue'] as const).filter((c) => (g.curves![c]?.length ?? 0) > 2);
    parts.push(channels.length ? `Curves ${channels.join('/')}` : 'Curves');
  }
  if (g.channelMix) parts.push('Mixer');
  if (g.colorBalance) parts.push('Balance');
  const label = CATEGORY_LABEL[mask.category];
  if (parts.length === 0) return `${label} (identity)`;
  return parts.join(' · ');
}
