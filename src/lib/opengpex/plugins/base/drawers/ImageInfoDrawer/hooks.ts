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

import { useEffect, useMemo } from 'react';
import {
   useEditorState,
   useEditorServices,
   usePluginSelfConfig,
   usePluginCommands,
} from '@opengpex/editor/core/context';
import type { GamutId } from '@opengpex/editor/core/types';
import { WORKING_GAMUT } from '@opengpex/editor/core/engine/color';
import {
   supportsExifEmbed,
   mimeToFormat,
   resolveEmbedIcc,
   FORMAT_EGEST_CAPABILITIES,
   type ImageMetadata,
} from '@opengpex/editor/core/files';
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
   const { activeFrame } = useEditorState();

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

/** Per-gamut display metadata. Bit depth is a SEPARATE, orthogonal axis — a
 *  gamut choice no longer implies a bit depth (raw-8 carries wide gamut at 8-bit). */
const GAMUT_META: Record<
   GamutId,
   { label: string; fullLabel: string; desc: string }
> = {
   srgb: {
      label: 'sRGB',
      fullLabel: 'sRGB',
      desc: 'standard, web',
   },
   'display-p3': {
      label: 'Display-P3',
      fullLabel: 'Display-P3',
      desc: 'wide gamut, screen',
   },
   'adobe-rgb': {
      label: 'Adobe RGB',
      fullLabel: 'Adobe RGB',
      desc: 'photo, print',
   },
   'prophoto-rgb': {
      label: 'ProPhoto RGB',
      fullLabel: 'ProPhoto RGB',
      desc: 'archival, ultra-wide',
   },
   rec2020: {
      label: 'Rec.2020',
      fullLabel: 'Rec.2020',
      desc: 'HDR, broadcast',
   },
};

/** One entry in the Color Space dropdown (shape consumed by ActionDropdown). */
export interface GamutOption {
   label: string;
   value: GamutId;
   description: string;
   checked: boolean;
}

/**
 * useExportRules — Conditional-display & anti-footgun logic for the export panel.
 *
 * Owns everything the render layer shouldn't: derives which controls are visible
 * for the current format, resolves the effective gamut/ICC state, and runs the
 * two self-correcting side effects (anti silent-downgrade + bit-depth sync).
 * Returns only view-ready values + handlers so `ResizeExportRules` stays a pure
 * composition of presentational components.
 */
