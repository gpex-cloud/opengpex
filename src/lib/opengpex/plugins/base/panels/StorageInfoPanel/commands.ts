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

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import * as P from './protocols';

/**
 * STORAGE_COMMANDS: Declarative command configurations (Single Source of Truth).
 */
export const STORAGE_COMMANDS = {
  toggle: {
    id: P.CMD_TOGGLE,
    name: 'Toggle Storage HUD',
    execute: (ctx: EditorContextValue) => {
      const { selfConfig, setSelfConfig } = ctx.scoped || {};
      const config = (selfConfig as P.StoragePluginConfig) || { enabled: false, dashboardMode: false };
      setSelfConfig?.({ enabled: !config.enabled, dashboardMode: config.dashboardMode });
    },
  } as EditorCommand<void, void>,

  toggleDashboard: {
    id: P.CMD_TOGGLE_DASHBOARD,
    name: 'Toggle Expanded Storage Dashboard',
    execute: (ctx: EditorContextValue) => {
      const { selfConfig, setSelfConfig } = ctx.scoped || {};
      const config = (selfConfig as P.StoragePluginConfig) || { enabled: false, dashboardMode: false };
      setSelfConfig?.({ enabled: config.enabled, dashboardMode: !config.dashboardMode });
    },
  } as EditorCommand<void, void>,
};
