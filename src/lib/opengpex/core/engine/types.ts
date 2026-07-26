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
 * engine/types — Type-only exports for cross-module type references.
 *
 * Consumers: core/types/services.ts (PixelService interface definition)
 *
 * This barrel exists to resolve the reverse dependency where core/types/
 * needs engine result/request types for the PixelService interface definition.
 * All exports are `type`-only — zero runtime cost.
 */

export type { CompositeRequest } from './dispatch/CompositeDispatcher';
export type { CompositeResult } from './results/CompositeResult';
export type { ResampleResult } from './results/ResampleResult';
export type { PixelResultData } from './protocol/results';
