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
 * LayerEffectsDrawer Plugin Protocols
 *
 * Constants and type contracts for the per-layer render-effects drawer
 * (A8). The tab rail is PER-INSTANCE (one tab per chain instance, render
 * order); the main area shows the active instance's parameter panel (P3
 * wires stroke, P5 shadow). The "+" inserts an instance of the ACTIVE tab's
 * category beneath it; deletion is floor-guarded (the chain never empties a
 * category).
 *
 * P4 will add the layers-drawer jump channel (a cross-plugin open signal).
 */

export const PLUGIN_ID = 'drawers.effects';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Command ids ──────────────────────────────────────────────────────────────
// The plugin-internal ids live here. The chain TOGGLE is not among them: it
// is a document mutation and lives in the core adv namespace
// (ADV_LAYER_EFFECT_TOGGLE). The jump command `cmd.open_effect_instance_panel`
// is also CONSUMED from another plugin (the layers-drawer family row) — it is
// exposed through the EffectsDrawerAPI facade below (the facade spec's
// cross-plugin invocation channel), so no id constant needs exporting.

export const CMD_BEGIN_EFFECT_EDIT = 'cmd.begin_effect_edit';
export const CMD_FAST_UPDATE_EFFECT = 'cmd.fast_update_effect';
export const CMD_COMMIT_EFFECT = 'cmd.commit_effect';
export const CMD_APPLY_EFFECT_PATCH = 'cmd.apply_effect_patch';
export const CMD_REMOVE_EFFECT_INSTANCE = 'cmd.remove_effect_instance';
export const CMD_OPEN_EFFECT_INSTANCE_PANEL = 'cmd.open_effect_instance_panel';

// ─── Cross-plugin jump channel (P4: the layers-drawer family row) ─────────────

/** Signal id carried on the plugin manifest (`scope: 'public'`). */
/** Signal id carried on the plugin manifest (`scope: 'public'`). Named after
 * what it CARRIES (the instance to activate), matching the
 * `signal.active_craft` precedent — a bare "signal.jump" says nothing once it
 * floats past a log line or a signal inspector. */
export const SIGNAL_ACTIVE_EFFECT_INSTANCE = 'signal.active_effect_instance';

/**
 * Cross-plugin API for the layers-drawer's ⤴ jump buttons (the
 * SettingsPanelAPI shape): open this drawer and activate the given instance's
 * tab. The jump command (`cmd.open_effect_instance_panel`) pushes the drawer uid onto
 * `ui.activeSidebarIds` and sets the signal to
 * `{ instanceId, nonce }` — the nonce lets the drawer's render-derived tab
 * resolution tell a fresh jump apart from a stale one without effects.
 */
