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
import type { ImageMetadata } from '@opengpex/editor/core/files';
import type { ImageInfoDrawerCommandsMap } from './commands.d';
import * as P from './protocols';

import { formatBytes } from '@opengpex/editor/core/helpers/file';

/**
 * useImageInfoMetadata — Derives **stable** display data from the active frame.
 *
 * This data only changes when:
 * - A different frame becomes active (frame switch / open file)
 * - The base layer metadata changes (rare, only during import)
 *
 * By isolating this from interactionMode / config, we prevent the info panels
 * from re-rendering during normal editor interactions (pan, hover, tool switch).
 */
export function useImageInfoMetadata() {
   const { activeFrame, state } = useEditorState();

   return useMemo(() => {
      if (!activeFrame) {
         return {
            activeFrame: null as typeof activeFrame,
            fileName: 'Untitled',
            fileFormat: 'PNG',
            fileSize: '---',
            imageMetadata: undefined as ImageMetadata | undefined,
            layerCount: 0,
            frameDpi: 72,
            sourceBitDepth: undefined as number | undefined,
            isSingleLayer: false,
         };
      }

       // Read document-level metadata from frame (migrated from layer.metadata.imageMetadata)
       const imageMetadata = activeFrame.metadata;

      const visibleContentLayers = activeFrame.layers.order.filter(id => {
         const l = activeFrame.layers.byId[id];
         return !l.hostId && l.visible !== false;
      });

      return {
         activeFrame,
         fileName: imageMetadata?.sourceFileName || activeFrame.name || 'Untitled',
         fileFormat: imageMetadata?.sourceFormat?.toUpperCase() || 'PNG',
         fileSize: imageMetadata?.sourceFileSize ? formatBytes(imageMetadata.sourceFileSize) : '---',
         imageMetadata,
         layerCount: activeFrame.layers.order.length,
         frameDpi: activeFrame.dpi || 72,
         sourceBitDepth: imageMetadata?.bitDepth,
         isSingleLayer: visibleContentLayers.length === 1,
      };
   }, [activeFrame]);
}

/**
 * useExportConfig — Provides export configuration state and command handles.
 *
 * Changes when: user adjusts resize/format/quality settings.
 * Does NOT change on: viewport pan, layer hover, tool changes.
 */
export function useExportConfig() {
   const [selfConfig, setSelfConfig] = usePluginSelfConfig<P.ExportConfig>();
   const { downloadCmd, applyResizeCmd } = usePluginCommands<ImageInfoDrawerCommandsMap>();

   return useMemo(() => ({
      config: selfConfig,
      updateConfig: setSelfConfig,
      downloadCmd,
      applyResizeCmd,
   }), [selfConfig, setSelfConfig, downloadCmd, applyResizeCmd]);
}

/**
 * useClipMode — Extracts the interaction mode (clip vs normal).
 *
 * Isolated as a separate hook because interactionMode changes frequently
 * (every tool switch) and shouldn't cause exif/metadata panels to re-render.
 */
export function useClipMode() {
   const { state } = useEditorState();
   return state.interaction.interactionMode === 'clip';
}
