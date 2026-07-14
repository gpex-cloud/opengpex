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

"use client";

import { usePluginSignals } from "@opengpex/editor/core/context";
import type { UpscaleStatus } from "./protocols";
import { INITIAL_UPSCALE_STATUS } from "./protocols";
import type { AIToolsDrawerSignalsMap } from "../commands.d";

/**
 * useUpscaleStatus: Read the current Upscale status from signals.
 *
 * Returns the live UpscaleStatus object (stage, device, progress, tiles, etc.)
 * which drives the UpscalerPanel UI.
 */
export function useUpscaleStatus(): UpscaleStatus {
  const { upscaleStatusSignal } = usePluginSignals<AIToolsDrawerSignalsMap>();
  const status = upscaleStatusSignal?.value as UpscaleStatus | undefined;
  return status ?? INITIAL_UPSCALE_STATUS;
}
