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
 * A legacy display record resolved from Assets_V2, normalized to v5 fields.
 */
interface ResolvedLegacyAsset {
  blob: Blob;
  width: number;
  height: number;
  dprScale: number | undefined;
  timestamp: number;
}

/**
 * Copies `raw:${assetId}` from Assets_V2 to Assets_V3 when missing (the raw
 * store is content-addressed and keyed identically on both sides — verbatim
 * copy). Returns the legacy raw blob (also when the v3 copy already exists)
 * so the caller can inspect the source file.
 */
async function copyRawSource(assetId: string): Promise<Blob | null> {
  const legacyRawBlob = await LegacyAssetDriver.getItem<Blob>(`raw:${assetId}`);
  if (!(legacyRawBlob instanceof Blob)) return null;
  const existingV3Raw = await AssetDriver.getItem<Blob>(`raw:${assetId}`);
  if (!existingV3Raw) {
    await AssetDriver.setItem(`raw:${assetId}`, legacyRawBlob);
    console.debug(`[Migrator] Copied raw source blob [raw:${assetId.slice(0, 10)}] to Assets_V3 (${legacyRawBlob.size} bytes)`);
  }
  return legacyRawBlob;
}

/**
 * Reads the legacy display record at `${assetId}` (Assets_V2) and normalizes
 * it to v5 fields. Accepts both a bare Blob (old plain-blob records) and a
 * StoredAsset-shaped record (with tileMeta dimension/dpr fallbacks). Returns
 * null when no record exists.
 */
async function loadLegacyRecord(
  assetId: string,
  hintDprScale?: number,
): Promise<ResolvedLegacyAsset | null> {
  const raw = await LegacyAssetDriver.getItem<LegacyAssetRecord | Blob>(assetId);
  if (raw instanceof Blob) {
    return { blob: raw, width: 0, height: 0, dprScale: hintDprScale, timestamp: Date.now() };
  }
  if (raw && typeof raw === 'object' && raw.blob instanceof Blob) {
    return {
      blob: raw.blob,
      width: raw.tileMeta?.originalDimensions?.w || raw.width || 0,
      height: raw.tileMeta?.originalDimensions?.h || raw.height || 0,
      dprScale: raw.dprScale || raw.tileMeta?.dprScale || raw.tileMeta?.dpr || hintDprScale,
      timestamp: raw.timestamp || Date.now(),
    };
  }
  return null;
}

/** Decodes a blob via `createImageBitmap` to obtain its physical dimensions. */
async function probeDimensions(blob: Blob): Promise<{ w: number; h: number } | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bmp = await createImageBitmap(blob);
    const dims = { w: bmp.width, h: bmp.height };
    bmp.close();
    return dims.w > 0 && dims.h > 0 ? dims : null;
  } catch {
    return null;
  }
}

/**
 * MIME types every major browser engine decodes identically via
 * `createImageBitmap`. Raw-source containers (HEIC/HEIF, TIFF, camera RAW)
 * are deliberately absent: some engines (Safari 17+ natively decodes HEIC)
 * would pass a decode probe that Chrome/Firefox fail, and a StoredAsset built
 * on such a blob breaks on every other browser (plus violates the ingest
 * decision spec — display assets must be universal formats).
 */
const UNIVERSALLY_DECODABLE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
]);

/**
 * Conservative decodability check for raw source blobs. An empty MIME type
 * (possible in very old records) defers to the runtime decode probe; a known
 * non-universal container is rejected WITHOUT probing, so engine-specific
 * decode support (Safari HEIC) cannot sneak a raw blob into the display store.
 */
function isUniversallyDecodableMime(blob: Blob): boolean {
  return !blob.type || UNIVERSALLY_DECODABLE_MIME_TYPES.has(blob.type);
}

/**
 * Resolves the final width/height (+ possibly a substituted display blob) for
 * a legacy asset whose record carried no usable dimensions.
 * Ladder: browser decode probe → companion asset borrow → fallback dims
 * (layer rect / canvas extent; only trusted for raw source files the browser
 * cannot decode by definition).
 */
