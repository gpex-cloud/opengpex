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
 * Shared utility functions for all AI tool panels.
 */

import type { ModelEntry } from './types';

// ─── Time Formatting ─────────────────────────────────────────────────────────

/**
 * Format milliseconds into a human-readable string.
 * - Under 1 second: "342ms"
 * - 1 second or more: "2.1s"
 */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Model List Sync ─────────────────────────────────────────────────────────

/**
 * Sync a persisted model list with the current built-in models from code.
 *
 * Handles version upgrades gracefully:
 * - Built-in models are updated to match the latest code definitions
 * - New built-in models (added in newer versions) are inserted at the top
 * - Removed built-in models (dropped in newer versions) are cleaned up
 * - User-added custom models are always preserved as-is
 *
 * @param models - The persisted model list (from localStorage/pluginConfig)
 * @param builtins - The current built-in models defined in code
 */
export function updateModelList<T extends ModelEntry>(models: T[], builtins: T[]): T[] {
  const builtinMap = new Map(builtins.map(b => [b.id, b]));
  const result = models
    .filter(m => !m.builtin || builtinMap.has(m.id))
    .map(m => {
      const latest = builtinMap.get(m.id);
      return latest ? { ...latest } : m;
    });
  for (const builtin of builtins) {
    if (!result.find(m => m.id === builtin.id)) {
      result.unshift(builtin);
    }
  }
  return result;
}
