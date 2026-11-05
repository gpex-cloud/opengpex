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
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use client';

import { Layout, Box, Target, Layers2, HelpCircle } from 'lucide-react';
import type { EditorSlot } from '@opengpex/editor/core/types';
import { EDITOR_Z_INDEX } from '@opengpex/editor/core/helpers/config';

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
// Segment Matrix Schema — mirrors EDITOR_Z_INDEX (gpex-assets arch/21 spec).
// The panel is the visual twin of that matrix: every segment base is read
// live from the constants so this schema can never drift from the real
// stacking order.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SegmentDefinition: one 1000-span isolation domain of the z-index matrix.
 * Segments carrying a portalRootId are stacking-context islands: their
 * interior values are component-level free space and never compare with the
 * outside; only the root's base is visible externally.
 */
export interface SegmentDefinition {
  id: string;
  level: string;          // Display label "S0".."S6"
  name: string;           // Descriptive title
  base: number;           // Segment base value, read from EDITOR_Z_INDEX
  color: string;          // Key into SEGMENT_COLORS (full class-name table)
  portalRootId?: string;  // Present ⇒ this segment hosts a portal island root
  note?: string;          // Island / special-case annotation
}

/**
 * SEGMENT_STACK: ordered bottom-to-top segment list. The segment bases are
 * sourced from EDITOR_Z_INDEX so the 3D stack, the runtime audit and the real
 * DOM all derive from one truth.
 */
export const SEGMENT_STACK: SegmentDefinition[] = [
  {
    id: 'stage', level: 'S0', name: 'Stage', base: EDITOR_Z_INDEX.STAGE.BACKDROP,
    color: 'emerald',
    note: 'STAGE_GIZMOS (200) lives inside the stageRef transform island — it never competes outside the artboard',
  },
  {
    id: 'chrome', level: 'S1', name: 'Workspace Chrome', base: EDITOR_Z_INDEX.CHROME.DRAWER_BAR,
    color: 'amber',
  },
  {
    id: 'popup', level: 'S2', name: 'Popups', base: EDITOR_Z_INDEX.POPUP.PORTAL_ROOT,
    color: 'rose', portalRootId: 'editor-portal-root',
    note: 'Island interior: Popover 2010 · Tooltip 2020 · ComboInput dropdown 1100 (known defect, untouched by design)',
  },
  {
    id: 'fullscreen', level: 'S3', name: 'Canvas Fullscreen', base: EDITOR_Z_INDEX.FULLSCREEN.OVERLAY,
    color: 'violet',
    note: 'Brush / eraser / mosaic surfaces — deliberately BELOW dialogs: a dialog must cover the brush',
  },
  {
    id: 'modal', level: 'S4', name: 'Modals & Notifications', base: EDITOR_Z_INDEX.MODAL.PORTAL_ROOT,
    color: 'sky', portalRootId: 'editor-portal-root-modal',
    note: 'Modal root 4000 — island interior: Onboarding 4010 · Dialog 4020 · forModal Popover 4030 / Tooltip 4040; outside: PROMPT 4800 (FancyChoice/Confirm) · NOTIFICATION 4810',
  },
  {
    id: 'window', level: 'S5', name: 'Window Surfaces', base: EDITOR_Z_INDEX.WINDOW.PORTAL_ROOT,
    color: 'orange', portalRootId: 'editor-portal-root-window',
    note: 'Island interior: Context Menu 5010 — BranchFlyEffect 5200 is hosted outside the island',
  },
  {
    // No portal root in this segment: the base is the segment start derived
    // from its only seat, never a seat of its own.
    id: 'top', level: 'S6', name: 'Topmost', base: Math.floor(EDITOR_Z_INDEX.TOP.FULLSCREEN_CAPTURE / 1000) * 1000,
    color: 'fuchsia',
    note: 'Colour-sampler capture 6900 is the absolute ceiling (body portal by design)',
  },
];

/**
 * SlotSegmentBinding: where a plugin slot sits in the matrix — which segment
 * it belongs to and which named seat (with its value) hosts it.
 */
export interface SlotSegmentBinding {
  segmentId: string;
  seatLabel: string;
}

/**
 * SLOT_SEGMENT_MAP: authoritative slot→matrix bindings. ROOT_OVERLAY is the
 * documented exception: its container has z-index auto (level 0 in the root
 * stacking context), so any content that must float has to go through a
 * portal segment root.
 */
export const SLOT_SEGMENT_MAP: Record<string, SlotSegmentBinding> = {
  STAGE_GIZMOS: { segmentId: 'stage', seatLabel: 'GIZMOS 200 (stageRef island)' },
  STAGE_OVERLAY: { segmentId: 'stage', seatLabel: 'OVERLAY 300' },
  TL: { segmentId: 'chrome', seatLabel: 'VIEWPORT_HUD 1100' },
  TR: { segmentId: 'chrome', seatLabel: 'VIEWPORT_HUD 1100' },
  BL: { segmentId: 'chrome', seatLabel: 'VIEWPORT_HUD 1100' },
  BR: { segmentId: 'chrome', seatLabel: 'VIEWPORT_HUD 1100' },
  DOCK: { segmentId: 'chrome', seatLabel: 'DOCK 1110' },
  TOOL_MENU: { segmentId: 'chrome', seatLabel: 'FLOATING_MENU 1200' },
  OPTION_BAR: { segmentId: 'chrome', seatLabel: 'FLOATING_MENU 1200' },
  SIDE_BAR: { segmentId: 'chrome', seatLabel: 'DRAWER_BAR 1000' },
  ROOT_OVERLAY: { segmentId: 'stage', seatLabel: 'z-auto (level 0) — floating content must go through a portal root' },
};

