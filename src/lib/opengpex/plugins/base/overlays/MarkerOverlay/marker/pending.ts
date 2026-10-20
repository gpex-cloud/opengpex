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
 * Per-kind pending marker style: the ONE place that knows how a kind's
 * remembered style (stored in CraftDrawer's config) is looked up, overlaid on
 * the kind's registry defaults, and updated. Shared by the CraftDrawer marker
 * panel (reads/writes) and this plugin's draw handler (reads the style of the
 * next marker), so both resolve the same numbers. Lives with the marker data
 * model because it is about MarkerData, not about the drawer.
 */

import { MARKER_REGISTRY } from './registry';
import { hasCornerRadius, type MarkerData, type MarkerKind } from './types';
import type { CraftDrawerConfig, PendingMarkerStyle } from '../../../drawers/CraftDrawer/protocols';

/**
 * The remembered style for `kind`: its own entry first, then the legacy single
 * preset (pre per-kind storage) as a fallback, else nothing.
 */
export function resolvePendingMarkerStyle(
  config: Pick<CraftDrawerConfig, 'pendingMarkerByKind' | 'pendingMarkerData'> | undefined,
  kind: MarkerKind,
): PendingMarkerStyle | undefined {
  return config?.pendingMarkerByKind?.[kind] ?? config?.pendingMarkerData;
}

/**
 * The kind's registry defaults overlaid with its remembered style — the data a
 * NEXT marker of that kind is drawn with, and what the panel shows while no
 * layer of that kind is being edited. `undefined` for an unregistered kind.
 */
export function resolveNextMarkerData(
  config: Pick<CraftDrawerConfig, 'pendingMarkerByKind' | 'pendingMarkerData'> | undefined,
  kind: MarkerKind,
): MarkerData | undefined {
  const def = MARKER_REGISTRY.get(kind);
  if (!def) return undefined;
  const base = def.defaults();
  const pending = resolvePendingMarkerStyle(config, kind);
  if (!pending) return base;
  if (pending.stroke) base.stroke = { ...base.stroke, ...pending.stroke };
  if (pending.fill) base.fill = { ...base.fill, ...pending.fill };
  if (typeof pending.cornerRadius === 'number' && hasCornerRadius(base)) {
    base.cornerRadius = pending.cornerRadius;
  }
  if (pending.antiAliased !== undefined) base.antiAliased = pending.antiAliased;
  if (typeof pending.sides === 'number' && base.kind === 'polygon') base.sides = pending.sides;
  if (typeof pending.points === 'number' && base.kind === 'star') base.points = pending.points;
  return base;
}

/**
 * Fold a panel edit into a kind's remembered style. `current` is the resolved
 * data the panel is showing (so partial stroke/fill patches merge onto real
 * values, not onto an empty preset).
 */
export function mergePendingMarkerStyle(
  previous: PendingMarkerStyle | undefined,
  current: MarkerData,
  patch: Partial<MarkerData> & { cornerRadius?: number; sides?: number; points?: number },
): PendingMarkerStyle {
  const next: PendingMarkerStyle = { ...(previous ?? {}) };
  if (patch.stroke) next.stroke = { ...current.stroke, ...patch.stroke };
  if (patch.fill) next.fill = { ...current.fill, ...patch.fill };
  if (typeof patch.cornerRadius === 'number') next.cornerRadius = patch.cornerRadius;
  if (typeof patch.sides === 'number') next.sides = patch.sides;
  if (typeof patch.points === 'number') next.points = patch.points;
  if (patch.antiAliased !== undefined) next.antiAliased = patch.antiAliased;
  return next;
}

/** `config.pendingMarkerByKind` with `kind` replaced by `style`. */
export function withPendingMarkerStyle(
  config: Pick<CraftDrawerConfig, 'pendingMarkerByKind'> | undefined,
  kind: MarkerKind,
  style: PendingMarkerStyle,
): Partial<Record<MarkerKind, PendingMarkerStyle>> {
  return { ...(config?.pendingMarkerByKind ?? {}), [kind]: style };
}