async function resolveDimensions(
  assetId: string,
  blob: Blob,
  legacyRawBlob: Blob | null,
  companionAssetId?: string,
  fallbackDim?: { w: number; h: number },
): Promise<{ w: number; h: number; blob: Blob } | null> {
  const probed = await probeDimensions(blob);
  if (probed) {
    console.debug(`[Migrator] Probed physical dimensions from blob for [${assetId.slice(0, 10)}]: ${probed.w}x${probed.h}`);
    return { w: probed.w, h: probed.h, blob };
  }

  // Probe failed (e.g. undecodable record blob) — try borrowing the display
  // blob + dimensions wholesale from the frame's companion display asset.
  // Read the companion from Assets_V3 first, falling back to its (not-yet-
  // upgraded) Assets_V2 record: the Set-iteration order of the upgrade loop
  // gives no guarantee the companion was migrated before this id, and the
  // borrow must not depend on it. We only READ here — the companion's own
  // pass persists it to Assets_V3.
  if (companionAssetId) {
    const comp = (await AssetDriver.getItem<StoredAsset>(companionAssetId))
      ?? (await LegacyAssetDriver.getItem<StoredAsset>(companionAssetId));
    if (comp?.blob && comp.width && comp.width > 0 && comp.height && comp.height > 0) {
      console.debug(`[Migrator] Borrowed display blob & dimensions (${comp.width}x${comp.height}) from companion asset [${companionAssetId.slice(0, 10)}] for [${assetId.slice(0, 10)}]`);
      return { w: comp.width, h: comp.height, blob: comp.blob };
    }
  }

  if (legacyRawBlob && fallbackDim && fallbackDim.w > 0 && fallbackDim.h > 0) {
    console.debug(`[Migrator] Using fallback dimensions for [${assetId.slice(0, 10)}]: ${fallbackDim.w}x${fallbackDim.h}`);
    return { w: fallbackDim.w, h: fallbackDim.h, blob };
  }

  console.warn(`[Migrator] Failed to probe dimensions from blob for asset [${assetId.slice(0, 10)}].`);
  return null;
}

/** Validates dimensions and persists the v5 StoredAsset into Assets_V3. */
async function writeUpgradedAsset(
  assetId: string,
  asset: ResolvedLegacyAsset,
): Promise<void> {
  // Hard defensive guard against zero-dimension textures in WebGPU
  if (asset.width <= 0 || asset.height <= 0) {
    console.error(`[Migrator] Asset [${assetId.slice(0, 10)}] has invalid/zero dimensions (${asset.width}x${asset.height}), skipping to protect WebGPU.`);
    return;
  }

  const upgraded: StoredAsset = {
    id: assetId,
    blob: asset.blob,
    width: asset.width,
    height: asset.height,
    ...(asset.dprScale && asset.dprScale > 0 ? { dprScale: asset.dprScale } : {}),
    gamut: 'srgb',
    trc: 'srgb-trc',
    bitDepth: 8,
    version: ASSET_VERSION,
    timestamp: asset.timestamp,
  };

  // Save strictly to Assets_V3 without touching Assets_V2
  await AssetDriver.setItem(assetId, upgraded);
  console.info(`[Migrator] Migrated legacy asset [${assetId.slice(0, 10)}] from Assets_V2 -> Assets_V3 (${asset.width}x${asset.height}${asset.dprScale ? `, ${asset.dprScale}x DPR` : ''}, 8-bit sRGB)`);
}

