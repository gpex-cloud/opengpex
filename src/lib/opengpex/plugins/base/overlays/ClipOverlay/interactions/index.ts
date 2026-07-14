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
 *   - guard.ts              — shared `makeClipToolGuard` strategy dispatch helper
 *   - move.ts              — unified move + peel for ALL selection types (tool-agnostic)
 *   - tools/regular.ts      — rect/ellipse crop box handler (resize, create)
 *   - tools/lasso.ts        — free-form polygon selection handler (create)
 *   - tools/wand.ts         — magic wand flood-fill selection handler (create)
 */

export { createSelectionMoveHandler } from './move';
export { createClipBoxHandler } from './tools/regular';
export { createLassoHandler, lassoPreviewPathRef } from './tools/lasso';
export { createWandHandler } from './tools/wand';
export { createSamHandler } from './tools/sam';
