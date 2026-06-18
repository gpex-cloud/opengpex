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
import { useEditorState, usePluginSelfConfig, usePluginCommands } from '@opengpex/editor/core/context';
import * as P from './protocols';

import { formatBytes } from '@opengpex/editor/core/helpers/file';
import { calcFinalDims } from './utils';

/**
 * useImageInfoCommands: Semantic action hook.
 */
export const useImageInfoCommands = () => {
   const { state, activeFrame } = useEditorState();
   const [selfConfig, setSelfConfig] = usePluginSelfConfig<P.ExportConfig>();
    const { downloadCmd, applyResizeCmd } = usePluginCommands();

    return useMemo(() => {
       const mainLayer = activeFrame ? activeFrame.layers.byId[activeFrame.layers.order[0]] : undefined;
       const metadata = mainLayer?.metadata;

       const isClipMode = state.interaction.interactionMode === 'clip';
       const cropBox = activeFrame?.imageCropBox;
       const baseW = isClipMode && cropBox ? cropBox.rect.w : (activeFrame?.canvas.w || 0);
       const baseH = isClipMode && cropBox ? cropBox.rect.h : (activeFrame?.canvas.h || 0);

       return {
          state: {
             config: selfConfig,
             activeFrame,
             isClipMode,
             finalDims: activeFrame ? calcFinalDims(baseW, baseH, selfConfig) : { w: 0, h: 0 },
             fileSize: metadata?.size ? formatBytes(metadata.size) : '---',
             fileFormat: (metadata?.format || 'image/png').split('/')[1]?.toUpperCase() || 'PNG',
             fileName: activeFrame?.name || 'Untitled',
             layerCount: activeFrame?.layers.order.length || 0,
             engineStatuses: state.runtime.engineStatuses || [],
             exif: metadata?.exif,
          },
          updateConfig: setSelfConfig,
          // Plugin Commands (transparently passed Cmd references)
          downloadCmd,
          applyResizeCmd,
       };
    }, [state, selfConfig, activeFrame, setSelfConfig, downloadCmd, applyResizeCmd]);
};
