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
 * cache/ barrel export — main-thread caches.
 *
 * v2 note: `filterCache` (the "AsyncFilterCache" of spec §15) is GONE along
 * with the Track A / Track B dual-track preview it coordinated. Adjustments now
 * live permanently on the GPU — there is no filtered-bitmap cache to keep, no
 * Worker RPC to debounce, and no anti-flash bridge state machine (§2.2).
 *
 * `sourceBitmapCache` and `tileCache` survive: they cache DECODED SOURCE
 * pixels, which the WebGPU engine still needs as the upload source for
 * `IEngine.upload()`.
 */

export { sourceBitmapCache } from './SourceBitmapCache';
export { tileCache } from './TileCache';
export type { TileFetcher } from './TileCache';
