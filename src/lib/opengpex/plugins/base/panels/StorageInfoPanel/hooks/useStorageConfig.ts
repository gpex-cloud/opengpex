/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use client';

import { usePluginSelfConfig, usePluginCommands } from '@opengpex/editor/core/context';
import type { StorageInfoPanelCommandsMap } from '../commands.d';
import * as P from '../protocols';

/**
 * useStorageConfig: Gets plugin configuration toggle state and display mode via usePluginSelfConfig
 */
export const useStorageConfig = () => {
  const [selfConfig] = usePluginSelfConfig<P.StoragePluginConfig>();
  const { toggleCmd, toggleDashboardCmd } = usePluginCommands<StorageInfoPanelCommandsMap>();

  return {
    isEnabled: selfConfig?.enabled === true,
    dashboardMode: selfConfig?.dashboardMode === true,
    toggleCmd,
    toggleDashboardCmd,
  };
};