/**
 * Upgrades a legacy asset record from Assets_V2 to ASSET_VERSION 5 in Assets_V3
 * with valid ColorIdentity, dimension healing, DPR preservation, and raw sourceBlob handling.
 * Completely non-destructive: Assets_V2 is strictly read-only.
 *
 * Handles both:
 * 1. Standard display assets: stored at `${assetId}` in Assets_V2.
 * 2. Raw source blobs: stored at `raw:${assetId}` in Assets_V2 (e.g. frame.assetId
 *    pointing at the source-file hash for revert / fast-export). The raw copy is
 *    ALWAYS migrated. A display StoredAsset under `${assetId}` is materialized
 *    ONLY when the id has no companion display asset AND the raw blob's MIME
 *    type is universally browser-decodable (and the decode probe agrees). An
 *    undecodable OR engine-only-decodable source (HEIC — Safari 17+ decodes it
 *    natively, Chrome does not — camera RAW, TIFF) must NEVER be wrapped into a
 *    StoredAsset: it can never be decoded portably at render time. The
 *    renderable display proxy lives under its own asset id and migrates as a
 *    normal light record; the raw-only source pointer needs just the `raw:`
 *    copy (consumed via `assets.getRaw`, which passes bare hashes through
 *    untouched).
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
    // 1. Raw source blob: always copy to Assets_V3, keep it for step 4.
    const legacyRawBlob = await copyRawSource(assetId);

    // 2. Display asset already in Assets_V3? Only backfill a missing dprScale.
    const existingV3 = await AssetDriver.getItem<StoredAsset>(assetId);
    if (existingV3 && existingV3.blob) {
      if (!existingV3.dprScale && hintDprScale && hintDprScale > 1) {
        existingV3.dprScale = hintDprScale;
        await AssetDriver.setItem(assetId, existingV3);
        console.debug(`[Migrator] Added dprScale (${hintDprScale}x) to existing v3 asset [${assetId.slice(0, 10)}]`);
      }
      return;
    }

    // 3. Legacy display record from Assets_V2 (if any).
    const record = await loadLegacyRecord(assetId, hintDprScale);

    // 4. No display record but a raw source exists → the id is a v1 SOURCE
    // POINTER (frame.assetId → source-file hash). Materialize a display asset
    // ONLY when the raw blob is universally browser-decodable. Two gates, in
    // order:
    //   a. COMPANION GATE — when this id has a companion display asset (the
    //      frame's base layer), it is by definition a pure source pointer: the
    //      renderable proxy migrates under its own id and this id needs only
    //      the `raw:` copy.
    //   b. MIME GATE — a raw-source container (HEIC/HEIF/TIFF/camera RAW) is
    //      rejected without even probing. A decode probe alone is NOT a safe
    //      gate: Safari 17+ natively decodes HEIC, so on WebKit the probe
    //      would succeed and re-introduce the exact StoredAsset that Chrome
    //      then fails to decode on every boot.
    if (!record && legacyRawBlob) {
      const rawOnly = (reason: string) => {
        console.debug(`[Migrator] Raw-only source pointer [${assetId.slice(0, 10)}]: raw copied, no display record (${reason}).`);
        return;
      };
      if (companionAssetId) {
        return rawOnly('companion display asset migrates under its own id');
      }
      if (!isUniversallyDecodableMime(legacyRawBlob)) {
        return rawOnly(`undecodable / non-universal source (${legacyRawBlob.type || 'untyped blob'})`);
      }
      const probed = await probeDimensions(legacyRawBlob);
      if (!probed) {
        return rawOnly('decode probe failed');
      }
      console.debug(`[Migrator] Using decodable legacy raw blob for display asset [${assetId.slice(0, 10)}] (${probed.w}x${probed.h})`);
      await writeUpgradedAsset(assetId, {
        blob: legacyRawBlob,
        width: probed.w,
        height: probed.h,
        dprScale: hintDprScale,
        timestamp: Date.now(),
      });
      return;
    }

    if (!record || record.blob.size === 0) {
      console.debug(`[Migrator] Asset [${assetId.slice(0, 10)}] has no record/blob or empty blob in legacy Assets_V2, skipping.`);
      return;
    }

    // 5. Heal missing dimensions: probe → companion borrow → fallback dims.
    let { blob, width, height } = record;
    if (width <= 0 || height <= 0) {
      const resolved = await resolveDimensions(assetId, blob, legacyRawBlob, companionAssetId, fallbackDim);
      if (!resolved) return;
      blob = resolved.blob;
      width = resolved.w;
      height = resolved.h;
    }

    // 6. Write the compliant v5 StoredAsset to Assets_V3.
    await writeUpgradedAsset(assetId, { ...record, blob, width, height });
  } catch (err) {
    console.warn(`[Migrator] Failed to upgrade legacy asset [${assetId.slice(0, 10)}]:`, err);
  }
}
/** Boot lifecycle stages reported by the migration pipeline (optional callback). */
export type MigrationStage = 'checking' | 'migrating' | 'healing' | 'done';

/** Everything step 3 of the migration collects from the legacy frames. */
interface CollectedLegacyFrames {
  /** Sanitized frames (+ history_index + project_meta) to batch-write into State_V2. */
  updates: Record<string, unknown>;
  /** Every asset id referenced anywhere in the collected state. */
  activeAssetIds: Set<string>;
  /** Text asset id → layer logical rect width (to derive a dprScale hint). */
  assetLogicalWidths: Map<string, number>;
  /** Asset id → best-known logical dimensions (layer bounding/rect/canvas). */
  assetFallbackDims: Map<string, { w: number; h: number }>;
  /** frame.assetId → baseLayer.assetId, for raw-pointer ↔ display-proxy pairing. */
  frameCompanionAssets: Map<string, string>;
}

/**
 * Step 3 — reads every frame from State_V1, sanitizes it in memory
 * (string colors → ColorValue, obsolete top-level fields stripped, text
 * boxMode/verticalAlign/bounding healed) and gathers the asset-reference
 * metadata the asset-upgrade pass needs.
 */
