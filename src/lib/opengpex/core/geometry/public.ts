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
 * public.ts — Whitelisted public geometry exports for plugin code.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────
 *
 * The ESLint rule `no-restricted-imports` (see `eslint.config.mjs`) forbids
 * `plugins/**` from importing internal operators directly:
 *
 *     import ... from '@opengpex/editor/core/geometry/operators/*'   // ❌ blocked in plugins
 *
 * The intent is that plugins should consume geometry through the injected
 * `GeometryService` (`ctx.geometry.*` / `e.geometry.*` / `useEditorServices().geometry`),
 * so that internal operator refactors never ripple into the plugin layer.
 *
 * That rule only guards the `operators/*` subdirectory. Files at the geometry
 * ROOT (this file, `poly-clip.ts`, `sut-hod.ts`, `bresenham.ts`) are NOT blocked
 * and are treated as the deliberate public surface of the geometry engine.
 *
 * ── When to use this file ─────────────────────────────────────────────────────
 *
 * PREFER `GeometryService` (via context / InteractionEvent). Only use this file
 * as an escape hatch for the rare plugin code that genuinely cannot reach a
 * `GeometryService` instance — e.g. a pure utility/helper function with no
 * `ctx` / `e` / React-hook access in scope.
 *
 * ── What may be added here ────────────────────────────────────────────────────
 *
 * ONLY pure, DOM-free functions that are explicitly approved for direct plugin
 * consumption. Each `export` below is effectively an entry on that approved
 * whitelist. Do NOT re-export anything that touches the DOM/Canvas or that
 * carries heavy internal-only semantics — those belong behind the service.
 *
 * Usage from a plugin:
 *     import { <fn> } from '@opengpex/editor/core/geometry/public';
 *
 * ── Current whitelist ─────────────────────────────────────────────────────────
 *
 * (empty) — every current plugin call site can reach `GeometryService`, so no
 * function has needed this hatch yet. Add re-exports here only when a concrete,
 * service-less plugin call site appears, e.g.:
 *
 *     export { polygonToShape } from './operators/polygon';
 */

export {};
