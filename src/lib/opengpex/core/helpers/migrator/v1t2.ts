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

import { ASSET_VERSION, type StoredAsset } from '@opengpex/editor/core/storage/asset/AssetStore';
import { AssetDriver, LegacyAssetDriver, LegacyStateDriver, ShardedStateDriver, StateDriver } from '@opengpex/editor/core/storage/Driver';
import { GlobalHistoryState, UIConfig } from '@opengpex/editor/core/types';
import { fromHex, type ColorValue } from '@opengpex/editor/core/engine/color';
import { Hydrating } from '@opengpex/editor/core/storage/state/Hydrating';

/** Structure of persistent project metadata */
interface ProjectMeta {
  frameIds: string[];
  activeFrameId: string | null;
  pluginConfig: Record<string, Record<string, unknown>>;
  ui: UIConfig;
}

/** Structure of pre-v5 asset record for migration typing */
interface LegacyAssetRecord {
  id?: string;
  blob?: Blob;
  width?: number;
  height?: number;
  gamut?: string;
  trc?: string;
  bitDepth?: number;
  version?: number;
  timestamp?: number;
  dprScale?: number;
  tileMeta?: {
    originalDimensions?: {
      w?: number;
      h?: number;
    };
    dprScale?: number;
    dpr?: number;
  };
}

/**
 * Checks if a value conforms to the minimum shape of a ColorValue object.
 */
export function isColorValueLike(val: unknown): boolean {
  if (typeof val !== 'object' || val === null) return false;
  const obj = val as Record<string, unknown>;
  if (!obj.coords || typeof obj.coords !== 'object' || obj.coords === null) return false;
  const coords = obj.coords as Record<string, unknown>;
  return typeof coords.r === 'number' && typeof coords.g === 'number' && typeof coords.b === 'number';
}

/**
 * Converts a legacy color representation (hex string "#ffffff", rgba, etc.)
 * into a valid v2 ColorValue object during storage migration / healing.
 */
export function migrateToColorValue(val: unknown, fallbackHex = '#FFFFFF'): ColorValue {
  if (
    val &&
    typeof val === 'object' &&
    'coords' in val &&
    (val as ColorValue).coords &&
    typeof (val as ColorValue).coords.r === 'number'
  ) {
    return val as ColorValue;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.startsWith('#')) {
      try {
        return fromHex(trimmed);
      } catch {
        // Fallback below
      }
    }
    const rgbMatch = trimmed.match(
      /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i,
    );
    if (rgbMatch) {
      const r = Number(rgbMatch[1]);
      const g = Number(rgbMatch[2]);
      const b = Number(rgbMatch[3]);
      const a = rgbMatch[4] !== undefined ? Number(rgbMatch[4]) : 1;
      const hex = `#${Math.round(r).toString(16).padStart(2, '0')}${Math.round(g).toString(16).padStart(2, '0')}${Math.round(b).toString(16).padStart(2, '0')}`;
      try {
        return fromHex(hex, a);
      } catch {
        // Fallback below
      }
    }
  }
  try {
    return fromHex(fallbackHex);
  } catch {
    return {
      space: 'srgb',
      coords: { r: 1, g: 1, b: 1 },
      alpha: 1,
      hex: '#ffffff',
    };
  }
}

/**
 * Sanitizes legacy string-based colors in a layer into valid ColorValue objects.
 * Returns true if any field was converted/modified.
 */
