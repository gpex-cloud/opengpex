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
import { usePluginSelfConfig, usePluginCommands, useEditorState } from '@opengpex/editor/core/context';
import * as P from './protocols';

/**
 * useSmartGuides: Unified hook for smart guides (State observation + commands).
 */
export const useSmartGuides = () => {
  const { state, activeFrame } = useEditorState();
  const [selfConfig] = usePluginSelfConfig<P.SmartGuidesConfig>();
  const { toggleCmd } = usePluginCommands();

  return useMemo(() => {
    const { smartguides } = state.interaction;
    const isEnabled = selfConfig?.enabled ?? true;

    const data = (!isEnabled || !smartguides || !activeFrame)
      ? { isVisible: false, isEnabled }
      : { isVisible: true, isEnabled, smartguides };

    return {
      ...data,
      toggleCmd,
    };
  }, [state.interaction, selfConfig, activeFrame, toggleCmd]);
};
