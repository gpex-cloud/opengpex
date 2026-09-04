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

import { useEditorServices } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/state/volatile';
import { Motion } from '@opengpex/editor/core/motion';
import { SmartGuideData } from '@opengpex/editor/core/types';

const COLORS = {
  normal: '#ff00ff', // Fuchsia: Normal alignment
  birth: '#ffcc00'   // Gold: Alignment with initial spawn point
};

/**
 * useSmartGuidesFastSync: Smart guides screen-space synchronization.
 *
 * Projects world-coordinate guide positions to screen space every frame.
 * [P0 Perf] Throttled to ~30Hz during interaction — guide lines are transient UI hints.
 */
export function useSmartGuidesFastSync(
  xRef: React.RefObject<HTMLDivElement | null>,
  yRef: React.RefObject<HTMLDivElement | null>,
  isActive: boolean,
) {
  const { geometry } = useEditorServices();

  useFastSync(xRef, isActive, (v, f, cam) => {
    if (!xRef.current || !yRef.current) return;

    // Get transient guide data directly from volatile state
    const smartguides = v.transient.smartguides as SmartGuideData | undefined;

    if (!smartguides || !v.activeState.interacting) {
      Motion.set([xRef.current, yRef.current], {
        opacity: 0,
        display: 'none',
        overwrite: true
      });
      return;
    }

    const { x, y, isBirthX, isBirthY } = smartguides;

    // 1. Process vertical guide (X)
    if (typeof x === 'number') {
      const screenX = geometry.space.worldToScreen(x, 0, f, cam).x;
      const snappedX = geometry.snapping.snapPoint({ x: screenX, y: 0 }).x;

      Motion.set(xRef.current, {
        display: 'block',
        opacity: 1,
        left: snappedX,
        backgroundColor: isBirthX ? COLORS.birth : COLORS.normal,
        boxShadow: `0 0 4px ${isBirthX ? 'rgba(255,204,0,0.5)' : 'rgba(255,0,255,0.3)'}`,
        transition: 'none', // Force disable transition to prevent color flickering
        overwrite: true
      });
    } else {
      Motion.set(xRef.current, { opacity: 0, display: 'none' });
    }

    // 2. Process horizontal guide (Y)
    if (typeof y === 'number') {
      const screenY = geometry.space.worldToScreen(0, y, f, cam).y;
      const snappedY = geometry.snapping.snapPoint({ x: 0, y: screenY }).y;

      Motion.set(yRef.current, {
        display: 'block',
        opacity: 1,
        top: snappedY,
        backgroundColor: isBirthY ? COLORS.birth : COLORS.normal,
        boxShadow: `0 0 4px ${isBirthY ? 'rgba(255,204,0,0.5)' : 'rgba(255,0,255,0.3)'}`,
        transition: 'none',
        overwrite: true
      });
    } else {
      Motion.set(yRef.current, { opacity: 0, display: 'none' });
    }
  }, { throttleHz: 30 });
}
