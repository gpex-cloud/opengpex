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
 * migrators.ts — ALL legacy-document migrations on the load path, collected in
 * one module. `Hydrating.hydrate` runs the generic object recursion and calls
 * every migrator on each object it meets; each migrator gates itself on its
 * own precondition and is a no-op on already-migrated / modern records, so
 * they compose freely and undo-history snapshots migrate identically to live
 * frames (the recursion visits both).
 *
 * Contract shared by every migrator: mutate the record in place, never crash
 * on malformed legacy data (drop the low-value legacy artifact instead), and
 * delete the superseded keys so the in-memory tree carries only the modern
 * schema (saving then writes the new shape naturally — no format bump).
 *
 * @module core/storage/state/migrators
 */

import type {
  AdjustmentMask,
  AdjustmentState,
  ChannelMixState,
  ColorBalanceState,
  CurvesState,
  GradeState,
  LevelsState,
  LocalPolygon,
} from '@opengpex/editor/core/types';
import { isIdentityGrade } from '@opengpex/editor/core/helpers/adjustments';
import { LayerFactory } from '@opengpex/editor/core/layer/factory';

/** Ordered category list — the fixed in-stage evaluation order (models.ts). */
const GRADE_CATEGORIES = ['basic', 'levels', 'curves', 'channelMix', 'colorBalance'] as const;

const GRADE_ARM_KEY = {
  basic: 'adjustments',
  levels: 'levels',
  curves: 'curves',
  channelMix: 'channelMix',
  colorBalance: 'colorBalance',
} as const;

/** Categories whose arm is PRESENT in `g`, in evaluation order. */
function presentGradeCategories(g: GradeState) {
  return GRADE_CATEGORIES.filter((c) => g[GRADE_ARM_KEY[c]] !== undefined);
}

