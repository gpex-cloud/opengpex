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

import React, { useRef, useEffect } from 'react';
import { useEditorState, useEditorServices } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { Grid } from 'lucide-react';
import { FancyButton } from '@opengpex/editor/widgets/FancyButton';
import { usePixelGridCommands } from './hooks';

/**
 * PixelGridOverlayContainer: Render a 1px physical grid aligned with image pixels when zoomed in.
 */
export function PixelGridOverlayContainer() {
  const { state, activeFrame } = useEditorState();
  const { geometry } = useEditorServices();
  const { isEnabled, zoomThreshold, gridColor } = usePixelGridCommands();
  const ref = useRef<HTMLDivElement>(null);
  
  // Cache values to avoid touching DOM at 60 FPS if nothing changed
  const lastScaleRef = useRef<number>(-1);
  const lastShowRef = useRef<boolean | null>(null);
  
  // Performance optimization: cache editor viewport dimensions via Ref, avoiding high-frequency reading of window.innerWidth
  const viewportDimRef = useRef(state.ui.viewportDim);
  useEffect(() => {
    viewportDimRef.current = state.ui.viewportDim;
  }, [state.ui.viewportDim]);
  
  useFastSync(ref, true, (v, f, cam) => {
    if (!ref.current) return;

    const scale = geometry.getScale(f, cam);
    const shouldShow = isEnabled && scale >= zoomThreshold;
    
    if (shouldShow !== lastShowRef.current) {
      lastShowRef.current = shouldShow;
      ref.current.style.opacity = shouldShow ? '1' : '0';
    }

    if (!shouldShow) return; // Optimization: do not calculate matrix if hidden

    // 1. Calculate Canvas bounding box in screen space
    const canvasWorldRect = geometry.asWorldRect({ x: -f.canvas.w / 2, y: -f.canvas.h / 2, w: f.canvas.w, h: f.canvas.h });
    const screenRect = geometry.space.worldToScreenRect(canvasWorldRect, f, cam);

    // 2. Clamp the rendering DOM to the viewport to prevent massive layer compositor crashes (>8192px)
    const { w: vw, h: vh } = viewportDimRef.current;
    
    const left = Math.max(-50, screenRect.x);
    const top = Math.max(-50, screenRect.y);
    const right = Math.min(vw + 50, screenRect.x + screenRect.w);
    const bottom = Math.min(vh + 50, screenRect.y + screenRect.h);
    
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);

    if (width === 0 || height === 0) {
      ref.current.style.display = 'none';
      return;
    }

    // 3. Update physical DOM bounds
    ref.current.style.display = 'block';
    ref.current.style.transform = `translate(${left}px, ${top}px)`;
    ref.current.style.width = `${width}px`;
    ref.current.style.height = `${height}px`;

    // 4. Update background offset so the grid anchors perfectly to the original Canvas top-left
    const bgPosX = screenRect.x - left;
    const bgPosY = screenRect.y - top;
    ref.current.style.backgroundPosition = `${bgPosX}px ${bgPosY}px`;

    // 5. Update grid size
    if (scale !== lastScaleRef.current) {
      lastScaleRef.current = scale;
      ref.current.style.backgroundSize = `${scale}px ${scale}px`;
    }
  });

  if (!activeFrame) return null;

  return (
    <div 
      ref={ref} 
      className="absolute top-0 left-0 pointer-events-none origin-top-left"
      style={{ 
        opacity: 0,
        boxSizing: 'border-box',
        border: `1px solid ${gridColor}`,
        backgroundImage: `
          linear-gradient(to right, ${gridColor} 1px, transparent 1px),
          linear-gradient(to bottom, ${gridColor} 1px, transparent 1px)
        `,
        backgroundRepeat: 'repeat'
      }}
    />
  );
}

/**
 * PixelGridToggle: Toolbar toggle switch contribution
 */
export function PixelGridToggle() {
  const { isEnabled, toggleCmd } = usePixelGridCommands();

  return (
    <FancyButton 
      onClick={() => toggleCmd?.execute()}
      active={isEnabled}
      title={`Toggle Pixel Grid (${toggleCmd?.shortcutLabel || ''})`}
      tooltipPosition="right"
      iconOnly
      shape="rect"
    >
      <Grid size={18} />
    </FancyButton>
  );
}