export function useExportRules(
   config: P.ExportConfig,
   updateConfig: (cfg: Partial<P.ExportConfig>) => void,
   imageMetadata: ImageMetadata | undefined,
   sourceBitDepth: number | undefined,
) {
   const { activeFrame } = useEditorState();
   const { assets } = useEditorServices();

   // Authoritative document gamut anchor (SSOT: StoredAsset)
   const sourceGamut: GamutId = useMemo(() => {
      if (activeFrame?.assetId) {
         return assets.get(activeFrame.assetId)?.gamut ?? 'srgb';
      }
      return (activeFrame?.metadata?.colorSpace as GamutId) ?? 'srgb';
   }, [activeFrame, assets]);

   const exportFmt = mimeToFormat[config.format] ?? 'unknown';
   const cap = FORMAT_EGEST_CAPABILITIES[exportFmt];
   const supportedGamuts = useMemo(() => cap?.supportedGamuts ?? ['srgb'], [cap]);

   // Bit-depth control display gate (egest refactor §6.1): show whenever the
   // format has a raw encode lane (PNG/TIFF) — inverted from v1's `sourceBitDepth
   // > 8` gate, so an 8-bit wide-gamut source can also explicitly pick 8-bit
   // (→ raw-8) or upgrade to 16-bit. No `canExport16bit`/`isModified` disable:
   // v2's RenderGraph composites edited documents at 16-bit just fine.
   const showBitDepth = !!cap && cap.supportedChannels.some(
      (ch) => ch === 'raw-8' || ch === 'raw-16',
   );
   const exportBitDepth: 8 | 16 = config.exportBitDepth === 16 ? 16 : 8;
   const handleBitDepthChange = (next: 8 | 16) => {
      updateConfig({ exportBitDepth: next });
   };

   // Anti-Silent-Downgrade: if current targetGamut is no longer supported by the newly
   // selected format, automatically revert to undefined (Follow Source).
   useEffect(() => {
      if (config.targetGamut && !supportedGamuts.includes(config.targetGamut)) {
         updateConfig({ targetGamut: undefined });
      }
   }, [config.format, config.targetGamut, supportedGamuts, updateConfig]);

   // Authoritative document bit depth anchor (SSOT: StoredAsset, fallback: metadata)
   const docBitDepth = useMemo(() => {
      if (activeFrame?.assetId) {
         const assetDepth = assets.get(activeFrame.assetId)?.bitDepth;
         if (assetDepth !== undefined) return assetDepth;
      }
      return sourceBitDepth ?? activeFrame?.metadata?.bitDepth;
   }, [activeFrame, assets, sourceBitDepth]);

   const sourceIs16Bit = docBitDepth !== undefined && docBitDepth > 8;

   // Lifecycle synchronization for exportBitDepth — default only, never a force.
   useEffect(() => {
      if (sourceIs16Bit && config.exportBitDepth === undefined) {
         updateConfig({ exportBitDepth: 16 });
      }
   }, [sourceIs16Bit, config.exportBitDepth, updateConfig]);

   // ─── Metadata & color toggles visibility ───
   const showExif = !!(imageMetadata?.raw?.exif && supportsExifEmbed(config.format));
   const showIcc = cap?.supportsIccEmbed ?? false;
   const effectiveEmbedIcc = showIcc
      ? resolveEmbedIcc(exportFmt, config.embedIccOverride)
      : false;
   // Color space selector only when the format supports multiple gamuts (BMP/GIF = sRGB-only → hidden)
   const showColorSpace = supportedGamuts.length > 1;
   const hasMetadataSection = showExif || showIcc || showColorSpace;

   // Default gamut for active format: sourceGamut if supported, otherwise container fallback
   const defaultGamut: GamutId = useMemo(() => {
      if (supportedGamuts.includes(sourceGamut)) {
         return sourceGamut;
      }
      return supportedGamuts.includes(WORKING_GAMUT) ? WORKING_GAMUT : (supportedGamuts[0] ?? 'srgb');
   }, [supportedGamuts, sourceGamut]);

   // Effective active gamut: explicit user choice if valid for format, otherwise default
   const effectiveGamut: GamutId = useMemo(() => {
      if (config.targetGamut && supportedGamuts.includes(config.targetGamut)) {
         return config.targetGamut;
      }
      return defaultGamut;
   }, [config.targetGamut, supportedGamuts, defaultGamut]);

   // Whether the effective gamut matches the document's original gamut
   const isSourceGamut = effectiveGamut === sourceGamut;

   // Whether this export format had to adapt away from sourceGamut due to container capability limits
   const isAdapted = !config.targetGamut && !supportedGamuts.includes(sourceGamut);

   // Can reset if user has changed color space or bit depth away from document defaults
   const isBitDepthChanged = showBitDepth && (sourceIs16Bit ? config.exportBitDepth === 8 : config.exportBitDepth === 16);
   const canReset = config.targetGamut !== undefined || isBitDepthChanged;

   const sourceGamutMeta = GAMUT_META[sourceGamut] ?? { fullLabel: sourceGamut.toUpperCase(), label: sourceGamut.toUpperCase() };
   const effectiveGamutMeta = GAMUT_META[effectiveGamut] ?? { fullLabel: effectiveGamut.toUpperCase(), label: effectiveGamut.toUpperCase() };

   const gamutTooltip = useMemo(() => {
      if (isSourceGamut) {
         return `Matches original document color space (${sourceGamutMeta.fullLabel}).`;
      }
      const fmtLabel = exportFmt.toUpperCase();
      const isFormatConstrained = !supportedGamuts.includes(sourceGamut);
      if (isFormatConstrained) {
         return `Original: ${sourceGamutMeta.fullLabel}\nOutput: ${effectiveGamutMeta.fullLabel}\n${fmtLabel} does not support ${sourceGamutMeta.fullLabel}.\nColors will be converted to ${effectiveGamutMeta.fullLabel}.`;
      }
      return `Original: ${sourceGamutMeta.fullLabel}\nOutput: ${effectiveGamutMeta.fullLabel}\nColors will be converted from ${sourceGamutMeta.fullLabel} to ${effectiveGamutMeta.fullLabel}.`;
   }, [isSourceGamut, exportFmt, supportedGamuts, sourceGamut, sourceGamutMeta.fullLabel, effectiveGamutMeta.fullLabel]);

   const gamutOptions: GamutOption[] = useMemo(() => {
      return supportedGamuts.map((g) => {
         const meta = GAMUT_META[g] ?? {
            label: g.toUpperCase(),
            fullLabel: g.toUpperCase(),
            desc: '',
         };
         return {
            label: meta.fullLabel,
            value: g,
            description: meta.desc,
            checked: effectiveGamut === g,
         };
      });
   }, [supportedGamuts, effectiveGamut]);

   const currentGamutLabel = useMemo(() => {
      return effectiveGamutMeta.fullLabel;
   }, [effectiveGamutMeta.fullLabel]);

   // Gamut selection is orthogonal to bit depth (egest refactor §6.1): choosing a
   // gamut NEVER changes `exportBitDepth`. Depth defaults from the source document
   // and is only changed by the explicit bit-depth control.
   const handleGamutSelect = (val: string) => {
      const nextGamut = val as GamutId;
      updateConfig({
         targetGamut: nextGamut === defaultGamut ? undefined : nextGamut,
      });
   };

   const handleGamutReset = () => {
      updateConfig({
         targetGamut: undefined,
         exportBitDepth: sourceIs16Bit ? 16 : undefined,
      });
   };

   return {
      showExif,
      showIcc,
      effectiveEmbedIcc,
      showColorSpace,
      hasMetadataSection,
      isSourceGamut,
      isAdapted,
      gamutTooltip,
      canReset,
      gamutOptions,
      currentGamutLabel,
      handleGamutSelect,
      handleGamutReset,
      showBitDepth,
      exportBitDepth,
      handleBitDepthChange,
   };
}
