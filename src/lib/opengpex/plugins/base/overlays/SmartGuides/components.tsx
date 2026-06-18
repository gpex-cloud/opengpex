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

import React, { useEffect } from 'react';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { EDITOR_Z_INDEX } from '@opengpex/editor/core/helpers/config';
import { SmartGuideData } from '@opengpex/editor/core/types';
import { Magnet } from 'lucide-react';
import FunctionButton from '@opengpex/editor/widgets/FunctionButton';
import { useSmartGuides } from './hooks';
import { useFastSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { Motion } from '@opengpex/editor/core/motion';

/**
 * SmartGuides Component: Renders geometric alignment helper lines on the stage (Fast-Path version).
 */
export function SmartGuides() {
  const { isEnabled } = useSmartGuides();
  const { state } = useEditorState();
  const { actions, geometry } = useEditorServices();
  const { isSnapping } = state.interaction;
  
  const xRef = React.useRef<HTMLDivElement>(null);
  const yRef = React.useRef<HTMLDivElement>(null);

  // Core decoupling logic: Synchronize plugin configuration to core interaction state
  useEffect(() => {
    const nextEnabled = !!isEnabled;
    if (isSnapping !== nextEnabled) {
      actions.setInteraction({ isSnapping: nextEnabled });
    }
  }, [isEnabled, isSnapping, actions]);

  const COLORS = {
    normal: '#ff00ff', // Fuchsia: Normal alignment
    birth: '#ffcc00'   // Gold: Alignment with initial spawn point
  };

  // Core synchronization logic: Project world coordinates to screen space every frame
  useFastSync(xRef, !!isEnabled, (v, f, cam) => {
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
  });

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: EDITOR_Z_INDEX.UI.OVERLAY }}>
      {/* Vertical Guide (X) */}
      <div 
        ref={xRef}
        className="absolute top-0 bottom-0 w-[1px] will-change-[left,opacity]"
        style={{ display: 'none' }}
      />

      {/* Horizontal Guide (Y) */}
      <div 
        ref={yRef}
        className="absolute left-0 right-0 h-[1px] will-change-[top,opacity]"
        style={{ display: 'none' }}
      />
    </div>
  );
}

/**
 * SmartGuidesToggle: Magnet toggle switch contributed to TOOL_BAR_BOTTOM.
 */
export function SmartGuidesToggle() {
  const { isEnabled, toggleCmd } = useSmartGuides();

  return (
    <FunctionButton 
      onClick={() => toggleCmd?.execute()}
      active={isEnabled}
      title={`Toggle Smart Guides (${toggleCmd?.shortcutLabel || ''})`}
      tooltipPosition="right"
    >
      <Magnet size={18} />
    </FunctionButton>
  );
}
