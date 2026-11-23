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

/**
 * LayerKind — the single declarative table answering every "given this layer
 * type, how should the system treat it?" question.
 *
 * WHY: type knowledge is currently scattered across six independent judgment
 * sites (SceneAssembler fillColor sniffing, CraftDrawer payload sniffing,
 * resolveNature type branching, the merge decision table's CRAFT_TYPES,
 * Hydrating.extractAllIds hard scans, and clipping/route.ts RASTER_SOURCE_TYPES).
 * This table is the strangler target: each site reads its column here instead.
 *
 * NATURE OF THE TABLE: a strategy TABLE, not strategy objects. Pure data plus
 * pure functions, no runtime identity, never holds state — coordinators
 * (LayerService, SceneAssembler, GC) read it and dispatch themselves.
 *
 * COLUMN SEMANTICS:
 *  - `payload`     — which Layer fields constitute this type's content.
 *  - `normalize`   — P2: turns a typed createLayer spec into a valid patch
 *                    (payload validation, provenance stamp, geometry and
 *                    naming conventions). Not present at P0 (types only).
 *  - `pipeline`    — how the layer's pixels enter the render pipeline, which
 *                    simultaneously decides HOW the color identity is ruled
 *                    (the single-ruling invariant rides on this column):
 *      'vector'  — analytic geometry rendered on GPU, no bitmap; identity is
 *                  implicitly the working space (vector/text; text is rendered
 *                  as vector — shared contributor registry, "vector spine").
 *      'bitmap'  — asset-pool bitmap; identity ruled once at ingest by the
 *                  decoder/bake, downstream reads the channel (image/paint).
 *      'derived' — pixels are synthesized per frame from document state and
 *                  exist nowhere else (color renders as a declarative
 *                  `{kind:'solid'}` scene source — no bytes, no asset).
 *                  Design distinction: imported assets persist, derived
 *                  assets regenerate.
 *      'none'    — not rendered (group containers).
 *    The combination space is deliberately collapsed: only (vector, implicit),
 *    (bitmap, ingest) and (derived, registered) occur in reality — declaring
 *    the two dimensions separately would be fake freedom.
 *  - `clippable`   — what happens when this layer is cut (nature's VALUE SPACE
 *                    is constrained by type even though nature is ASSIGNED by
 *                    clip strategies, not the factory): 'logical' = can share
 *                    the source asset through geometry (image/paint/color —
 *                    color's fill is declarative, fragments ride geometry);
 *                    'bake' = no samplable bitmap, any partial cut bakes
 *                    (text/vector); 'none' = cannot produce a fragment (group,
 *                    resolveNature returns undefined → R00 refusal).
 *  - `ui`          — UI inference (owning-tool panel routing, e.g. the
 *                    CraftDrawer's inferred panel), replacing payload sniffing
 *                    stamps scattered in consumers. The function
 *                    form handles per-type payload variants (vector's
 *                    markerData/penData) and paint's stamp sub-axis.
 *
 * @module core/layer/kinds
 */

import { asLocalShape, type Layer } from '@opengpex/editor/core/types';

/** 1×1 transparent GIF — the placeholder `src` for layers with no real pixels. */
export const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** How the layer's pixels enter the render pipeline (see module doc). */
export type LayerPipeline = 'vector' | 'bitmap' | 'derived' | 'none';

/** What happens when the layer is cut (see module doc). */
export type LayerClippable = 'logical' | 'bake' | 'none';

/**
 * Layer-panel glyph tokens. Core owns the TOKEN vocabulary; the UI maps each
 * token to its visual (icon component / gradient swatch / live thumbnail).
 * 'thumbnail' means: render the layer's real pixels, not a glyph.
 */
