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

'use client';

import { useMemo } from 'react';
import { usePluginSelfConfig, usePluginCommands } from '@opengpex/editor/core/context';
import * as P from './protocols';
import type { PixelGridOverlayCommandsMap } from './commands.d';

/**
 * usePixelGridCommands: Config + Command discovery hook.
 */
export function usePixelGridCommands() {
  const [selfConfig] = usePluginSelfConfig<P.PixelGridConfig>();
  const { toggleCmd, hardedgeToggleCmd } = usePluginCommands<PixelGridOverlayCommandsMap>();

  const isEnabled = selfConfig?.enabled ?? true;
  const isHardEdge = selfConfig?.hardEdge ?? false;
  const zoomThreshold = selfConfig?.zoomThreshold ?? 8;
  const gridColor = selfConfig?.color ?? 'rgba(255, 255, 255, 0.3)';

  return useMemo(() => ({
    isEnabled,
    isHardEdge,
    zoomThreshold,
    gridColor,
    toggleCmd,
    hardedgeToggleCmd,
  }), [isEnabled, isHardEdge, zoomThreshold, gridColor, toggleCmd, hardedgeToggleCmd]);
}
