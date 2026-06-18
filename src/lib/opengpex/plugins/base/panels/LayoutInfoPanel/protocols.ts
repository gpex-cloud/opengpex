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

import { Layout, Box, Target, Layers2, HelpCircle } from 'lucide-react';
import type { EditorSlot } from '@opengpex/editor/core/types';

/**
 * LayoutInfo Plugin Protocols
 */
export const PLUGIN_ID = 'panels.layout_info_panel';
export const PLUGIN_AUTHOR = 'opengpex';

/**
 * Command IDs
 */
export const CMD_TOGGLE = 'cmd.toggle';

/**
 * Custom Config Interface
 */
export interface LayoutConfig {
  enabled: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Layer Architecture Schema (Single Source of Truth)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LayerDefinition: Describes a stacking layer in the workspace's z-axis composition.
 * The 3D exploded view and bidirectional slot-layer sync are derived from this.
 */
export interface LayerDefinition {
  id: string;
  level: string;            // Display label e.g. "L1", "L2"
  title: string;            // Descriptive title
  zIndex: number;           // Conceptual z-index value for display
  color: string;            // Tailwind color theme (e.g. "emerald", "indigo")
}

/**
 * SlotGroupDefinition: A semantic grouping of slots for the registry explorer.
 */
export interface SlotGroupDefinition {
  id: string;
  name: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  slots: EditorSlot[];
  layerId: string;          // Which layer this group corresponds to
}

/**
 * LAYER_STACK: Ordered list of workspace composition layers (bottom to top).
 * If workspace architecture changes, update only this definition.
 */
export const LAYER_STACK: LayerDefinition[] = [
  { id: 'canvas',    level: 'L1', title: '200: CONTENT',                             zIndex: 200,  color: 'emerald' },
  { id: 'gizmos',    level: 'L2', title: '1000: STAGE_GIZMOS',                       zIndex: 1000, color: 'teal' },
  { id: 'overlays',  level: 'L3', title: '2000: SYSTEM_TOOLS (STAGE_OVERLAY & Corners)', zIndex: 2000, color: 'indigo' },
  { id: 'chrome',    level: 'L4', title: '2000: OPTION_BAR & SIDE_BAR',              zIndex: 2000, color: 'amber' },
  { id: 'viewport',  level: 'L5', title: '4000: VIEWPORT_OVERLAY',                   zIndex: 4000, color: 'rose' },
  { id: 'root',      level: 'L6', title: 'Window Global',                            zIndex: 9999, color: 'fuchsia' },
];

/**
 * SLOT_GROUPS: Declarative grouping of slots into spatial categories.
 * Slots here are the "known" core slots; any additional slots discovered
 * at runtime from the plugin registry will be classified into a fallback group.
 */
export const SLOT_GROUPS: SlotGroupDefinition[] = [
  {
    id: 'layout_chrome',
    name: 'Layout Chrome',
    icon: Layout,
    slots: ['OPTION_BAR', 'SIDE_BAR'],
    layerId: 'chrome',
  },
  {
    id: 'tool_systems',
    name: 'Tool Systems',
    icon: Box,
    slots: ['TOOL_MENU'],
    layerId: 'chrome',
  },
  {
    id: 'viewport_corners',
    name: 'HUD & Corners',
    icon: Target,
    slots: ['TL', 'TR', 'BL', 'BR', 'DOCK'],
    layerId: 'overlays',
  },
  {
    id: 'overlays_gizmos',
    name: 'Overlays',
    icon: Layers2,
    slots: ['ROOT_OVERLAY', 'VIEWPORT_OVERLAY', 'STAGE_OVERLAY', 'STAGE_GIZMOS'],
    layerId: 'overlays',
  },
];

/**
 * FALLBACK_GROUP: Auto-generated group for any dynamically discovered slots
 * that don't match any known slot group above.
 */
export const FALLBACK_GROUP_TEMPLATE: Omit<SlotGroupDefinition, 'slots'> = {
  id: 'dynamic_extensions',
  name: 'Extensions',
  icon: HelpCircle,
  layerId: 'root',
};

/**
 * SLOT_TO_LAYER_MAP: Maps each known slot to its corresponding layer ID.
 * Derived from SLOT_GROUPS for reference; unknown slots default to 'root'.
 */
export const SLOT_TO_LAYER_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  // Explicit per-slot overrides for fine-grained layer assignment
  const overrides: Record<string, string> = {
    ROOT_OVERLAY: 'root',
    VIEWPORT_OVERLAY: 'viewport',
    OPTION_BAR: 'chrome',
    SIDE_BAR: 'chrome',
    TOOL_MENU: 'chrome',
    TL: 'overlays',
    TR: 'overlays',
    BL: 'overlays',
    BR: 'overlays',
    DOCK: 'overlays',
    STAGE_OVERLAY: 'overlays',
    STAGE_GIZMOS: 'gizmos',
  };
  Object.assign(map, overrides);
  return map;
})();

/**
 * LAYER_TO_DEFAULT_SLOT: When user clicks a layer in 3D view,
 * which slot tab should be selected as the default representative.
 */
export const LAYER_TO_DEFAULT_SLOT: Record<string, string> = {
  root: 'ROOT_OVERLAY',
  viewport: 'VIEWPORT_OVERLAY',
  chrome: 'OPTION_BAR',
  overlays: 'STAGE_OVERLAY',
  gizmos: 'STAGE_GIZMOS',
  canvas: 'STAGE_OVERLAY', // Canvas has no direct slot, fall back
};
