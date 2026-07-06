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

import { Dimensions, CameraState, ExifData } from '@opengpex/editor/core/types';

/**
 * StorageInfoPanel Plugin Protocols
 */
export const PLUGIN_ID = 'panels.storage_info_panel';
export const PLUGIN_AUTHOR = 'opengpex';

/**
 * Command IDs
 */
export const CMD_TOGGLE = 'cmd.toggle';
export const CMD_TOGGLE_DASHBOARD = 'cmd.toggle_dashboard';

/**
 * Custom Config Interface
 */
export interface StoragePluginConfig {
  enabled: boolean;
  dashboardMode: boolean;
}

export interface AssetUsage {
  assetId: string;
  source: 'layer' | 'thumbnail' | 'clipboard' | 'history';
  frameId: string;
  frameName: string;
  layerName?: string;
}

export interface AssetMetric {
  id: string;
  blob: Blob;
  url: string;
  size: number;
  type: string;
  refCount: number;
  usages: AssetUsage[];
  tags: ('active' | 'history' | 'clipboard' | 'shared')[];
  tileMeta?: {
    width: number;
    height: number;
    cols?: number;
    rows?: number;
    [key: string]: unknown;
  };
}

/**
 * LayerMetric: Detailed layer data in tree structure
 */
export interface LayerMetric {
  id: string;
  name: string;
  type: 'image' | 'text' | 'vector' | 'color' | 'paint';
  visible: boolean;
  locked: boolean;
  opacity: number;
  bounding: Dimensions;
  asset?: AssetMetric;
  originalName?: string;
  format?: string;
  exif?: ExifData;
  hostId?: string;
  role?: string;
  subLayers?: LayerMetric[];
}

/**
 * FrameMetric: Asset view centered on Frame
 */
export interface FrameMetric {
  id: string;
  name: string;
  canvas: Dimensions;
  camera: CameraState;
  rotation: number;
  thumbnail?: AssetMetric;
  layers: LayerMetric[];
  historyCount: number;
}

/**
 * HistoryMoment: Visual representation of history moments
 */
export interface HistoryMoment {
  id: string;
  timestamp: number;
  label: string;
  thumbnailUrl: string;
  assets: AssetMetric[];
  totalSize: number;
  exclusiveSize: number; // Asset volume held only by this history moment (and other history moments) and not in the active frame
}

export interface DBShardMetric {
  key: string;
  type: 'project_meta' | 'frame' | 'history_index' | 'unknown';
  sizeBytes: number;
}

export interface StorageSummary {
  totalBytes: number;
  assetCount: number;
  stateBytes: number; // Estimated size of IndexedDB State DB
  shards: DBShardMetric[]; // Physical sharding status of IndexedDB
  frames: FrameMetric[];
  history: HistoryMoment[];
  detached: AssetMetric[]; // Assets existing only in unarchived cache
}
