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

import { useCallback, useMemo } from 'react';
import { useEditorState, useEditorServices, usePluginSelfConfig } from '@opengpex/editor/core/context';
import { MarkerOverlayAPI } from '@opengpex/editor/plugins/base/overlays/MarkerOverlay/protocols';
import { MARKER_REGISTRY } from '@opengpex/editor/plugins/base/overlays/MarkerOverlay/marker/registry';
import '@opengpex/editor/plugins/base/overlays/MarkerOverlay/marker';
import { getDynamicMarkerStrokeMax } from '../../protocols';
import { CraftDrawerConfig } from '../../protocols';
import { MarkerData, MarkerKind } from '@opengpex/editor/plugins/base/overlays/MarkerOverlay/marker/types';
import { resolveNextMarkerData, resolvePendingMarkerStyle, mergePendingMarkerStyle, withPendingMarkerStyle } from '@opengpex/editor/plugins/base/overlays/MarkerOverlay/marker/pending';
import { resolveMarkerToolState } from '@opengpex/editor/plugins/base/overlays/MarkerOverlay/protocols';

// ─── useMarkerPanel ────────────────────────────────────────────────────────────

/**
 * useMarkerPanel: Semantic Hook for MarkerPanel.
 *
 * Mirrors useTextPanel's dual-mode binding:
 * - When a marker layer (`type:'vector' + markerData`) is selected, the panel
 *   reads/writes that layer's live markerData (undoable via MarkerOverlay's
 *   update command; live for continuous slider drags).
 * - Otherwise it reads/writes `pendingMarkerData` + `activeMarkerKind` in
 *   pluginConfig, which drives new-marker defaults and the draw preview.
 *
 * The active kind is shared with Tab cycling: both selector click and Tab write
 * the same `activeMarkerKind`, so the panel highlight stays in sync.
 */
export function useMarkerPanel() {
  const { state, activeFrame, activeLayer } = useEditorState();
  const { actions } = useEditorServices();
  const [selfConfig, setSelfConfig] = usePluginSelfConfig<CraftDrawerConfig>();

  // Registered marker kinds (declaration order = selector order = Tab order).
  const kinds = MARKER_REGISTRY.kinds();
  const definitions = MARKER_REGISTRY.getAll();

  // Selected marker layer (only when it is a marker vector layer).
  const targetLayer = activeLayer && activeLayer.type === 'vector' && activeLayer.markerData ? activeLayer : null;
  const layerMarkerData = targetLayer?.markerData;

  // activeMarkerKind is the TOOL state (what the next drag draws; drives the
  // selector highlight and Tab cycling). Which data the style controls bind to
  // follows the shared marker tool-state derivation (MarkerOverlay/toolState.ts):
  // ACTIVE → the selected layer's live data (remembered as the kind's preset on
  // commit); INACTIVE / idle → the armed kind's NEXT-marker preset.
  const activeMarkerKind: MarkerKind = (selfConfig.activeMarkerKind
    ?? kinds[0]
    ?? 'rect') as MarkerKind;
  const toolState = resolveMarkerToolState(targetLayer, activeMarkerKind);
  const isActive = toolState.phase === 'active';

  const activeDef = MARKER_REGISTRY.get(activeMarkerKind);

  // Synthesized markerData for the panel UI: the live layer when active, the
  // armed kind's next-marker preset otherwise.
  const markerData: MarkerData | undefined = useMemo(() => {
    if (isActive && layerMarkerData) return layerMarkerData;
    return resolveNextMarkerData(selfConfig, activeMarkerKind);
  }, [isActive, layerMarkerData, selfConfig, activeMarkerKind]);

  // Select a marker sub-type (panel click). Shares activeMarkerKind with Tab.
  // Only arms the tool for the next draw — the current selection is untouched.
  const selectKind = useCallback((kind: MarkerKind) => {
    setSelfConfig({ activeMarkerKind: kind } as Partial<CraftDrawerConfig>);
  }, [setSelfConfig]);

  /**
   * Update marker style properties (stroke/fill/cornerRadius).
   *
   * Two modes, each keeping the controlled panel sliders live-updating:
   * 1. ACTIVE (a marker layer whose kind matches the armed kind) → edit the
   *    layer (undoable command on commit, or live updateLayer for continuous
   *    slider drags); the layer's own data drives the slider value. On commit
   *    the style is also remembered as that kind's preset ("last used").
   * 2. INACTIVE / pending (armed kind differs from the selection, or nothing is
   *    selected) → write the armed kind's preset on EVERY call, including live
   *    drags — the preset drives the slider value here, so skipping live writes
   *    would freeze the thumb (the earlier bug: sliders "couldn't be dragged"
   *    until a marker was drawn/selected).
   */
  const updateMarkerData = useCallback((patch: Partial<MarkerData>, live = false) => {
    // ── Mode 1: ACTIVE — a marker layer whose kind matches the armed kind ──
    if (isActive && targetLayer && activeFrame && layerMarkerData) {
      if (live) {
        actions.updateLayer(activeFrame.id, targetLayer.id, {
          markerData: { ...layerMarkerData, ...patch } as MarkerData,
        });
      } else {
        actions.executeCommand(MarkerOverlayAPI.commands.updateMarker.uid, {
          frameId: activeFrame.id,
          layerId: targetLayer.id,
          patch,
        });
      }
      // Remember as the kind's next-marker preset — commit only (no live spam).
      if (!live) {
        const style = mergePendingMarkerStyle(
          resolvePendingMarkerStyle(selfConfig, activeMarkerKind),
          layerMarkerData,
          patch,
        );
        setSelfConfig({ pendingMarkerByKind: withPendingMarkerStyle(selfConfig, activeMarkerKind, style) } as Partial<CraftDrawerConfig>);
      }
      return;
    }

    // ── Mode 2: INACTIVE / pending — write the armed kind's preset every call ──
    const current = markerData;
    if (!current) return;
    const style = mergePendingMarkerStyle(
      resolvePendingMarkerStyle(selfConfig, activeMarkerKind),
      current,
      patch,
    );
    setSelfConfig({ pendingMarkerByKind: withPendingMarkerStyle(selfConfig, activeMarkerKind, style) } as Partial<CraftDrawerConfig>);
  }, [isActive, targetLayer, activeFrame, layerMarkerData, selfConfig, activeMarkerKind, markerData, actions, setSelfConfig]);

  // Keep this hook's state reference stable across renders unless inputs change.
  void state;

  // Slider ceiling follows the canvas size (see getDynamicMarkerStrokeMax).
  const strokeWidthMax = getDynamicMarkerStrokeMax(activeFrame?.canvas.w, activeFrame?.canvas.h);

  return useMemo(() => ({
    kinds,
    definitions,
    activeMarkerKind,
    activeDef,
    markerData,
    strokeWidthMax,
    hasSelectedLayer: !!targetLayer,
    isActive,
    selectedKind: toolState.selectedKind,
    selectKind,
    updateMarkerData,
  }), [kinds, definitions, activeMarkerKind, activeDef, markerData, strokeWidthMax, targetLayer, selectKind, updateMarkerData, isActive, toolState.selectedKind]);
}