export const EffectsDrawerAPI = {
  /** Runtime plugin uid (`<author>.<id>`) — the activeSidebarIds entry AND
   * the pluginConfig storage key for the drawer's persisted UI preferences. */
  uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}`,
  /**
   * pluginConfig under {@link EffectsDrawerAPI.uid} carries:
   * `lastSelectedEffect?: { layerId, id, category }` — the last tab the user
   * picked, persisted so a reload re-opens the drawer on the same effect
   * (AdjustmentDrawer `lastGradingTool` precedent: signal-free UI memory in
   * pluginConfig; validated against the active layer's chain at read time,
   * exact-then-category fallback when the instance disappeared).
   */
  signals: {
    jump: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_ACTIVE_EFFECT_INSTANCE}`,
  },
  commands: {
    // Only the cross-plugin-invoked command (the layers-drawer family row's
    // ⤴ jump); the gesture-session commands stay plugin-internal.
    openEffectInstancePanel: {
      uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_OPEN_EFFECT_INSTANCE_PANEL}`,
    } as { uid: string; _payload: { instanceId: string } },
  },
} as const;

// ─── Category display vocabulary ──────────────────────────────────────────────
// OWNED by the core vocabulary (`core/layer/effects` — the single seat, the
// adjustment-mask precedent); re-exported so the drawer's own code keeps a
// one-stop import surface.
export { EFFECT_CATEGORY_LABELS } from '@opengpex/editor/core/layer/effects';

/**
 * The full drawer tab table — ALL ten PS Layer Style categories. The rail
 * ALWAYS renders all ten tabs (the family's final shape is visible from day
 * one — user ruling 20261125); an unimplemented category is an EMPTY
 * PLACEHOLDER tab exactly like Shadow's before its pipeline lands (P5).
 * `id` doubles as the `EffectCategory` for available entries.
 */
export interface EffectTabDef {
  id: string;
  label: string;
  available: boolean;
}

export const EFFECT_TABS: readonly EffectTabDef[] = [
  // Only SHIPPED categories are listed (user ruling 20261126: the rail shows
  // implemented effects only; each future effect joins this list — by adding
  // one entry with `available: true` — at its FAMILY slot below, so the rail
  // order is stable across future growth). The `available` flag machinery
  // stays so that list growth needs no plumbing changes.
  //
  // Tab order groups effects BY NATURE (20261126 ruling, revised twice:
  // Stroke leads — the flagship outline effect; the shadow family pairs
  // outer/inner per the reference dialog order Shadow → Inner Shadow →
  // Outer Glow → Inner Glow; surface overlays follow). NOTE: this is the
  // DISPLAY order only — the on-canvas render stacking is a separate order
  // carried by EFFECT_RENDER_RANK in core/layer/effects.ts and never
  // follows tabs.
  { id: 'stroke', label: 'Stroke', available: true },
  { id: 'shadow', label: 'Shadow', available: true },
  { id: 'innerShadow', label: 'Inner Shadow', available: true },
  { id: 'outerGlow', label: 'Outer Glow', available: true },
  { id: 'innerGlow', label: 'Inner Glow', available: true },
  { id: 'colorOverlay', label: 'Color Overlay', available: true },
  { id: 'gradientOverlay', label: 'Grad Overlay', available: true },
] as const;

/** The shipped (chain-model-backed) categories, in tab display order. */
export const AVAILABLE_TAB_IDS: readonly EffectTabId[] = EFFECT_TABS
  .filter((t) => t.available)
  .map((t) => t.id as EffectTabId);

export type EffectTabId = 'shadow' | 'stroke' | 'colorOverlay' | 'outerGlow' | 'gradientOverlay' | 'innerGlow' | 'innerShadow';

/**
 * Categories where the "+" may create ANOTHER instance (per-effect multi/
 * single ruling 20261126, from the reference product's Layer Style panel:
 * the "+" appears on Stroke / Inner Shadow / Color Overlay / Gradient
 * Overlay / Drop Shadow only — Bevel, Inner Glow, Satin, Pattern Overlay
 * and Outer Glow are single-instance). Categories NOT listed here are
 * capped at one instance: their rail tab still exists (kept alive by the
 * lazy floor), but the "+" stays disabled on them.
 */
export const ADDABLE_CATEGORIES: readonly EffectTabId[] = ['stroke', 'shadow', 'innerShadow', 'colorOverlay', 'gradientOverlay'];

/**
 * A category tab with NO instance yet carries this virtual id — a TRANSIENT
 * state only: entering the category's panel lazily lands its disabled floor
 * instance (core `ensureEffectCategoryInstance`), and the eye on the virtual
 * tab creates the instance enabled directly (PS checkbox semantics, §5.2).
 * Real instance tabs always carry the instance id.
 */
export const VIRTUAL_TAB_PREFIX = 'virtual:';

export function virtualTabId(category: EffectTabId): string {
  return `${VIRTUAL_TAB_PREFIX}${category}`;
}

export function isVirtualTabId(tabId: string): boolean {
  return tabId.startsWith(VIRTUAL_TAB_PREFIX);
}

export function virtualTabCategory(tabId: string): EffectTabId {
  return tabId.slice(VIRTUAL_TAB_PREFIX.length) as EffectTabId;
}
