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

export const PLUGIN_ID = 'options.color_options';
export const PLUGIN_AUTHOR = 'opengpex';

import type { LucideIcon } from 'lucide-react';
import { MonitorUp } from 'lucide-react';
import { PipetteAllIcon, PipetteLayerIcon } from '@opengpex/editor/icons';
import type { ColorValue } from '@opengpex/editor/core/engine/color';

export const CMD_FILL_AS_LAYER = 'cmd.fill_as_layer';
export const CMD_SAMPLE_COLOR = 'cmd.sample_color';

/** Pick one sampler tool explicitly (tool-strip click, or the Tab cycle). */
export const CMD_SET_SAMPLER_TOOL = 'cmd.sampler_tool.set';

/**
 * Tab — next sampler tool while sampling. Deliberately declares NO keyboard
 * shortcut: see {@link SIGNAL_SAMPLER_ACTIVE} for why the overlay owns Tab.
 */
export const CMD_CYCLE_SAMPLER_FORWARD = 'cmd.sampler_tool.cycle_forward';

/** Shift+Tab — previous sampler tool. Same no-shortcut rule as forward. */
export const CMD_CYCLE_SAMPLER_BACKWARD = 'cmd.sampler_tool.cycle_backward';

/** Leave the canvas sampler (tool-strip "X"; Esc is handled by the overlay). */
export const CMD_EXIT_SAMPLER = 'cmd.exit_sampler';

// ─── Signal IDs ─────────────────────────────────────────────────────────────────

/**
 * Canvas sampler active — the eyedropper's modal lifecycle, promoted out of
 * component `useState` so commands (and other plugins) can read and drive it.
 * Ephemeral: never persisted to plugin config.
 *
 * KEYBOARD OWNERSHIP (why the sampler commands carry no `shortcut`): the
 * `HotkeyManager` picks the FIRST shortcut whose chord matches and calls
 * `preventDefault()` before the command's own guard runs, and the registry has
 * no priority ordering. Tab is already claimed by ClipOptions'
 * `cycleToolForward`, and Esc by its `exitClipMode`. A second declarative claim
 * would therefore either be dead (registered later) or silently break clip mode
 * (registered earlier). Since the sampler is a MODAL overlay, its keys are
 * routed the same way its clicks already are: a capture-phase `keydown`
 * listener that lives only while this signal is true (`hooks.ts` / the overlay),
 * which dispatches these commands. The commands stay the single implementation;
 * only the binding differs.
 */
export const SIGNAL_SAMPLER_ACTIVE = 'signal.sampler.active';

/** Contribution slot: tool trigger button injection slot (contributed by plugins like CraftDrawer) */
export const COLOR_OPTIONS_CRAFT_SLOT = 'COLOR_OPTIONS_CRAFT_SLOT';

// ─── Sampler Tools ──────────────────────────────────────────────────────────────

/**
 * SamplerTool: the three peer eyedroppers.
 *
 * - `'all'`    — canvas, full visible composite.
 * - `'layer'`  — canvas, active layer only (its non-group descendants when it is
 *                a group). Same scope the old dropdown toggle set.
 * - `'screen'` — the browser's native `EyeDropper`: the whole screen, outside the
 *                canvas included. Not GPU-sampleable, hence no snapshot, no
 *                magnifier and no wide-gamut readout (it returns sRGB hex only).
 *
 * `'all'` / `'layer'` are two projections of ONE persisted field
 * (`ColorOptionsConfig.sampleAllLayers`) — they are not stored separately.
 * `'screen'` is MOMENTARY: picking it leaves the canvas overlay and hands over to
 * the native picker, so it is never an "active" tool and never persisted.
 */
export type SamplerTool = 'all' | 'layer' | 'screen';

/** Strip grouping — a divider is drawn where this changes. */
export type SamplerFamily = 'canvas' | 'screen';

/**
 * Where a tool's button lives — and, as a direct consequence, whether Tab
 * cycles it.
 *
 * - `'strip'` — inside the sampler's modal popover, which only exists WHILE
 *               canvas sampling is on. These are the tools Tab cycles.
 * - `'bar'`   — a permanent button in the option bar, next to the pipette.
 *               An independent entry point, not a mode of the canvas sampler,
 *               so it stays out of the cycle: `'screen'` is momentary, and a
 *               ring containing it could not be traversed without firing it.
 */
export type SamplerSurface = 'strip' | 'bar';

