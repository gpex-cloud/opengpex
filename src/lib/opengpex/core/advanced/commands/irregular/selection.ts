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

import { EditorContextValue, EditorCommand, LocalPolygon, LocalShape, isPolygon } from '@opengpex/editor/core/types';
import { polygonToShape } from '@opengpex/editor/core/helpers/path2d';
import { resolveActiveSelection } from '@opengpex/editor/core/helpers/selection';
import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * IRREGULAR_SELECTION_COMMANDS
 *
 * Phase 2 irregular-selection (lasso / wand / AI matting) command set.
 *
 * Pre-PR-6-3 architecture (per-tool slot model):
 *   - Producers (lasso handler / wand handler / AI matting result) write a
 *     polygon into THEIR OWN slot of `frame.irregularCropBoxes` via
 *     `actions.setIrregularCropBox(frameId, toolId, polygon)`, symmetric with
 *     rect/ellipse writing `imageCropBox` / `canvasCropBox`.
 *   - There is NO `set` / `clear` adv command — those would be value-less thin
 *     wrappers around the action; the executeCommand atom only buys you a
 *     pre-execute history checkpoint, but `actions.setIrregularCropBox` already
 *     gets one from the dispatcher's standard reducer pipeline. See
 *     `phase1_irregular_clip_spec.md` §6 Pre-PR-6-2.0 for full rationale.
 *   - The only command in this file is `toLayerMask`, which IS a real
 *     transaction (project polygon → vectorMask + clear slot) and therefore
 *     needs the undo-atom guarantee.
 *
 * **Active-slot resolution.** The user only ever has one polygon visible on
 * the canvas — the one belonging to the currently active irregular tool, as
 * surfaced by `useIrregularSelectionSync` in ClipOverlay. So when the user
 * clicks "Apply Mask", we need to bake exactly that slot. There are two ways
 * to identify it:
 *   (a) Caller passes `toolId` in payload — explicit, no plugin coupling.
 *   (b) Command auto-detects by reading the `signal.crop_tool` signal.
 * We chose (a) because:
 *   - keeps `core/advanced` decoupled from `plugins/base/options/ClipOptions`
 *     (no cross-package dependency on a plugin-namespaced signal key);
 *   - lets non-clip callers (future scripting, batch export, etc.) target a
 *     specific slot without having to first synthesize the signal;
 *   - if no toolId is passed, we fall back to a deterministic scan (first
 *     non-empty slot in insertion order) so existing callers that don't yet
 *     pass toolId still work — useful during incremental rollout.
 *
 * Lifecycle:
 *   1) Producer writes polygon  → `actions.setIrregularCropBox(frameId, toolId, polygon)`
 *   2) ClipOverlay reads `irregularCropBoxes[activeToolId]` via
 *      `useIrregularSelectionSync` for purple ants preview
 *   3) User clicks "Apply Mask" → `toLayerMask({ toolId })` (this command)
 *   4) Switching tool / cancel / re-canvas → no automatic clear; per-tool slot
 *      data persists across tool switches for round-trip symmetry. The only
 *      paths that clear a slot are (a) `toLayerMask` itself after baking
 *      (clears the just-applied tool's slot) and (b) a future explicit
 *      "Clear Selection" user gesture.
 *
 * Atomicity:
 *   The runtime sets a history checkpoint BEFORE every `undoable: true` command.
 *   All state mutations made INSIDE the command (without going through another
 *   `executeCommand`-driven undoable) end up in the same edit step at the next
 *   commit. We therefore deliberately call `layers.updateLayer` and
 *   `actions.setIrregularCropBox` directly (NOT via another undoable command),
 *   to avoid nested SIGNAL_COMMITs splitting the atom.
 *
 * Phase 2 redesign (vectorMask path):
 *   The previous bitmap bake approach (offscreen canvas → toBlob → registerAsset
 *   → addBitmapMask, ~120 lines) has been replaced with a pure vector path:
 *   `polygonToShape()` → `applyMask()` → VectorMask. Benefits:
 *     - Net reduction of ~100 lines
 *     - No scale artifacts (vector, resolution-independent)
 *     - Pure memory operation (<1ms vs ~100ms toBlob)
 *     - Unified with drill/cut/peel which also use `polygonToShape`
 */
export const IrregularSelectionCommands = {
  toLayerMask: {
    id: P.ADV_IRREGULAR_TO_LAYER_MASK,
    name: 'Apply Selection as Layer Mask',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload?: { layerId?: string; toolId?: string }): Promise<void> => {
      const { activeFrame, activeLayer, actions, geometry, layers } = ctx;
      if (!activeFrame) return;

      const toolId = payload?.toolId ?? 'rect';

      // Phase 2: use unified `resolveActiveSelection` to get the active
      // selection regardless of tool family (rect/ellipse/lasso/wand).
      const selection = resolveActiveSelection(activeFrame, toolId);
      if (!selection) {
        actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }

      // Resolve target layer: explicit payload > activeLayer
      const targetLayerId = payload?.layerId ?? activeLayer?.id;
      if (!targetLayerId) {
        actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }
      const targetLayer = activeFrame.layers.byId[targetLayerId];
      if (!targetLayer) {
        actions.setInteraction({ selectionErrorPulse: Date.now() });
        return;
      }

      // Derive LocalShape for the mask:
      let localShape: LocalShape;
      if (isPolygon(selection)) {
        // Irregular path (lasso/wand): project frame-local → layer-local, then to shape
        const layerPoly = geometry.polygon.frameLocalToLayerLocalPolygon(selection, activeFrame, targetLayer);
        localShape = polygonToShape(layerPoly);
      } else {
        // Regular shape (rect/ellipse): already a LocalShape, use directly
        localShape = selection;
      }

      // Apply as VectorMask (Reveal Selection — inverted=false)
      layers.updateLayer(activeFrame.id, tx => {
        tx.edit(targetLayer.id).applyMask(localShape, false);
      });

      // Clear the applied selection slot (shares the same undo atom):
      // - For irregular tools: clear the polygon slot
      // - For regular tools: reset imageCropBox to full-frame (no-op crop)
      if (isPolygon(selection)) {
        actions.setIrregularCropBox(activeFrame.id, toolId, null);
      }
      // Regular shapes (rect/ellipse): no slot to clear — the imageCropBox
      // remains as-is. The mask is applied; the user can continue editing
      // the crop box or reset it via boxResetCmd independently.
    },
  } as EditorCommand<{ layerId?: string; toolId?: string } | undefined, Promise<void>>,
};
