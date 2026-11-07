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
import { resolveMergeStrategy } from '@opengpex/editor/core/layer/services/merging';
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
        ctx.actions.updateFrame(frame.id, { confinement: asLocalPolygon([ring], rect, { antiAliased: true }) });
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

// ─── Merge selected status ───────────────────────────────────────────────────────

export type MergeStatus = 'green' | 'red';

/**
 * computeMergeStatus — Guard the marked selection through the shared merge
 * strategy resolver and translate the outcome into the button's state color.
 *
 * Returns:
 *   'green' — mergeable: the set bakes (composites as seen into the bottom
 *             participant)
 *   'red'   — not mergeable (group participants, or fewer than 2 valid
 *             layers)
 */
export function computeMergeStatus(selection: string[], frame: Frame): MergeStatus {
  if (selection.length < 2) return 'red';

  const layers = selection
    .map(id => frame.layers.byId[id])
    .filter(Boolean) as Layer[];

  if (layers.length < 2) return 'red';

  return resolveMergeStrategy(layers).op === 'bake' ? 'green' : 'red';
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
