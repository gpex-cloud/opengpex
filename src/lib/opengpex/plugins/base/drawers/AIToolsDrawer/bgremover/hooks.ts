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
import type { BgRemoverStatus } from "./protocols";
import { INITIAL_STATUS } from "./protocols";
import type { AIToolsDrawerSignalsMap } from "../commands.d";

/**
 * useBgRemoverStatus: Read the current BgRemover status from signals.
 *
 * Returns the live status object (stage, device, progress, etc.) which
 * drives the Drawer UI state machine.
 */
export function useBgRemoverStatus(): BgRemoverStatus {
  const { statusSignal } = usePluginSignals<AIToolsDrawerSignalsMap>();
  const status = statusSignal?.value as BgRemoverStatus | undefined;
  return status ?? INITIAL_STATUS;
}