export type LayerIconToken =
  | 'gradient'    // color fill: rainbow gradient swatch
  | 'thumbnail'   // real pixels (imported photos, baked bitmaps)
  | 'mosaic'      // mosaic canvas (image stamped sourceTool:'mosaic')
  | 'heal'        // spot-heal canvas (sourceTool:'heal')
  | 'clone'       // clone stamp canvas (sourceTool:'clone')
  | 'blur'        // blur brush canvas (sourceTool:'blur')
  | 'sharpen'     // sharpen brush canvas (sourceTool:'sharpen')
  | 'brush'       // brush canvas (image/vector stamped sourceTool:'brush')
  | 'image'       // plain image glyph
  | 'text'        // text glyph
  | 'marker'      // marker vector (sourceTool:'marker')
  | 'pen'         // pen shape vector (sourceTool:'pen')
  | 'vector'      // plain vector glyph
  | 'folder';     // group container

/**
 * UI inference token: which owning-tool panel the layer's content implies.
 * Core-owned vocabulary, deliberately disjoint from any plugin's tool enum —
 * consumers (e.g. CraftDrawer) map hints onto their own panel models. Tokens
 * only exist for layer identities that a committed layer can carry; there is
 * deliberately NO 'brush' token: brush strokes commit as `vector` layers
 * (payload `strokes`), which infer no panel, and no code path stamps
 * `sourceTool: 'brush'` onto a paint layer (the former "paint + brush stamp →
 * BrushPanel" branch was unreachable — removed with its consumer in P1).
 */
export type LayerUiHint = 'text' | 'marker' | 'pen' | 'mosaic';

/**
 * Static declaration of one layer type (data columns plus the `ui` inference
 * and `normalize` creation functions).
 */
export interface LayerKind {
  type: Layer['type'];
  /**
   * Content-field gate — presence checks imply validation, there is no
   * opt-out flag. `assertPayload` enforces:
   *   - `allOf`: EVERY listed field must be present on the creation patch;
   *   - `anyOf`: AT LEAST ONE listed field must be present.
   * Omitting both columns means no content payload (group containers).
   * Nested requirements that a flat key list cannot express are handled
   * inside the kind row's own normalize.
   */
  payload: {
    anyOf?: readonly (keyof Layer)[];
    allOf?: readonly (keyof Layer)[];
  };
  pipeline: LayerPipeline;
  clippable: LayerClippable;
  /**
   * UI inference: which owning-tool panel the layer's content implies, or
   * null for none. This column OWNS the payload-shape and provenance-stamp
   * checks for its type (a vector layer examining its own `markerData` vs
   * `penData` is the vector kind's business, centralized here — consumers
   * must not sniff payloads to judge types).
   */
  ui: (layer: Layer) => LayerUiHint | null;
  /**
   * Turn the creation patch into its final field placement: validate the
   * required content payload and pass everything through. Called by
   * `LayerFactory.createLayer` — the ONE creation entry for authored layers.
   */
  normalize: (patch: Partial<Omit<Layer, 'type'>>) => Partial<Layer>;
  /**
   * GC reference derivation (P4): the asset ids this layer's CONTENT keeps
   * alive, appended into `out` during `Hydrating.extractAllIds`. The generic
   * DFS already collects literal `assetId` handles; this column adds the
   * DERIVED ids a plain scan cannot see. No row derives derived ids today:
   * the color fill's declarative source carries no asset identity (the
   * retired `solid:` byte subsystem kept no cache entry to protect), so every
   * row's content is either the literal handle (image) or pure payload
   * (text/vector/color/group).
   */
  /**
   * Panel glyph token (see {@link LayerIconToken}). The per-row functions
   * route provenance stamps (mosaic/brush/marker/pen) — the same stamp
   * routing the `ui` column performs for panel inference, scoped to glyphs.
   */
  icon: (layer: Layer) => LayerIconToken;
}

// ─── normalize: patch validation + stamp folding (creation conventions per kind) ──

/** Pure passthrough (P2 review decision): payload validation lives in the
 * column-driven `assertPayload`; provenance stamps are handed in directly as
 * `metadata.sourceTool` by the owning overlays; foreign-payload fields pass
 * through deliberately — cross-kind hygiene belongs to merge-time
 * `craftPayloadStrip`, and derivative spreads legitimately carry shared
 * carriers. */
