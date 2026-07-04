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
 * ClipOverlay Interaction Handlers — Barrel Export
 *
 * Each handler is in its own module for maintainability:
 *   - guard.ts    — shared `makeCropToolGuard` strategy dispatch helper
 *   - clipbox.ts  — rect/ellipse crop box handler (resize, move, create, peel)
 *   - lasso.ts    — free-form polygon selection handler
 *   - wand.ts     — magic wand flood-fill selection handler
 */

export { createClipBoxHandler } from './clipbox';
export { createLassoHandler, lassoPreviewPathRef } from './lasso';
export { createWandHandler } from './wand';