/** The discriminator for a grade bundle: FIRST present arm, 'basic' when empty. */
function gradeCategoryOf(g: GradeState) {
  const present = presentGradeCategories(g);
  return present.length ? present[0] : 'basic';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ─── Vector brush: one stroke per layer → stroke collection ──────────────────

/**
 * Documents saved before the stroke-collection refactor stored the brush
 * payload as a single `strokeData`. It lifts verbatim into a one-element
 * `strokes` array — nothing is dropped. The stroke's box in that payload was
 * the layer's own bounding (points were layer-local), so the box is derived
 * from the layer bounding when missing.
 */
export function migrateLegacyStrokeCollection(result: Record<string, unknown>): void {
  if (!(result.strokeData && typeof result.strokeData === 'object' && !Array.isArray(result.strokes))) return;
  const sd = result.strokeData as { points?: unknown; box?: unknown };
  const bounding = (result.bounding ?? result.rect) as { w?: unknown; h?: unknown } | undefined;
  const legacyBox = {
    x: 0,
    y: 0,
    w: typeof bounding?.w === 'number' ? bounding.w : 0,
    h: typeof bounding?.h === 'number' ? bounding.h : 0,
  };
  const lifted = { ...(sd as Record<string, unknown>), box: sd.box ?? legacyBox };
  result.strokes = [lifted];
  delete result.strokeData;
}

// ─── Selection: per-tool clip slots → single confinement entity ─────────────

/**
 * Frames saved before the single-slot refactor stored selections in
 * `clipBoxes`, a record keyed by producing tool id. Under the old
 * mutually-exclusive-slot model only the slot referenced by `latestClipTool`
 * was ever visible on canvas — the other slots were unobservable hidden
 * state. So the load-time migration takes exactly that slot as the sole
 * selection and drops the rest, with no perceivable loss. A frame without
 * legacy slots but also without the new field (e.g. a hand-edited or
 * partially-persisted snapshot) normalizes to "no selection".
 */
export function migrateLegacyClipBoxes(result: Record<string, unknown>): void {
  if (result.clipBoxes && typeof result.clipBoxes === 'object') {
    const legacyBoxes = result.clipBoxes as Record<string, unknown>;
    const activeTool = (result.latestClipTool as string) || 'rect';
    if (result.confinement === undefined || result.confinement === null) {
      const slot = legacyBoxes[activeTool];
      // Only polygon selections migrate. Slots predating the polygon
      // unification carry plain rect shapes the ants/mask pipeline cannot
      // render — dropping the (ancient, low-value) selection beats
      // crashing the overlay.
      const isPolygon =
        !!slot && typeof slot === 'object' && Array.isArray((slot as { rings?: unknown }).rings);
      result.confinement = isPolygon ? slot : null;
    }
    delete result.clipBoxes;
  } else if (result.latestClipTool !== undefined && result.confinement === undefined) {
    result.confinement = null;
  }
}

// ─── Bitmap mask: defensive inverted-record reset ────────────────────────────

/**
 * Before the restore-family landed, v2 had NO producer of `inverted: true`
 * bmask records, but a hypothetical legacy import must not load one verbatim —
 * under the two-family combine semantics an inverted record would silently
 * change meaning (restore max instead of erase product). Restore-eraser
 * strokes are now a legitimate inverted producer and always stamp
 * `painted: true` on their records — so the bit is cleared ONLY on unpainted
 * records (a pre-restore legacy entry can never carry `painted`).
 * VectorMask has no assetId/bounds, so it never matches.
 */
export function migrateLegacyBmaskInverted(result: Record<string, unknown>): void {
  if (
    result.inverted === true &&
    result.painted !== true &&
    typeof result.assetId === 'string' &&
    result.bounds !== undefined
  ) {
    result.inverted = false;
  }
}

// ─── Grade: flat per-category fields → ONE adjustment mask ──────────────────

/** The pre-chain flat layer fields, read loosely off a hydrating record. */
interface LegacyGradeFields {
  adjustments?: unknown;
  curves?: unknown;
  levels?: unknown;
  channelMix?: unknown;
  colorBalance?: unknown;
  adjustmentConfinement?: unknown;
}

const LEGACY_GRADE_KEYS = [
  'adjustments', 'curves', 'levels', 'channelMix', 'colorBalance', 'adjustmentConfinement',
] as const;

/**
 * Fold the legacy flat grade fields of one LAYER record into a single
 * `AdjustmentMask`, deleting the six old keys and setting `adjustMasks` when
 * the fold yields a non-identity grade. Detected on the layer record itself
 * (a layer is the only object carrying `bounding` + numeric `cx`/`cy` +
 * `opacity`), so it runs wherever a layer lives — `layers.byId` of a live
 * frame, a history snapshot, a single-layer payload — without depending on
 * the container shape. Modern layers carry none of the legacy keys and pass
 * through untouched.
 *
 * Renders bit-identically to the old flat pipeline: all present arms go into
 * ONE mask, preserving the old single-stage fixed internal evaluation order.
 * A snapshot whose rings are not a non-empty array degrades to whole-layer
 * coverage; an all-identity grade yields NO mask even when a snapshot was
 * present (nothing to confine); a record that already carries `adjustMasks`
 * only has the legacy keys deleted (idempotent on re-hydration).
 */
export function migrateLegacyLayerGrade(result: Record<string, unknown>): void {
  // Layer-record signature gate (see doc above) — cheap and shape-independent.
  if (
    !(
      typeof result.id === 'string' &&
      result.bounding !== undefined &&
      typeof result.cx === 'number' &&
      typeof result.cy === 'number' &&
      typeof result.opacity === 'number'
    )
  ) {
    return;
  }

  const legacy = result as LegacyGradeFields;
  const hadLegacy = LEGACY_GRADE_KEYS.some((k) => k in result);
  if (!hadLegacy) return;

  const grade: GradeState = {};
  if (isPlainObject(legacy.adjustments)) grade.adjustments = legacy.adjustments as unknown as AdjustmentState;
  if (isPlainObject(legacy.levels)) grade.levels = legacy.levels as unknown as LevelsState;
  if (isPlainObject(legacy.curves)) grade.curves = legacy.curves as unknown as CurvesState;
  if (isPlainObject(legacy.channelMix)) grade.channelMix = legacy.channelMix as unknown as ChannelMixState;
  if (isPlainObject(legacy.colorBalance)) grade.colorBalance = legacy.colorBalance as unknown as ColorBalanceState;

  let shape: LocalPolygon | undefined;
  const conf = legacy.adjustmentConfinement;
  if (isPlainObject(conf) && Array.isArray(conf.rings) && conf.rings.length > 0) {
    shape = conf as unknown as LocalPolygon;
  }

  for (const k of LEGACY_GRADE_KEYS) delete result[k];

  if (Array.isArray(result.adjustMasks)) return;

  if (!isIdentityGrade(grade)) {
    const mask: AdjustmentMask = {
      id: LayerFactory.newAdjustMaskId(),
      category: gradeCategoryOf(grade),
      grade,
      enabled: true,
    };
    if (shape) mask.shape = shape;
    result.adjustMasks = [mask];
  }
}
