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

/**
 * Re-export from hooks/ directory.
 * This file exists for backward-compatibility with existing imports from './hooks'.
 */
export {
  useStorageConfig,
  useStorageMetrics,
  useModelCacheMetrics,
  purgeModelCacheStorage,
} from './hooks/index';
export type { ModelCacheFileEntry, ModelCacheGroup, ModelCacheInfo } from './hooks/index';

import * as P from './protocols';

/**
 * Copy reference details to clipboard
 */
export const copyAssetUsages = (asset: P.AssetMetric) => {
  const usageLines = asset.usages.map(u =>
    `- [${u.source.toUpperCase()}] ${u.frameName}${u.layerName ? ` > ${u.layerName}` : ''}`
  );
  const text = `Asset ID: ${asset.id}\nSize: ${asset.size} bytes\nType: ${asset.type}\nReferences (${asset.refCount}):\n${usageLines.join('\n')}`;

  navigator.clipboard.writeText(text).then(() => {
    console.log('Copied asset usages to clipboard');
  });
};
