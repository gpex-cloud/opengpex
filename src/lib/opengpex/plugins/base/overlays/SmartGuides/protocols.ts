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

/**
 * SmartGuides Plugin Protocols
 */
export const PLUGIN_ID = 'overlays.smart_guides';
export const PLUGIN_AUTHOR = 'opengpex';

/**
 * Custom Config Interface
 *
 * Snap-related settings (snapToCanvas, snapToBirth, snapToLayers, excludeLayerTypes,
 * ignoreLockedLayers, ignoreSmallLayers, smallLayerThreshold, maxSnapTargets,
 * edgeSnapScope) have been migrated to PresetsFactory (core/helpers/preferences/presets.ts).
 * This config now only holds plugin-specific UI state.
 *
 * @see docs/opengpex/plans/20260805_stage_reverse_dependency_issue.md
 */
export interface SmartGuidesConfig {
  enabled: boolean;
}

/**
 * Command IDs
 */
export const CMD_TOGGLE = 'cmd.toggle';
export const CMD_OPEN_SETTINGS = 'cmd.open_settings';

