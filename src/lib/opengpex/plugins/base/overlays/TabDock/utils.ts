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

import { Frame } from '@opengpex/editor/core/types';
import { TabDockConfig } from './protocols';

interface DockPosition {
  left: string | number;
  top: string | number;
  right: string | number;
  bottom: string | number;
  x: string | number;
  y: string | number;
}

/**
 * Calculates the dock position based on snap settings or manual position.
 */
export const calculateDockPosition = (config: TabDockConfig) => {
  const MARGIN = 24;
  if (config.position) {
    return { left: 0, top: 0, right: 'auto', bottom: 'auto', x: config.position.x, y: config.position.y };
  }
  const snap = config.snap || 'BC';
  
  const OFF_L = 'var(--v-offset-fixed-left)';
  const OFF_R = 'var(--v-offset-fixed-right)';
  const OFF_B = 'var(--v-offset-bottom)';

  const LEFT = `calc(${OFF_L} + ${MARGIN}px)`;
  const RIGHT = `calc(${OFF_R} + ${MARGIN}px)`;
  const BOTTOM = `calc(${OFF_B} + ${MARGIN}px)`;
  const CENTER_X = `calc(${OFF_L} + (100% - ${OFF_L} - ${OFF_R}) / 2)`;
  
  const points: Record<string, DockPosition> = {
    'BL': { left: LEFT, top: 'auto', right: 'auto', bottom: BOTTOM, x: 0, y: 0 },
    'BC': { left: CENTER_X, top: 'auto', right: 'auto', bottom: BOTTOM, x: '-50%', y: 0 },
    'BR': { left: 'auto', top: 'auto', right: RIGHT, bottom: BOTTOM, x: 0, y: 0 },
  };
  return points[snap] || points['BC'];
};

/**
 * Flattens a reordered trunk list back into a full frame order.
 *
 * Each trunk is emitted first, immediately followed by all of its descendant
 * branches (any depth) in their original relative order as found in
 * `orderedFrames`. Rebuilding descendants from the ordered list (instead of
 * from the branch-menu structure, which lists newest-first) keeps branch order
 * stable across trunk drags.
 */
export const flattenReorderedFrames = (
  orderedFrames: Frame[],
  newTrunkOrder: Frame[],
): Frame[] => {
  const byId = new Map(orderedFrames.map(f => [f.id, f]));
  // Maps every frame to the id of the trunk it descends from (trunks map to
  // themselves). The guard bounds the walk for malformed cyclic parent chains.
  const rootIdOf = new Map<string, string>();
  for (const f of orderedFrames) {
    let cur: Frame | undefined = f;
    let guard = 0;
    while (cur?.parentId && guard++ <= orderedFrames.length) {
      cur = byId.get(cur.parentId);
    }
    rootIdOf.set(f.id, cur?.id ?? f.id);
  }

  return newTrunkOrder.flatMap(root => {
    const members = orderedFrames.filter(f => rootIdOf.get(f.id) === root.id);
    const descendants = members.filter(f => f.id !== root.id);
    const rootFirst = members.find(f => f.id === root.id) ?? root;
    return [rootFirst, ...descendants];
  });
};

/**
 * Calculates the branch structure for a set of frames.
 */
export const calculateBranches = (frames: Frame[], trunkFrames: Frame[]) => {
  const adj = frames.reduce((acc, f) => {
    if (f.parentId) {
      if (!acc[f.parentId]) acc[f.parentId] = [];
      acc[f.parentId].unshift(f);
    }
    return acc;
  }, {} as Record<string, Frame[]>);

  const getDeepBranches = (parentId: string, depth = 1): { frame: Frame; depth: number }[] => {
    const children = adj[parentId] || [];
    let result: { frame: Frame; depth: number }[] = [];
    for (const child of children) {
      result.push({ frame: child, depth });
      result = result.concat(getDeepBranches(child.id, depth + 1));
    }
    return result;
  };

  return trunkFrames.reduce((acc, trunk) => {
    acc[trunk.id] = getDeepBranches(trunk.id);
    return acc;
  }, {} as Record<string, { frame: Frame; depth: number }[]>);
};
