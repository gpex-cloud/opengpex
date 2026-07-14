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
import type { ExifData } from '@opengpex/editor/core/types';
import type { ImageMetadata } from '@opengpex/editor/core/files';
import type { ImageInfoDrawerCommandsMap } from './commands.d';
import * as P from './protocols';

import { formatBytes } from '@opengpex/editor/core/helpers/file';

/**
 * Adapter: Converts the new unified ImageMetadata into the legacy ExifData
 * shape expected by the ExifInfoPanel component.
 */
function imageMetadataToExif(meta: ImageMetadata | undefined): ExifData | undefined {
   if (!meta) return undefined;
   if (!meta.camera && !meta.capture && !meta.dates && !meta.hasIccProfile) return undefined;

   return {
      Make: meta.camera?.make,
      Model: meta.camera?.model,
      LensMake: meta.camera?.lensMake,
      LensModel: meta.camera?.lensModel,
      Software: meta.camera?.software,
      FNumber: meta.capture?.fNumber,
      ExposureTime: meta.capture?.exposureTime,
      ISOSpeedRatings: meta.capture?.iso,
      FocalLength: meta.capture?.focalLength,
      WhiteBalance: meta.capture?.whiteBalance,
      DateTimeOriginal: meta.dates?.created,
      CreateDate: meta.dates?.created,
      ModifyDate: meta.dates?.modified,
      XResolution: meta.dpi,
      YResolution: meta.dpi,
      ResolutionUnit: 2,
      ColorSpace: meta.colorSpace === 'srgb' ? 1 : undefined,
      // ICC Profile info
      hasIccProfile: meta.hasIccProfile,
      iccProfileName: meta.raw?.iccProfileName,
      colorSpaceName: meta.colorSpace,
   };
}

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
   const { activeFrame } = useEditorState();

   return useMemo(() => {
      if (!activeFrame) {
         return {
            activeFrame: null as typeof activeFrame,
            fileName: 'Untitled',
            fileFormat: 'PNG',
            fileSize: '---',
            exif: undefined as ExifData | undefined,
            layerCount: 0,
            frameDpi: 72,
            sourceBitDepth: undefined as number | undefined,
            isSingleLayer: false,
         };
      }

      const mainLayer = activeFrame.layers.byId[activeFrame.layers.order[0]];
      const metadata = mainLayer?.metadata;
      const imageMetadata = metadata?.imageMetadata as ImageMetadata | undefined;

      const visibleContentLayers = activeFrame.layers.order.filter(id => {
         const l = activeFrame.layers.byId[id];
         return !l.hostId && l.visible !== false;
      });

      return {
         activeFrame,
         fileName: imageMetadata?.sourceFileName || activeFrame.name || 'Untitled',
         fileFormat: ((imageMetadata?.internalCodec
            || metadata?.format || 'image/png').split('/')[1])?.toUpperCase() || 'PNG',
         fileSize: metadata?.size ? formatBytes(metadata.size) : '---',
         exif: metadata?.exif || imageMetadataToExif(imageMetadata),
         layerCount: activeFrame.layers.order.length,
         frameDpi: activeFrame.dpi || 72,
         sourceBitDepth: (imageMetadata as { bitDepth?: number } | undefined)?.bitDepth,
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