/** Fallback binding for dynamically discovered slots: they reach the screen
 * through the popup island (or are plain floats with their own seats). */
export const FALLBACK_SEGMENT_BINDING: SlotSegmentBinding = {
  segmentId: 'popup',
  seatLabel: 'via portal',
};

/**
 * SlotGroupDefinition: semantic grouping of slots for the registry explorer.
 */
export interface SlotGroupDefinition {
  id: string;
  name: string;
  icon: React.ComponentType<{ size?: number; className: string }>;
  slots: EditorSlot[];
  segmentId: string;        // Which segment this group belongs to
}

/**
 * SLOT_GROUPS: declarative grouping of slots into spatial categories.
 * Unknown slots discovered at runtime fall into the Extensions group.
 */
export const SLOT_GROUPS: SlotGroupDefinition[] = [
  {
    id: 'layout_chrome',
    name: 'Layout Chrome',
    icon: Layout,
    slots: ['OPTION_BAR', 'SIDE_BAR'],
    segmentId: 'chrome',
  },
  {
    id: 'tool_systems',
    name: 'Tool Systems',
    icon: Box,
    slots: ['TOOL_MENU'],
    segmentId: 'chrome',
  },
  {
    id: 'viewport_corners',
    name: 'HUD & Corners',
    icon: Target,
    slots: ['TL', 'TR', 'BL', 'BR', 'DOCK'],
    segmentId: 'chrome',
  },
  {
    id: 'overlays_gizmos',
    name: 'Overlays',
    icon: Layers2,
    slots: ['ROOT_OVERLAY', 'VIEWPORT_OVERLAY', 'STAGE_OVERLAY', 'STAGE_GIZMOS'],
    segmentId: 'stage',
  },
];

/**
 * FALLBACK_GROUP: auto-generated group for dynamically discovered slots.
 */
export const FALLBACK_GROUP_TEMPLATE: Omit<SlotGroupDefinition, 'slots'> = {
  id: 'dynamic_extensions',
  name: 'Extensions',
  icon: HelpCircle,
  segmentId: 'popup',
};

// ─────────────────────────────────────────────────────────────────────────────
// Colour table — full class names only. Tailwind's JIT cannot see classes
// assembled at runtime (`bg-${c}-500`), so every shade is spelled out here.
// ─────────────────────────────────────────────────────────────────────────────

export interface SegmentColorSet {
  /** Focused segment box border */
  focusBorder: string;
  /** Focused selector chip background (solid) */
  focusBg: string;
  /** Soft chip: seat labels, unfocused accents */
  chip: string;
  /** Body text accent */
  text: string;
  /** Hover border for unfocused selector items */
  hoverBorder: string;
  /** Translucent box fill so lower segments read through the stack */
  tint: string;
  /** Resting box border */
  border: string;
}

export const SEGMENT_COLORS: Record<string, SegmentColorSet> = {
  emerald: {
    focusBorder: 'border-emerald-500', focusBg: 'bg-emerald-500',
    chip: 'bg-emerald-500/15 text-emerald-600', text: 'text-emerald-600',
    hoverBorder: 'hover:border-emerald-500/50',
    tint: 'bg-emerald-500/[0.07]', border: 'border-emerald-500/35',
  },
  amber: {
    focusBorder: 'border-amber-500', focusBg: 'bg-amber-500',
    chip: 'bg-amber-500/15 text-amber-600', text: 'text-amber-600',
    hoverBorder: 'hover:border-amber-500/50',
    tint: 'bg-amber-500/[0.07]', border: 'border-amber-500/35',
  },
  rose: {
    focusBorder: 'border-rose-500', focusBg: 'bg-rose-500',
    chip: 'bg-rose-500/15 text-rose-600', text: 'text-rose-600',
    hoverBorder: 'hover:border-rose-500/50',
    tint: 'bg-rose-500/[0.07]', border: 'border-rose-500/35',
  },
  violet: {
    focusBorder: 'border-violet-500', focusBg: 'bg-violet-500',
    chip: 'bg-violet-500/15 text-violet-600', text: 'text-violet-600',
    hoverBorder: 'hover:border-violet-500/50',
    tint: 'bg-violet-500/[0.07]', border: 'border-violet-500/35',
  },
  sky: {
    focusBorder: 'border-sky-500', focusBg: 'bg-sky-500',
    chip: 'bg-sky-500/15 text-sky-600', text: 'text-sky-600',
    hoverBorder: 'hover:border-sky-500/50',
    tint: 'bg-sky-500/[0.07]', border: 'border-sky-500/35',
  },
  orange: {
    focusBorder: 'border-orange-500', focusBg: 'bg-orange-500',
    chip: 'bg-orange-500/15 text-orange-600', text: 'text-orange-600',
    hoverBorder: 'hover:border-orange-500/50',
    tint: 'bg-orange-500/[0.07]', border: 'border-orange-500/35',
  },
  fuchsia: {
    focusBorder: 'border-fuchsia-500', focusBg: 'bg-fuchsia-500',
    chip: 'bg-fuchsia-500/15 text-fuchsia-600', text: 'text-fuchsia-600',
    hoverBorder: 'hover:border-fuchsia-500/50',
    tint: 'bg-fuchsia-500/[0.07]', border: 'border-fuchsia-500/35',
  },
};
