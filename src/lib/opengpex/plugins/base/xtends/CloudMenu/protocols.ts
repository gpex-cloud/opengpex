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

export const PLUGIN_ID = 'xtends.cloud_menu';
export const PLUGIN_AUTHOR = 'opengpex';

export const CMD_SAVE_TO_CLOUD = 'cmd.save_to_cloud';
export const CMD_OPEN_FROM_CLOUD = 'cmd.open_from_cloud';
export const CMD_DELETE_FROM_CLOUD = 'cmd.delete_from_cloud';

/** Default cloud API endpoint */
export const DEFAULT_CLOUD_URL = process.env.NEXT_PUBLIC_GPEX_CLOUD_URL || 'https://gpex.cloud';

/** Plugin config shape */
export interface CloudMenuConfig {
  cloudUrl: string;
}

export type SavePhase = 'IDLE' | 'PACKING' | 'UPLOADING' | 'DONE' | 'ERROR';

export interface SaveResult {
  fileId: string;
  version: number;
}

export interface SyncRecord {
  version: number;
  savedAt: string;
  /** history.past.length at the time of last save/download */
  savedHistoryLength: number;
}

export { CORE_VERSION as APP_VERSION } from '@opengpex/editor/core/plugin/version';
export const SYNC_STORAGE_PREFIX = 'gpex_sync_';