async function collectLegacyFrames(frameIds: string[]): Promise<CollectedLegacyFrames> {
  const result: CollectedLegacyFrames = {
    updates: {},
    activeAssetIds: new Set(),
    assetLogicalWidths: new Map(),
    assetFallbackDims: new Map(),
    frameCompanionAssets: new Map(),
  };
  const { updates, activeAssetIds, assetLogicalWidths, assetFallbackDims, frameCompanionAssets } = result;

  for (const id of frameIds) {
    const frameData = await LegacyStateDriver.getItem<Record<string, unknown>>(`frame:${id}`);
    if (!frameData) {
      console.warn(`[Migrator] Legacy frame:${id} referenced in project_meta was not found in State_V1.`);
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
    console.debug(`[Migrator] Prepared frame [${id}] ("${frameName}")`);
    updates[`frame:${id}`] = cleanFrame;
  }

  return result;
}

/**
 * Derives a dprScale hint for a text asset from its rasterized physical width
 * vs the layer's logical rect width (only when that ratio exceeds 1).
 */
async function resolveTextDprHint(assetId: string, assetLogicalWidths: Map<string, number>): Promise<number | undefined> {
  const logicalW = assetLogicalWidths.get(assetId);
  if (!logicalW || logicalW <= 0) return undefined;
  const legacyAsset = await LegacyAssetDriver.getItem<LegacyAssetRecord>(assetId);
  const v3Asset = !legacyAsset ? await AssetDriver.getItem<StoredAsset>(assetId) : null;
  const physW = legacyAsset?.tileMeta?.originalDimensions?.w || legacyAsset?.width || v3Asset?.width || 0;
  if (physW <= 0) return undefined;
  const calc = Math.round((physW / logicalW) * 100) / 100;
  return calc > 1 ? calc : undefined;
}

/**
 * Automatic fault-tolerant migration from v1 (State_V1) to v2 (State_V2).
 * Ensures zero-touch upgrade for legacy users on cold boot.
 *
 * Log contract: `debug` narrates the process (per-frame preparation, per-asset
 * probing, batch writes); `info` is reserved for final outcomes (per-asset
 * migration success, overall success) and `warn`/`error` for failures.
 */
export async function checkAndMigrateV1(
  onStage?: (stage: MigrationStage) => void,
): Promise<void> {
  try {
    // 1. O(1) Preflight: terminal flag check in State_V1
    const isMigrated = await LegacyStateDriver.getItem<boolean>('v2_migrated');
    if (isMigrated) {
      console.debug('[Migrator] v1 already migrated.');
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
    console.debug(`[Migrator] Detected ${legacyMeta.frameIds.length} legacy v1 artboard(s). Starting automatic migration to State_V2...`);

    // 3. Read + sanitize all frames from State_V1
    const { updates, activeAssetIds, assetLogicalWidths, assetFallbackDims, frameCompanionAssets } =
      await collectLegacyFrames(legacyMeta.frameIds);

    // Also read history_index if present
    const historyIndex = await LegacyStateDriver.getItem<GlobalHistoryState>('history_index');
    if (historyIndex) {
      Hydrating.extractAllIds(historyIndex, activeAssetIds);
      updates['history_index'] = historyIndex;
    }

    updates['project_meta'] = legacyMeta;

    // 4. Upgrade referenced legacy assets in Assets_V2 with self-healing, raw sourceBlobs, and guards
    console.debug(`[Migrator] Inspecting and upgrading ${activeAssetIds.size} referenced asset(s)...`);
    for (const assetId of activeAssetIds) {
      const hintDpr = await resolveTextDprHint(assetId, assetLogicalWidths);
      await upgradeAssetIfLegacy(
        assetId,
        hintDpr,
        assetFallbackDims.get(assetId),
        frameCompanionAssets.get(assetId),
      );
    }

    // 5. Transactional batch write into State_V2
    console.debug(`[Migrator] Writing ${Object.keys(updates).length} record(s) to State_V2...`);
    await ShardedStateDriver.setItems(updates);

    // 6. Only after ALL writes succeed, commit terminal flag in State_V1
    await LegacyStateDriver.setItem('v2_migrated', true);

    console.info('[Migrator] Successfully migrated legacy v1 artboards to v2! Terminal flag set in State_V1.');
  } catch (err) {
    console.error('[Migrator] Automatic migration from v1 failed (will retry on next refresh):', err);
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

    console.debug('[Migrator] Running post-migration healing pass on State_V2 records...');
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
                  console.debug(`[Migrator] Healed dprScale for text asset [${assetId.slice(0, 10)}] (${calculatedDpr}x)`);
                  asset.dprScale = calculatedDpr;
                  await AssetDriver.setItem(assetId, asset);
                }
              }
            }
          }
        }
      }

      if (frameModified) {
        console.debug(`[Migrator] Healed layer colors and attributes for frame [${id}]`);
        updates[`frame:${id}`] = frameData;
      }
    }

    if (Object.keys(updates).length > 0) {
      await ShardedStateDriver.setItems(updates);
    }

    await StateDriver.setItem(V2_HEAL_FLAG_KEY, true);
    await StateDriver.setItem('v2_healed_layer_colors_dpr', true);
    console.info('[Migrator] Post-migration healing pass completed successfully.');
  } catch (err) {
    console.warn('[Migrator] Post-migration healing pass encountered an error (will retry next time):', err);
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
