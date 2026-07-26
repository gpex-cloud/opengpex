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
import { Magnet } from 'lucide-react';
import { FancyButton } from '@opengpex/editor/widgets/FancyButton';
import { useSmartGuides } from './hooks';
import { useSmartGuidesFastSync } from './useFastSync';

/**
 * SmartGuides Component: Renders geometric alignment helper lines on the stage (Fast-Path version).
 */
export function SmartGuides() {
  const { isEnabled } = useSmartGuides();
  const { state } = useEditorState();
  const { actions } = useEditorServices();
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

  // Core synchronization logic (extracted to useFastSync.ts)
  useSmartGuidesFastSync(xRef, yRef, !!isEnabled);

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
    <FancyButton 
      onClick={() => toggleCmd?.execute()}
      active={isEnabled}
      title={`Toggle Smart Guides (${toggleCmd?.shortcutLabel || ''})`}
      tooltipPosition="right"
      iconOnly
      shape="rect"
    >
      <Magnet size={18} />
    </FancyButton>
  );
}
