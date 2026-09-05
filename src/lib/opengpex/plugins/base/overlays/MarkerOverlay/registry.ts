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

/**
 * MarkerOverlay Registry — plugin-side marker extension point.
 *
 * IMPORTANT (see spec §4.0): this registry only holds UI / interaction
 * METADATA. The pixel/SVG drawing logic (`paintMarker` / `markerToSvg`) lives
 * in core (`core/engine/rendering/shared/markerPainter.ts`) so the render
 * pipeline can consume it without importing plugin code. `MarkerDefinition`
 * therefore intentionally does NOT carry any `paint` / `toSvg` function —
 * it only describes "how the tool looks in the panel and how a drag maps to
 * geometry".
 *
 * Adding a new marker (Phase 2+) requires:
 *   1. core: add a literal to `MarkerKind` + an `XxxMarkerData` interface
 *   2. core: add a `paintMarker` / `markerToSvg` switch case
 *   3. plugin: implement a `MarkerDefinition` here and register it below
 */

import type React from 'react';
import type { MarkerData, MarkerKind } from '@opengpex/editor/core/types';

/**
 * MarkerDefinition: per-marker-kind UI / interaction contract.
 * Safe to depend on React / lucide-react (plugin-layer deps) because it never
 * enters the isomorphic render pipeline.
 */
export interface MarkerDefinition<T extends MarkerData = MarkerData> {
  /** Must match MarkerData.kind exactly */
  kind: T['kind'];

  /** Display name for UI */
  label: string;

  /** Lucide icon node (or any React node) for the panel selector */
  icon: React.ReactNode;

  /** Whether this shape exposes a fill property (closed shapes) */
  hasFill: boolean;

  /** Whether this shape exposes a cornerRadius property */
  hasCornerRadius: boolean;

  /** Default MarkerData for new marker creation */
  defaults: () => T;

  /**
   * Compute bounding box + geometry from a raw drag (canvas-local space).
   *
   * @param drag - drag start/end in canvas-local coordinates
   * @param data - the marker data being drawn (defaults + pending style)
   * @param options - modifier keys (Shift = square / 45° snap)
   * @returns bounding (w×h), the world-independent local geometry patch, and
   *          the local center of the bounding box (caller converts to world).
   */
  computeFromDrag: (
    drag: { startX: number; startY: number; endX: number; endY: number },
    data: T,
    options: { shiftKey: boolean },
  ) => {
    bounding: { w: number; h: number };
    /** Center of the bounding box in canvas-local space */
    centerLocal: { x: number; y: number };
    /** Geometry fields to merge into the marker data (e.g. arrow tail/head) */
    patch: Partial<T>;
  };
}

// ─── Registry ──────────────────────────────────────────────────────────────────

const _registry = new Map<MarkerKind, MarkerDefinition>();

export const MARKER_REGISTRY = {
  register<T extends MarkerData>(def: MarkerDefinition<T>) {
    _registry.set(def.kind, def as unknown as MarkerDefinition);
  },

  get(kind: MarkerKind): MarkerDefinition | undefined {
    return _registry.get(kind);
  },

  getAll(): MarkerDefinition[] {
    return Array.from(_registry.values());
  },

  /** Ordered list for UI rendering / Tab cycling (declaration order) */
  kinds(): MarkerKind[] {
    return Array.from(_registry.keys());
  },
} as const;
