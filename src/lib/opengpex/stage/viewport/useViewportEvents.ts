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

import React, { useRef, useCallback, useMemo } from 'react';
import { useEditorState, useEditorServices, usePluginList } from '@opengpex/editor/core/context';
import { Frame, Layer, InteractionEvent, asViewportPoint } from '@opengpex/editor/core/types';
import { InteractionDispatcher } from '../interaction/Dispatcher';
import { createViewportPanHandler } from '../interaction/handlers/ViewportPanHandler';
import { createLayerMoveHandler } from '../interaction/handlers/LayerMoveHandler';
import { useViewportScroll } from './useViewportScroll';

/**
 * useViewportEvents: Hook for viewport interaction event handler
 * Acts as shell of Interaction Dispatcher, no longer containing concrete business logic.
 */
export function useViewportEvents(
  containerRef: React.RefObject<HTMLDivElement | null>,
  frame: Frame
) {
  const { state, activeLayer } = useEditorState();
  const services = useEditorServices();
  const { geometry, actions } = services;
  const pluginList = usePluginList();

  // 1. Initialize dispatcher and handlers (automatically aggregate built-in and plugin handlers)
  const dispatcher = useMemo(() => {
    // Collect all handlers provided by plugins (reactively updated)
    const pluginInteractions = pluginList.flatMap(p => p.interactions || []);

    return new InteractionDispatcher([
      ...pluginInteractions,
      createLayerMoveHandler(),
      createViewportPanHandler()
    ]);
  }, [pluginList]);

  // 2. Helper function to construct InteractionEvent
  const buildInteractionEvent = useCallback((e: React.MouseEvent | MouseEvent): InteractionEvent => {
    const rect = containerRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
    const screenPoint = asViewportPoint({ x: e.clientX - rect.left, y: e.clientY - rect.top });

    const currentCam = actions.fast.latestCamera(frame.id);
    const worldPoint = geometry.space.screenToWorld(screenPoint.x, screenPoint.y, frame, currentCam);
    const canvasPoint = geometry.space.worldToLocal(worldPoint.x, worldPoint.y, frame);

    return {
      nativeEvent: e,
      point: {
        screen: screenPoint,
        world: worldPoint,
        canvas: canvasPoint,
      },
      keys: {
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey || e.ctrlKey,
      },
      geometry,
      actions,
      state,
      activeFrame: frame,
    };
  }, [containerRef, frame, geometry, actions, state]);

  const lastEventRef = useRef<React.MouseEvent | MouseEvent | null>(null);

  // --- Mouse Down: Start dispatcher ---
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    lastEventRef.current = e;
    const event = buildInteractionEvent(e);
    dispatcher.handleStart(event);
  }, [buildInteractionEvent, dispatcher]);

  // --- Mouse Move: Handle interaction or hover state ---
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    lastEventRef.current = e;
    const event = buildInteractionEvent(e);

    if (dispatcher.isActive()) {
      dispatcher.handleMove(event);
    } else {
      // Basic hover determination logic (temporarily kept in Viewport layer, can be moved to plugins in the future)
      const layersAtPoint = geometry.space.pickLayersAt(event.point.world, frame.layers);
      const hoveredId = layersAtPoint[0]?.id || null;

      if (state.interaction.hoveredLayerId !== hoveredId) {
        actions.setInteraction({ hoveredLayerId: hoveredId });
      }

      const isHoveringActive = activeLayer ? layersAtPoint.some((l: Layer) => l.id === activeLayer.id) : false;
      if (state.interaction.isHoveringActiveLayer !== isHoveringActive) {
        actions.setInteraction({ isHoveringActiveLayer: isHoveringActive });
      }
    }
  }, [buildInteractionEvent, dispatcher, geometry, frame.layers, state.interaction.hoveredLayerId, state.interaction.isHoveringActiveLayer, activeLayer, actions]);

  // --- Mouse Up: End dispatch and reset fast-track ---
  const handleMouseUp = useCallback(() => {
    let endResult: unknown = undefined;
    if (lastEventRef.current) {
      const event = buildInteractionEvent(lastEventRef.current);
      endResult = dispatcher.handleEnd(event);
    }
    // Only reset if an interaction is still hanging (was not committed by handleEnd)
    // and it did not return a Promise indicating an asynchronous commit.
    const isAsyncCommit = !!(endResult && typeof (endResult as { then?: unknown }).then === 'function');
    if (!isAsyncCommit && actions.fast.isInteracting()) {
      actions.fast.reset();
    }
    lastEventRef.current = null;
  }, [buildInteractionEvent, dispatcher, actions]);

  const handleMouseLeave = useCallback(() => {
    handleMouseUp();
    actions.setInteraction({ hoveredLayerId: null, isHoveringActiveLayer: false });
  }, [handleMouseUp, actions]);

  // --- Wheel Interaction: zoom and canvas panning (taken over by independent Hook) ---
  useViewportScroll(containerRef, frame, actions, geometry);

  return {
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave
  };
}
