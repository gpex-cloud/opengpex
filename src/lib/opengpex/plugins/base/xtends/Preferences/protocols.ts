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

// ─── Plugin Identity ────────────────────────────────────────────────────────
export const PLUGIN_ID = 'xtends.preferences';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── LocalStorage Key ───────────────────────────────────────────────────────

/**
 * Key used to persist PresetsFactory overrides in localStorage.
 * Chosen over IndexedDB for synchronous hydrate at startup — presets.get()
 * is called in wheel event handlers before any async operation can complete.
 */
export const STORAGE_KEY_PRESETS_OVERRIDES = 'gpex_presets_overrides';