export interface SamplerToolStrategy {
  readonly id: SamplerTool;
  readonly label: string;
  readonly icon: LucideIcon | React.ComponentType<{ size?: number; className?: string }>;
  readonly accent: 'amber' | 'indigo';
  readonly family: SamplerFamily;
  readonly surface: SamplerSurface;
  /**
   * The `sampleAllLayers` value this tool implies, or `null` when the tool does
   * not touch the canvas scope at all (`'screen'`).
   */
  readonly sampleAllLayers: boolean | null;
  /**
   * `true` when selecting the tool ENDS canvas sampling instead of staying in
   * it. Only `'screen'`: the native picker is its own modal and cannot coexist
   * with our overlay (it would sample our crosshair).
   */
  readonly exitsCanvasSampling: boolean;
  /**
   * Runtime availability gate. `'screen'` needs `window.EyeDropper`, which
   * Safari and Firefox still lack — the bar hides the button rather than
   * offering one that silently does nothing.
   */
  readonly available?: () => boolean;
}

/**
 * Single Source of Truth for the sampler buttons, the Tab cycle and the scope
 * each tool implies. Adding a tool = adding one row.
 */
export const SAMPLER_TOOL_STRATEGIES: Record<SamplerTool, SamplerToolStrategy> = {
  'all':    { id: 'all',    label: 'Sample All Layers',    icon: PipetteAllIcon,   accent: 'amber',  family: 'canvas', surface: 'strip', sampleAllLayers: true,  exitsCanvasSampling: false },
  'layer':  { id: 'layer',  label: 'Sample Current Layer', icon: PipetteLayerIcon, accent: 'amber',  family: 'canvas', surface: 'strip', sampleAllLayers: false, exitsCanvasSampling: false },
  'screen': { id: 'screen', label: 'Native Sampler',        icon: MonitorUp,        accent: 'indigo', family: 'screen', surface: 'bar',   sampleAllLayers: null,  exitsCanvasSampling: true,
              available: () => typeof window !== 'undefined' && 'EyeDropper' in window },
};

/** Tools present in this browser, in declaration order. */
export const availableSamplerTools = (): SamplerToolStrategy[] =>
  (Object.values(SAMPLER_TOOL_STRATEGIES) as SamplerToolStrategy[])
    .filter((s) => !s.available || s.available());

/** Modal-popover tools, in strip / Tab-cycle order. */
export const samplerStripTools = (): SamplerToolStrategy[] =>
  availableSamplerTools().filter((s) => s.surface === 'strip');

/** Option-bar tools (permanent buttons beside the pipette). */
export const samplerBarTools = (): SamplerToolStrategy[] =>
  availableSamplerTools().filter((s) => s.surface === 'bar');

/** Which canvas tool the persisted scope corresponds to. `'screen'` is never it. */
export const samplerToolFromScope = (sampleAllLayers: boolean): SamplerTool =>
  sampleAllLayers ? 'all' : 'layer';

export interface ColorOptionsConfig {
  /** Structured foreground colour — the wide-gamut currency (proposal §3.1). */
  pendingColor: ColorValue;
  /**
   * Sampler scope: `true`/absent = the full visible composite (historical
   * behaviour), `false` = the active layer only (its non-group descendants when
   * it is a group). Applies to BOTH the press-time freeze snapshot and the
   * commit-time 1:1 micro-capture — they must never disagree.
   */
  sampleAllLayers?: boolean;
}

// ─── Cross-Plugin Typed Facade ──────────────────────────────────────────────────

/**
 * ColorOptionsAPI: Structured cross-plugin facade for external consumers.
 *
 * Usage:
 *   import { ColorOptionsAPI } from '../../options/ColorOptions/protocols';
 *   const [config] = usePluginConfig<ColorOptionsConfig>(ColorOptionsAPI.configKey);
 *   actions.updatePluginConfig(ColorOptionsAPI.configKey, { pendingColor: fromHex('#FF0000') });
 *   // Contribution slot:
 *   contributions: [{ slot: ColorOptionsAPI.slots.craft, component: MyButtons }]
 */
export const ColorOptionsAPI = {
  /** pluginConfig storage key */
  configKey: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
  signals: {
    /** Canvas sampler active (ephemeral modal lifecycle) */
    samplerActive: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_SAMPLER_ACTIVE}` as const,
  },
  commands: {
    /** Enter / leave the canvas sampler */
    sampleColor: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_SAMPLE_COLOR}` } as { uid: string; _payload: void },
    /** Pick a sampler tool (canvas scope, or hand over to the native picker) */
    setSamplerTool: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_SET_SAMPLER_TOOL}` } as { uid: string; _payload: { tool: SamplerTool } },
  },
  /** Contribution slots exposed for external plugin injection */
  slots: {
    /** Tool trigger buttons slot (contributed by CraftDrawer) */
    craft: COLOR_OPTIONS_CRAFT_SLOT,
  },
} as const;
