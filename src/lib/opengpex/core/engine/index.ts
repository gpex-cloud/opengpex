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
 * engine/ — Barrel export module (Facade layer).
 *
 * Public surface (Tier 1 — Context/Service construction):
 *   - createPixelFacade (factory for PixelService)
 *   - WorkerBridge (transport layer for main↔worker communication)
 *
 * Other public sub-paths:
 *   - engine/renderer  → Onscreen rendering subsystem (Stage layer)
 *   - engine/filters   → Pure filter algorithms + pixel utils (Plugin layer)
 *   - engine/types     → Type-only exports (core/types layer)
 *
 * Internal modules (dispatchers, results, caches, worker handlers) are NOT
 * re-exported here; consumers should use the appropriate sub-path barrel
 * or interact through the PixelService facade.
 */

// ── Facade ──
export { createPixelFacade } from './facade/PixelFacade';
export type { PixelFacadeDeps } from './facade/PixelFacade';

// ── Bridge (needed by EditorContext to construct) ──
export { WorkerBridge } from './dispatch/bridge/WorkerBridge';
