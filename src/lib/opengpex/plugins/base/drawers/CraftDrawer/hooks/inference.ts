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

import { useEffect, useRef } from 'react';
import { useEditorState, usePluginSignals, usePluginSelfConfig } from '@opengpex/editor/core/context';
import { MARKER_REGISTRY } from '@opengpex/editor/plugins/base/overlays/MarkerOverlay/marker/registry';
import '@opengpex/editor/plugins/base/overlays/MarkerOverlay/marker';
import { getLayerKind } from '@opengpex/editor/core/layer/kinds';
import { ActiveCraft, CraftDrawerConfig } from '../protocols';
import { CraftDrawerSignalsMap } from '../commands.d';

// ─── useCraftDrawer ────────────────────────────────────────────────────────────

/**
 * useCraftDrawer: Semantic Hook for CraftDrawer main panel
 *
 * Provides currently active craft tool type and type inference of currently selected layer.
 * Panel display uses mutually exclusive logic:
 * - activeCraft has highest priority (explicitly active tool type determines panel)
 * - activeCraft=null infers panel by selected layer type (text -> TextPanel,
 *   paint -> BrushPanel, marker layer -> MarkerPanel, pen shape -> PenPanel)
 */
export function useCraftDrawer() {
  const { activeCraftSignal } = usePluginSignals<CraftDrawerSignalsMap>();
  const { activeLayer } = useEditorState();
  const [, setSelfConfig] = usePluginSelfConfig<CraftDrawerConfig>();

  const activeCraft = (activeCraftSignal?.value ?? null) as ActiveCraft;

  // Which tool the inferred panel belongs to (only meaningful while no tool
  // is active; drives the button group's opt-in inverted state). Inference
  // reads the LayerKind table's `ui` column — the single place that owns
  // per-type payload-variant and provenance-stamp checks (replaces the former
  // scattered payload sniffing in this hook). The hint token set is
  // deliberately narrower than ActiveCraft: only panel identities a COMMITTED
  // layer can carry (no 'brush' — brush strokes commit as vector layers that
  // infer no panel; no 'eraser'/'restore' — no code path stamps those tools
  // onto surviving layers). Hints are a subset of CraftType, so the
  // assignment typechecks without a cast.
  const inferredCraft: ActiveCraft | null = activeLayer
    ? getLayerKind(activeLayer.type).ui(activeLayer)
    : null;

  // With no tool active, the drawer infers the panel from the selection.
  // Arming the selected marker's kind keeps the inferred panel's highlight
  // and bindings on the selected layer (otherwise the panel would show a
  // stale armed kind — the detached state activateCraft('marker') also
  // avoids). Only fires while NO tool is active: an active tool owns its
  // armed kind (handlers arm it on click). The last auto-armed layer id is
  // tracked so arming happens ONCE per selection change — re-running on
  // every config write would fight the panel's own kind selector (the user
  // picks a kind, the effect would snap it back to the layer's kind).
  const lastAutoArmedLayerIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (inferredCraft !== 'marker') return;
    const layerId = activeLayer?.id ?? null;
    if (layerId === lastAutoArmedLayerIdRef.current) return;
    const kind = activeLayer?.markerData?.kind;
    if (kind && MARKER_REGISTRY.get(kind)) {
      lastAutoArmedLayerIdRef.current = layerId;
      setSelfConfig({ activeMarkerKind: kind } as Partial<CraftDrawerConfig>);
    }
  }, [inferredCraft, activeLayer, setSelfConfig]);

  return { activeCraft, inferredCraft };
}