/** A rect with zero extent (the blank template's visibleShape seed). */
const isZeroRect = (r: { w: number; h: number }): boolean => r.w === 0 && r.h === 0;

function normalizePatch(patch: Partial<Omit<Layer, 'type'>>): Partial<Layer> {
  // The generic layer names and ids itself, and reconciles its content
  // frame: a caller who passed no real visibleShape gets one matching the
  // bounding ("visibleShape always has meaning" — zero-bounding keeps the
  // zero rect, nothing to reveal). Per-type rows override (the group row
  // names its containers 'Group' and stamps them `g-`).
  const visibleShape =
    patch.visibleShape && !isZeroRect(patch.visibleShape.rect)
      ? patch.visibleShape
      : asLocalShape({ x: 0, y: 0, w: patch.bounding?.w ?? 0, h: patch.bounding?.h ?? 0 });
  return {
    ...patch,
    name: patch.name ?? 'New Layer',
    id: patch.id ?? `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    visibleShape,
  };
}

/**
 * Payload gate driven ENTIRELY by the kind row's `payload` column (P2
 * review decision — no per-row re-declaration): every field named in
 * `allOf` must be present, and at least one field named in `anyOf` must
 * be present. Nested requirements that a flat key list cannot express
 * (the color row's fillColor shape check) get an explicit check inside
 * that kind row's own normalize.
 */
export function assertPayload(kind: LayerKind, patch: Partial<Omit<Layer, 'type'>>): void {
  if (kind.payload.allOf) {
    const missing = kind.payload.allOf.filter((f) => (patch as Record<string, unknown>)[f as string] === undefined);
    if (missing.length > 0) {
      throw new Error(`createLayer(${kind.type}): content payload missing — ALL of [${kind.payload.allOf.join(', ')}] is required`);
    }
  }
  if (kind.payload.anyOf) {
    const record = patch as Record<string, unknown>;
    const present = kind.payload.anyOf.some((f) => record[f as string] !== undefined);
    if (!present) {
      throw new Error(
        `createLayer(${kind.type}): content payload missing — one of [${kind.payload.anyOf.join(', ')}] is required`,
      );
    }
  }
}

/**
 * The table itself — one row per layer type, keyed by that type. Single source
 * of truth: no other module may keep a type-literal judgment set that this
 * table already answers (guard tests enforce the derivations).
 */
export const LAYER_KINDS: Readonly<Record<Layer['type'], LayerKind>> = {
  image: {
    type: 'image',
    // 'image' means REAL pixels: ingest/import/bake always yield src+assetId
    // as an AND-pair (enforced — use createLayer('blank') for empty
    // placeholder hosts). The completion seeds placeholders for blank hosts.
    payload: { allOf: ['assetId', 'src'] },
    pipeline: 'bitmap',
    clippable: 'logical',
    /**
     * Stamp routing (P5: the paint kind merged into image): a mosaic canvas
     * is an image stamped `sourceTool:'mosaic'`; every retouch-family mode
     * mirrors it with its own stamp ('heal', 'blur', 'sharpen', 'clone') and
     * infers the shared RetouchPanel; UNSTAMPED image layers are plain
     * pixels/photos — no owning tool, no panel (so retouch stamps can never
     * hijack a photo's panel).
     */
    icon: (layer) => {
      const tool = layer.metadata?.sourceTool;
      // Per-mode glyph tokens — each retouch mode shows its own stamp icon.
      return tool === 'mosaic' || tool === 'heal' || tool === 'blur' || tool === 'sharpen' || tool === 'clone'
        ? (tool as 'mosaic' | 'heal' | 'clone' | 'blur' | 'sharpen')
        : 'thumbnail';
    },
    ui: (layer) => {
      const tool = layer.metadata?.sourceTool;
      return tool === 'mosaic' || tool === 'heal' || tool === 'blur' || tool === 'sharpen' || tool === 'clone'
        ? 'mosaic'
        : null;
    },
    // Image layers may be blank (canvas-sized host layers) — no payload gate.
    normalize: normalizePatch,
  },
  text: {
    type: 'text',
    payload: { anyOf: ['textData'] },
    pipeline: 'vector',
    clippable: 'bake',
    ui: () => 'text', // text content always implies the text panel
    icon: () => 'text',
    normalize: normalizePatch,
  },
  vector: {
    type: 'vector',
    // Brush collection OR pen shape OR marker — the anyOf gate passes when
    // any one carries content.
    payload: { anyOf: ['strokes', 'strokeData', 'penData', 'markerData'] },
    pipeline: 'vector',
    clippable: 'bake',
    // The panel follows which payload variant the layer carries.
    ui: (layer) => {
      if (layer.markerData) return 'marker';
      if (layer.penData) return 'pen';
      return null; // brush strokes / plain vector content infer no panel
    },
    icon: (layer) => {
      if (layer.metadata?.sourceTool === 'marker') return 'marker';
      if (layer.metadata?.sourceTool === 'brush') return 'brush';
      if (layer.metadata?.sourceTool === 'pen') return 'pen';
      return 'vector';
    },
    normalize: normalizePatch,
    // Craft CONTENT in the authored-in-app sense. The merge product rule
    // (P5: bake products are always 'image') no longer consults this column.
  },
  color: {
    type: 'color',
    payload: { anyOf: ['fillColor'] },
    // The fill renders DECLARATIVELY (a `{kind:'solid'}` declaration resolved
    // from the payload's mathematical description by the scene-assembly
    // translator — no bytes, no cache entry, no asset identity), so 'derived'
    // keeps its "pixels exist nowhere else" meaning without a registration
    // leg.
    pipeline: 'derived',
    clippable: 'logical',
    ui: () => null, // pure fills infer no craft panel
    icon: () => 'gradient',
    // A fill layer is BORN logical: its content is a mathematical description
    // (pixels exist nowhere), and it is the only layer kind that can carry a
    // non-rect visibleShape without ever passing through a clip strategy —
    // the polygon serialization of an ellipse/lasso/wand selection. The
    // renderer's implicit shape mask (the vmask that turns that non-rect
    // shape into actual coverage) gates on `nature === 'logical'`, because a
    // physical layer's contour is already baked into its pixels. Without this
    // stamp the fill layer's nature is undefined, the gate classifies it as
    // physical, and every non-rect selection fills as its bounding rect.
    // This is the one deliberate exception to "nature is assigned only by
    // clip strategies": the fill's birth is the equivalent of a clip product
    // that never had a source bitmap to begin with.
    normalize: (patch) => ({ ...normalizePatch(patch), nature: 'logical' }),
  },
  group: {
    type: 'group',
    // Containers carry no content payload.
    payload: {},
    pipeline: 'none',
    clippable: 'none',
    ui: () => null, // containers infer no craft panel
    icon: () => 'folder',
    /**
     * Group container conventions (formerly the standalone `getNewGroup`):
     * transparent placeholder pixels via the shared blank template, not
     * hit-testable, expanded by default — and deliberately a `g-` id plus NO
     * role (a container has never carried either; the normalized patch emits
     * both AFTER the spread so the generic template's 'host' role and `l-`
     * id are overridden, not inherited).
     */
    normalize: (patch) => ({
      ...normalizePatch(patch),
      id: patch.id ?? `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: patch.name ?? 'Group',
      interactive: false,
      role: undefined,
      collapsed: false,
    }),
  },
};

/** Convenience lookup: the kind row for a layer type.
 *
 * The `'blank'` CREATION discriminator resolves to the image kind **with its
 * payload gate removed**: a blank host completes through the image template,
 * and its whole content contract is "no real pixels — the placeholder
 * carriers seeded by the blank template are the payload". Asserting the
 * image row's assetId/src requirement against it would be wrong.
 */
export function getLayerKind(type: Layer['type'] | 'blank'): LayerKind {
  if (type === 'blank') {
    const image = LAYER_KINDS.image;
    return { ...image, payload: {} };
  }
  return LAYER_KINDS[type];
}