export function sanitizeLayer(layer: Record<string, unknown>): boolean {
  let changed = false;

  // 1. TextLayerData: color, boxMode, verticalAlign
  // Align with 12_text_tool_spec: ensure structured color, valid boxMode and verticalAlign
  if (layer.textData && typeof layer.textData === 'object') {
    const td = layer.textData as Record<string, unknown>;
    if (td.color !== undefined && !isColorValueLike(td.color)) {
      td.color = migrateToColorValue(td.color);
      changed = true;
    }
    if (td.boxMode === undefined || td.boxMode === 'auto') {
      td.boxMode = 'auto_width';
      changed = true;
    }
    if (td.verticalAlign === undefined) {
      td.verticalAlign = 'top';
      changed = true;
    }
  }

  // 2. StrokeData.color (Brush2 / Logic Brush)
  // Align with 11_hard_edge_spec: StrokeData requires structured ColorValue for vector pipeline
  if (layer.strokeData && typeof layer.strokeData === 'object') {
    const sd = layer.strokeData as Record<string, unknown>;
    if (sd.color !== undefined && !isColorValueLike(sd.color)) {
      sd.color = migrateToColorValue(sd.color);
      changed = true;
    }
  }

  // 3. MarkerData: stroke.color, fill.color
  if (layer.markerData && typeof layer.markerData === 'object') {
    const md = layer.markerData as Record<string, unknown>;
    if (md.stroke && typeof md.stroke === 'object') {
      const stroke = md.stroke as Record<string, unknown>;
      if (stroke.color !== undefined && !isColorValueLike(stroke.color)) {
        stroke.color = migrateToColorValue(stroke.color);
        changed = true;
      }
    }
    if (md.fill && typeof md.fill === 'object') {
      const fill = md.fill as Record<string, unknown>;
      if (fill.color !== undefined && !isColorValueLike(fill.color)) {
        fill.color = migrateToColorValue(fill.color);
        changed = true;
      }
    }
  }

  // 4. metadata.fillColor
  if (layer.metadata && typeof layer.metadata === 'object') {
    const meta = layer.metadata as Record<string, unknown>;
    if (meta.fillColor !== undefined && !isColorValueLike(meta.fillColor)) {
      meta.fillColor = migrateToColorValue(meta.fillColor);
      changed = true;
    }
  }

  // 5. Bounding defensive healing: ensure layer.bounding conforms to layer.rect
  // Align with 12_text_tool_spec: WebGPU textToVectorSource relies on bounding.w/h
  if (!layer.bounding && layer.rect && typeof layer.rect === 'object') {
    layer.bounding = { ...(layer.rect as Record<string, unknown>) };
    changed = true;
  }

  return changed;
}

/**
 * Sanitizes a legacy v1 frame state by converting string colors to ColorValue
 * and stripping obsolete top-level fields (bitDepth, colorSpace, trc).
 */
export function sanitizeFrame(frameData: Record<string, unknown>): Record<string, unknown> {
  const cleanFrame = { ...frameData };
  delete cleanFrame.bitDepth;
  delete cleanFrame.colorSpace;
  delete cleanFrame.trc;

  const layers = cleanFrame.layers as { byId?: Record<string, Record<string, unknown>>; order?: string[] } | undefined;
  if (layers?.byId) {
    for (const layerId of Object.keys(layers.byId)) {
      const layer = layers.byId[layerId];
      if (layer && typeof layer === 'object') {
        sanitizeLayer(layer);
      }
    }
  }
  return cleanFrame;
}

/**
 * Upgrades a legacy asset record from Assets_V2 to ASSET_VERSION 5 in Assets_V3
 * with valid ColorIdentity, dimension healing, DPR preservation, and raw sourceBlob handling.
 * Completely non-destructive: Assets_V2 is strictly read-only.
 *
 * Handles both:
 * 1. Standard display assets: stored at `${assetId}` in Assets_V2.
 * 2. Raw source blobs: stored at `raw:${assetId}` in Assets_V2 (e.g. frame.assetId).
 *    Copies `raw:${assetId}` to Assets_V3, and also materializes a display StoredAsset
 *    under `${assetId}` so WebGPU / SceneAssembler has an actual renderable texture.
 */
