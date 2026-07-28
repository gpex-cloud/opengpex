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
 * DisplayTransform — Post-composite display transform pipeline types.
 *
 * Display Transform is the rendering pipeline stage between "layer composite"
 * and "screen output". It handles view-only transformations that affect the
 * viewport preview without modifying document data.
 *
 * Current: Channel View (single-channel grayscale isolation)
 * Future: ICC color management, soft-proof, HDR exposure preview
 */

/**
 * Channel visibility mask for viewport display.
 * Controls which channel(s) of the composite result are displayed.
 *
 * Single-channel values ('red', 'green', 'blue', 'alpha') display as **grayscale**.
 * Multi-channel values ('rg', 'rb', 'gb') display in **color** with disabled channels zeroed.
 */
export type ChannelMask =
  | 'rgb'     // Normal display (default) — all channels, full color
  | 'red'     // Red channel as grayscale
  | 'green'   // Green channel as grayscale
  | 'blue'    // Blue channel as grayscale
  | 'alpha'   // Alpha channel as grayscale
  | 'rg'      // Red + Green in color (Blue zeroed)
  | 'rb'      // Red + Blue in color (Green zeroed)
  | 'gb';     // Green + Blue in color (Red zeroed)

/**
 * Per-channel visibility state for UI toggle management.
 * ChannelsPanel maintains this locally and derives the ChannelMask string from it.
 */
export interface ChannelVisibility {
  r: boolean;
  g: boolean;
  b: boolean;
  a: boolean;
}

/**
 * Derive ChannelMask from per-channel visibility toggles.
 * Used by UI to convert toggle state → engine signal value.
 */
export function deriveChannelMask(vis: ChannelVisibility): ChannelMask {
  const { r, g, b, a } = vis;

  // Alpha-only takes priority (special grayscale view)
  if (a && !r && !g && !b) return 'alpha';

  // Count active RGB channels
  const count = (r ? 1 : 0) + (g ? 1 : 0) + (b ? 1 : 0);

  if (count === 3) return 'rgb';
  if (count === 0) return 'rgb'; // All off → show as normal (safety)

  // Single channel → grayscale
  if (count === 1) {
    if (r) return 'red';
    if (g) return 'green';
    return 'blue';
  }

  // Two channels → color with one zeroed
  if (r && g) return 'rg';
  if (r && b) return 'rb';
  return 'gb'; // g && b
}

/**
 * DisplayTransformConfig: Controls viewport preview transformation.
 * Does NOT modify document data — only affects screen output.
 */
export interface DisplayTransformConfig {
  /** Channel visibility mask */
  channelMask: ChannelMask;

  // ─── Future extensions ───
  // iccProfile?: string;        // Color management
  // softProof?: SoftProofConfig; // Print simulation
  // exposure?: number;           // HDR exposure preview
}

/**
 * Signal key for reading/writing the active channel mask of the Display Transform pipeline.
 * Stored in `state.interaction.signals[DISPLAY_CHANNEL_SIGNAL_KEY]`.
 *
 * Named under the `display_transform` namespace (not `drawers.layers`) because:
 * - It belongs to the rendering engine's Display Transform stage, not any specific plugin
 * - Future Display Transform extensions (ICC, soft-proof, exposure) will share this namespace
 * - Any plugin (not just LayersDrawer) should be able to read/write it
 *
 * Consumers:
 * - CanvasStage (reads signal → passes DisplayTransformConfig to renderer)
 * - LayersDrawer ChannelsPanel (writes signal on user interaction)
 */
export const DISPLAY_CHANNEL_SIGNAL_KEY = 'engine.display_transform.channel_mask';
