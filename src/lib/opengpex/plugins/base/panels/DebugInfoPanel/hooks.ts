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

/* eslint-disable react-hooks/refs */

'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useEditorState, useEditorServices, usePluginSelfConfig, usePluginCommands } from '@opengpex/editor/core/context';
import * as P from './protocols';
import { CLIP_OPTIONS_SIGNAL_RE_CANVAS } from '../../options/ClipOptions/protocols';

/**
 * useDebugInfo: Unified debug data hook (including sample drive and coordinate calculations)
 */
export const useDebugInfo = () => {
  const { state, activeFrame, activeLayer } = useEditorState();
  const { actions, geometry } = useEditorServices();
  const [selfConfig] = usePluginSelfConfig<P.DebugConfig>();
  const { toggleCmd } = usePluginCommands();
  const isEnabled = selfConfig?.enabled ?? false;

  // 1. Sampling timer (Tick Driven)
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!isEnabled) return;
    const timer = setInterval(() => setTick(t => t + 1), 60);
    return () => clearInterval(timer);
  }, [isEnabled]);

  // 2. Real-time mouse position tracking (Refs for performance)
  const mouseRef = useRef({ vx: 0, vy: 0 });

  useEffect(() => {
    if (!isEnabled) return;

    // [Core Optimization]: No longer query DOM in mousemove, search viewport container name instead
    const container = document.querySelector('.editor-viewport-container');

    const handleMouseMove = (e: MouseEvent) => {
      if (!container) return;
      const rect = container.getBoundingClientRect();
      mouseRef.current = {
        vx: Math.round(e.clientX - rect.left),
        vy: Math.round(e.clientY - rect.top)
      };
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [isEnabled]);

  // 3. Data layer (Data): Responsible for all physical metrics calculations
  const metrics = useMemo(() => {
    void tick;
    const isReady = isEnabled && activeFrame;

    if (!isReady) return null;

    const currentMouse = mouseRef.current;

    const cam = actions.fast.latestCamera(activeFrame.id);
    const layer = activeLayer ? actions.fast.latestLayer(activeFrame.id, activeLayer.id) : null;

    // Layer core metrics (extract complete info if layer exists)
    let activeLayerMetrics = null;
    if (layer) {
      const worldPos = { x: layer.cx, y: layer.cy };
      const pPos = geometry.space.worldToLocal(worldPos.x, worldPos.y, activeFrame);
      const localX = pPos.x - layer.bounding.w / 2;
      const localY = pPos.y - layer.bounding.h / 2;
      activeLayerMetrics = {
        id: layer.id,
        name: layer.name,
        type: layer.type,
        role: layer.role,
        visible: layer.visible,
        locked: layer.locked,
        opacity: layer.opacity,
        rotation: layer.rotation,
        scale: layer.scale,
        width: layer.bounding.w,
        height: layer.bounding.h,
        world: worldPos,
        physical: pPos,
        local: { x: localX, y: localY },
      };
    }

    // Mouse core metrics
    const mouseW = geometry.space.screenToWorld(currentMouse.vx, currentMouse.vy, activeFrame, cam);
    const mouseP = geometry.space.screenToLocal(currentMouse.vx, currentMouse.vy, activeFrame, cam);

    // Clip core metrics
    const isReCanvas = state.getStateSignal(CLIP_OPTIONS_SIGNAL_RE_CANVAS);
    const cropShape = isReCanvas ? activeFrame.canvasCropBox : activeFrame.imageCropBox;
    const cropBox = cropShape?.rect || { x: 0, y: 0, w: 0, h: 0 };
    const screenCropPos = cropShape ? geometry.space.localToScreen(cropBox.x, cropBox.y, activeFrame, cam) : { x: 0, y: 0 };

    return {
      activeLayer: activeLayerMetrics,
      mouse: {
        world: mouseW,
        physical: mouseP,
      },
      crop: {
        screen: screenCropPos,
        physical: cropBox,
      },
      camera: cam,
      canvas: {
        original: activeFrame.canvas,
        screen: {
          w: Math.round(activeFrame.canvas.w * geometry.getScale(activeFrame, cam)),
          h: Math.round(activeFrame.canvas.h * geometry.getScale(activeFrame, cam))
        }
      },
      viewport: state.ui.viewportDim,
      scale: geometry.getScale(activeFrame, cam),
      interactionMode: state.interaction.interactionMode,
    };
  }, [tick, isEnabled, activeFrame, activeLayer, geometry, state, actions.fast]);

  return {
    metrics,
    toggleCmd,
    isEnabled
  };
};