export async function upgradeAssetIfLegacy(
  assetId: string,
  hintDprScale?: number,
  fallbackDim?: { w: number; h: number },
  companionAssetId?: string,
): Promise<void> {
  // Built-in transparent pixel is generated dynamically in memory; skip IDB check
  if (assetId === 'asset-transparent-pixel') {
    return;
  }

  try {
    // 1. Check if raw source blob exists in LegacyAssetDriver (Assets_V2)
    const legacyRawBlob = await LegacyAssetDriver.getItem<Blob>(`raw:${assetId}`);
    if (legacyRawBlob instanceof Blob) {
      const existingV3Raw = await AssetDriver.getItem<Blob>(`raw:${assetId}`);
      if (!existingV3Raw) {
        await AssetDriver.setItem(`raw:${assetId}`, legacyRawBlob);
        console.info(`[Migrator]       ✓ Migrated raw source blob [raw:${assetId.slice(0, 10)}] to Assets_V3 (${legacyRawBlob.size} bytes)`);
      }
    }

    // 2. Check if display asset already exists in v2 store (Assets_V3)
    const existingV3 = await AssetDriver.getItem<StoredAsset>(assetId);
    if (existingV3 && existingV3.blob) {
      if (!existingV3.dprScale && hintDprScale && hintDprScale > 1) {
        existingV3.dprScale = hintDprScale;
        await AssetDriver.setItem(assetId, existingV3);
        console.info(`[Migrator]       ✓ Added dprScale (${hintDprScale}x) to existing v3 asset [${assetId.slice(0, 10)}]`);
      } else {
        console.debug(`[Migrator]       ✓ Asset [${assetId.slice(0, 10)}] already in Assets_V3.`);
      }
      return;
    }

    // 3. Fetch record from LegacyAssetDriver
    // It could be under `${assetId}` (legacy record or blob)
    const raw = await LegacyAssetDriver.getItem<LegacyAssetRecord | Blob>(assetId);
    let blob: Blob | undefined;
    let width = 0;
    let height = 0;
    let dprScale: number | undefined = hintDprScale && hintDprScale > 0 ? hintDprScale : undefined;
    let timestamp = Date.now();

    if (raw) {
      if (raw instanceof Blob) {
        blob = raw;
      } else if (typeof raw === 'object' && raw.blob instanceof Blob) {
        blob = raw.blob;
        width = raw.tileMeta?.originalDimensions?.w || raw.width || 0;
        height = raw.tileMeta?.originalDimensions?.h || raw.height || 0;
        dprScale = raw.dprScale || raw.tileMeta?.dprScale || raw.tileMeta?.dpr || dprScale;
        if (raw.timestamp) timestamp = raw.timestamp;
      }
    }

    // 4. If no display record at `${assetId}`, but `raw:${assetId}` exists:
    // This happens when frame.assetId points to sourceBlob!
    if (!blob && legacyRawBlob instanceof Blob) {
      blob = legacyRawBlob;
      console.info(`[Migrator]       📦 Using legacy raw source blob for display asset [${assetId.slice(0, 10)}]`);
    }

    if (!blob || blob.size === 0) {
      console.debug(`[Migrator]       ⚠️ Asset [${assetId.slice(0, 10)}] has no record/blob or empty blob in legacy Assets_V2, skipping.`);
      return;
    }

    // 5. Resolve dimensions with multi-level fallback, self-healing, and companion borrowing
    if (width <= 0 || height <= 0) {
      // 5a. Try sniffing dimensions via createImageBitmap
      try {
        if (typeof createImageBitmap === 'function') {
          const bmp = await createImageBitmap(blob);
          width = bmp.width;
          height = bmp.height;
          bmp.close();
          console.info(`[Migrator]       🔍 Probed physical dimensions from blob for [${assetId.slice(0, 10)}]: ${width}x${height}`);
        }
      } catch (e) {
        // If probing fails (e.g. un-decodable camera RAW/TIFF), try borrowing from companion asset
        if (companionAssetId) {
          const compV3 = await AssetDriver.getItem<StoredAsset>(companionAssetId);
          if (compV3?.blob && compV3.width > 0 && compV3.height > 0) {
            blob = compV3.blob;
            width = compV3.width;
            height = compV3.height;
            console.info(`[Migrator]       🔗 Borrowed display blob & dimensions (${width}x${height}) from companion asset [${companionAssetId.slice(0, 10)}] for [${assetId.slice(0, 10)}]`);
          }
        }
        // If still unresolved, only use fallbackDim if it's a raw source file (unsupported by browser createImageBitmap)
        if ((width <= 0 || height <= 0) && legacyRawBlob && fallbackDim && fallbackDim.w > 0 && fallbackDim.h > 0) {
          width = fallbackDim.w;
          height = fallbackDim.h;
          console.info(`[Migrator]       📐 Using fallback dimensions for [${assetId.slice(0, 10)}]: ${width}x${height}`);
        } else if (width <= 0 || height <= 0) {
          console.warn(`[Migrator]       ⚠️ Failed to probe dimensions from blob for asset [${assetId.slice(0, 10)}]:`, e);
        }
      }
    }

    // Hard defensive guard against zero-dimension textures in WebGPU
    if (width <= 0 || height <= 0) {
      console.error(`[Migrator]       ❌ Asset [${assetId.slice(0, 10)}] has invalid/zero dimensions (${width}x${height}), skipping to protect WebGPU.`);
      return;
    }

    // Construct compliant v5 StoredAsset for Assets_V3
    const upgraded: StoredAsset = {
      id: assetId,
      blob,
      width,
      height,
      ...(dprScale && dprScale > 0 ? { dprScale } : {}),
      gamut: 'srgb',
      trc: 'srgb-trc',
      bitDepth: 8,
      version: ASSET_VERSION,
      timestamp,
    };

    // Save strictly to Assets_V3 without touching Assets_V2
    await AssetDriver.setItem(assetId, upgraded);
    console.info(`[Migrator]       ✓ Migrated legacy asset [${assetId.slice(0, 10)}] from Assets_V2 -> Assets_V3 (${width}x${height}${dprScale ? `, ${dprScale}x DPR` : ''}, 8-bit sRGB)`);
  } catch (err) {
    console.warn(`[Migrator]       ❌ Failed to upgrade legacy asset [${assetId.slice(0, 10)}]:`, err);
  }
}

/** Boot lifecycle stages reported by the migration pipeline (optional callback). */
export type MigrationStage = 'checking' | 'migrating' | 'healing' | 'done';

/**
 * Automatic fault-tolerant migration from v1 (State_V1) to v2 (State_V2).
 * Ensures zero-touch upgrade for legacy users on cold boot.
 */
export async function checkAndMigrateV1(
  onStage?: (stage: MigrationStage) => void,
): Promise<void> {
  try {
    // 1. O(1) Preflight: terminal flag check in State_V1
    const isMigrated = await LegacyStateDriver.getItem<boolean>('v2_migrated');
    if (isMigrated) {
      console.debug('[Migrator] v1 migration preflight: already migrated. Skipping.');
      return;
    }

    // 2. Check if legacy project_meta exists in State_V1
    const legacyMeta = await LegacyStateDriver.getItem<ProjectMeta>('project_meta');
    if (!legacyMeta || !Array.isArray(legacyMeta.frameIds) || legacyMeta.frameIds.length === 0) {
      // No v1 data on this browser origin; mark migrated to avoid future probes
      console.debug('[Migrator] v1 migration preflight: no legacy State_V1 artboards found.');
      await LegacyStateDriver.setItem('v2_migrated', true);
      return;
    }

    onStage?.('migrating');
    console.info(`[Migrator] 🚀 Detected ${legacyMeta.frameIds.length} legacy v1 artboard(s). Starting automatic migration to State_V2...`);

    const updates: Record<string, unknown> = {};
    const activeAssetIds = new Set<string>();

    // 3. Read and sanitize all frames from State_V1
    const assetLogicalWidths = new Map<string, number>();
    const assetFallbackDims = new Map<string, { w: number; h: number }>();
    const frameCompanionAssets = new Map<string, string>(); // frame.assetId -> baseLayer.assetId

    for (const id of legacyMeta.frameIds) {
      const frameData = await LegacyStateDriver.getItem<Record<string, unknown>>(`frame:${id}`);
      if (!frameData) {
        console.warn(`[Migrator]   ⚠️ Legacy frame:${id} referenced in project_meta was not found in State_V1.`);
        continue;
      }

      // Collect all referenced asset IDs
      Hydrating.extractAllIds(frameData, activeAssetIds);

      const canvas = frameData.canvas as { w?: number; h?: number } | undefined;
      const frameAssetId = frameData.assetId as string | undefined;
      if (frameAssetId) {
        activeAssetIds.add(frameAssetId);
        if (canvas && typeof canvas.w === 'number' && typeof canvas.h === 'number' && canvas.w > 0 && canvas.h > 0) {
          assetFallbackDims.set(frameAssetId, { w: canvas.w, h: canvas.h });
        }
      }

      // Sanitize frame: strip obsolete top-level fields (bitDepth, colorSpace, trc)
      // without polluting frame.metadata
      const cleanFrame = { ...frameData };
      delete cleanFrame.bitDepth;
      delete cleanFrame.colorSpace;
      delete cleanFrame.trc;

      // Sanitize layers in cleanFrame (convert text/marker string colors to ColorValue)
      const layers = cleanFrame.layers as { byId?: Record<string, Record<string, unknown>>; order?: string[] } | undefined;
      if (layers?.byId) {
        const baseLayerId = (cleanFrame.activeLayerId as string) || (layers.order && layers.order[0]);
        const baseLayer = baseLayerId ? layers.byId[baseLayerId] : undefined;
        const baseAssetId = (baseLayer?.assetId || (baseLayer as Record<string, unknown> | undefined)?.sourceAssetId) as string | undefined;
        if (frameAssetId && baseAssetId && frameAssetId !== baseAssetId) {
          frameCompanionAssets.set(frameAssetId, baseAssetId);
        }

        for (const layerId of Object.keys(layers.byId)) {
          const layer = layers.byId[layerId];
          sanitizeLayer(layer);

          const assetId = (layer.assetId || (layer as Record<string, unknown>).sourceAssetId) as string | undefined;
          const rect = layer.rect as { w?: number; h?: number } | undefined;
          const bounding = layer.bounding as { w?: number; h?: number } | undefined;
          const dim = bounding || rect || canvas;

          if (assetId && dim && typeof dim.w === 'number' && typeof dim.h === 'number' && dim.w > 0 && dim.h > 0) {
            if (!assetFallbackDims.has(assetId)) {
              assetFallbackDims.set(assetId, { w: dim.w, h: dim.h });
            }
          }

          // Record logical width hint for text assets to compute DPR if needed
          if (layer.type === 'text') {
            if (assetId && rect && typeof rect.w === 'number' && rect.w > 0) {
              assetLogicalWidths.set(assetId, rect.w);
            }
          }
        }
      }

      const frameName = typeof cleanFrame.name === 'string' ? cleanFrame.name : 'Untitled';
      console.info(`[Migrator]   📦 Prepared frame [${id}] ("${frameName}")`);
      updates[`frame:${id}`] = cleanFrame;
    }

    // Also read history_index if present
    const historyIndex = await LegacyStateDriver.getItem<GlobalHistoryState>('history_index');
    if (historyIndex) {
      Hydrating.extractAllIds(historyIndex, activeAssetIds);
      updates['history_index'] = historyIndex;
    }

    updates['project_meta'] = legacyMeta;

    // 4. Upgrade referenced legacy assets in Assets_V2 with self-healing, raw sourceBlobs, and guards
    console.info(`[Migrator]   🎨 Inspecting and upgrading ${activeAssetIds.size} referenced asset(s)...`);
    for (const assetId of activeAssetIds) {
      let hintDpr: number | undefined;
      const logicalW = assetLogicalWidths.get(assetId);
      if (logicalW && logicalW > 0) {
        const legacyAsset = await LegacyAssetDriver.getItem<LegacyAssetRecord>(assetId);
        const v3Asset = !legacyAsset ? await AssetDriver.getItem<StoredAsset>(assetId) : null;
        const physW = legacyAsset?.tileMeta?.originalDimensions?.w || legacyAsset?.width || v3Asset?.width || 0;
        if (physW > 0) {
          const calc = Math.round((physW / logicalW) * 100) / 100;
          if (calc > 1) {
            hintDpr = calc;
          }
        }
      }
      const fallbackDim = assetFallbackDims.get(assetId);
      const companionAssetId = frameCompanionAssets.get(assetId);
      await upgradeAssetIfLegacy(assetId, hintDpr, fallbackDim, companionAssetId);
    }

    // 5. Transactional batch write into State_V2
    console.info(`[Migrator]   💾 Writing ${Object.keys(updates).length} record(s) to State_V2...`);
    await ShardedStateDriver.setItems(updates);

    // 6. Only after ALL writes succeed, commit terminal flag in State_V1
    await LegacyStateDriver.setItem('v2_migrated', true);

    console.info('[Migrator] ✅ Successfully migrated legacy v1 artboards to v2! Terminal flag set in State_V1.');
  } catch (err) {
    console.error('[Migrator] ❌ Automatic migration from v1 failed (will retry on next refresh):', err);
  }
}

export const V2_HEAL_FLAG_KEY = 'v2_healed_specs_aligned';

/**
 * One-time healing pass for records already migrated to State_V2.
 * Ensures layer colors are structured ColorValue, text assets preserve dprScale,
 * strokeData colors and textData boxMode/verticalAlign/bounding conform to v2 specs,
 * and missing frame raw source blobs are backfilled from LegacyAssetDriver.
 */
export async function healExistingV2Records(): Promise<void> {
  try {
    const isHealed = await StateDriver.getItem<boolean>(V2_HEAL_FLAG_KEY);
    if (isHealed) {
      return;
    }

    const meta = await StateDriver.getItem<ProjectMeta>('project_meta');
    if (!meta || !Array.isArray(meta.frameIds)) {
      return;
    }

    console.info('[Migrator] 🩺 Running post-migration healing pass on State_V2 records...');
    const updates: Record<string, unknown> = {};

    for (const id of meta.frameIds) {
      const frameData = await StateDriver.getItem<Record<string, unknown>>(`frame:${id}`);
      if (!frameData) continue;

      let frameModified = false;
      const canvas = frameData.canvas as { w?: number; h?: number } | undefined;
      const frameAssetId = frameData.assetId as string | undefined;

      // Heal missing frame asset if present in LegacyAssetDriver
      if (frameAssetId) {
        const existingInV3 = await AssetDriver.getItem<StoredAsset>(frameAssetId);
        const existingRawInV3 = await AssetDriver.getItem<Blob>(`raw:${frameAssetId}`);
        if (!existingInV3 || !existingRawInV3) {
          const fallbackDim = canvas && canvas.w && canvas.h ? { w: canvas.w, h: canvas.h } : undefined;
          await upgradeAssetIfLegacy(frameAssetId, undefined, fallbackDim);
        }
      }

      const layers = frameData.layers as { byId?: Record<string, Record<string, unknown>>; order?: string[] } | undefined;
      if (layers?.byId) {
        for (const layerId of Object.keys(layers.byId)) {
          const layer = layers.byId[layerId];
          if (sanitizeLayer(layer)) {
            frameModified = true;
          }

          // Heal text asset dprScale if missing
          if (layer.type === 'text') {
            const assetId = (layer.assetId || (layer as Record<string, unknown>).sourceAssetId) as string | undefined;
            if (assetId) {
              const asset = await AssetDriver.getItem<StoredAsset>(assetId);
              const rect = layer.rect as { w?: number; h?: number } | undefined;
              if (asset && (!asset.dprScale || asset.dprScale === 1) && rect && typeof rect.w === 'number' && rect.w > 0) {
                const calculatedDpr = Math.round((asset.width / rect.w) * 100) / 100;
                if (calculatedDpr > 1) {
                  console.info(`[Migrator]   ✓ Healed dprScale for text asset [${assetId.slice(0, 10)}] (${calculatedDpr}x)`);
                  asset.dprScale = calculatedDpr;
                  await AssetDriver.setItem(assetId, asset);
                }
              }
            }
          }
        }
      }

      if (frameModified) {
        console.info(`[Migrator]   ✓ Healed layer colors and attributes for frame [${id}]`);
        updates[`frame:${id}`] = frameData;
      }
    }

    if (Object.keys(updates).length > 0) {
      await ShardedStateDriver.setItems(updates);
    }

    await StateDriver.setItem(V2_HEAL_FLAG_KEY, true);
    await StateDriver.setItem('v2_healed_layer_colors_dpr', true);
    console.info('[Migrator] ✅ Post-migration healing pass completed successfully.');
  } catch (err) {
    console.warn('[Migrator] ⚠️ Post-migration healing pass encountered an error (will retry next time):', err);
  }
}

/**
 * Combined entry point: runs automatic v1 migration and post-migration healing pass.
 * Reports lifecycle progress via the optional `onStage` callback (used by the
 * boot overlay to show the migration subtitle). Note: both sub-steps swallow
 * their own errors internally, so failures never reject this promise.
 */
export async function runV1MigrationAndHealing(
  onStage?: (stage: MigrationStage) => void,
): Promise<void> {
  onStage?.('checking');
  await checkAndMigrateV1(onStage);
  onStage?.('healing');
  await healExistingV2Records();
  onStage?.('done');
}
