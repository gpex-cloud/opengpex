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

/* eslint-disable react-hooks/set-state-in-effect */

'use client';

import { useMemo, useState, useEffect, useRef } from 'react';
import { useEditorState, useEditorServices, usePluginSelfConfig, usePluginCommands } from '@opengpex/editor/core/context';
import * as P from './protocols';
import { calculateDockPosition, calculateBranches } from './utils';
import type { TabDockCommandsMap } from './commands.d';

/**
 * useTabDock: Unified hook for bottom operation bar (State + Geometry + Commands).
 */
export const useTabDock = () => {
  const { state, activeFrame } = useEditorState();
  const { actions } = useEditorServices();
  const [selfConfig] = usePluginSelfConfig<P.TabDockConfig>();
  const { configUpdateCmd, openSettingsCmd } = usePluginCommands<TabDockCommandsMap>();

  const { frames, activeFrameId } = state;
  const config = selfConfig;

  // 1. Hover & Drag Volatile State
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isPhysicalExpanded, setIsPhysicalExpanded] = useState(false);
  const [hoveredTrunkId, setHoveredTrunkId] = useState<string | null>(null);

  const expandTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Sync expanded state with hover/drag
  useEffect(() => {
    if (isHovered || isDragging) {
      if (expandTimeoutRef.current) clearTimeout(expandTimeoutRef.current);
      setIsPhysicalExpanded(true);
    } else {
      expandTimeoutRef.current = setTimeout(() => {
        setIsPhysicalExpanded(false);
      }, 200);
    }
    return () => {
      if (expandTimeoutRef.current) clearTimeout(expandTimeoutRef.current);
    };
  }, [isHovered, isDragging]);

  // 2. DFS Tree Calculation
  const activeTrunkId = activeFrame?.parentId || activeFrame?.id;
  const trunkFrames = useMemo(() => frames.order.map(id => frames.byId[id]).filter(f => !f.parentId), [frames]);
  const branchesByParent = useMemo(() => calculateBranches(frames.order.map(id => frames.byId[id]), trunkFrames), [frames, trunkFrames]);

  // 3. Snap & Position Logic (Geometry)
  const initialPos = useMemo(() => calculateDockPosition(config), [config]);

  // 4. Semantic Action Handlers
  return useMemo(() => ({
    state: {
      config,
      isHovered,
      isDragging,
      isPhysicalExpanded,
      hoveredTrunkId,
      activeTrunkId,
      trunkFrames,
      branchesByParent,
      initialPos,
      framesCount: frames.order.length,
      activeFrameId,
      showFull: isPhysicalExpanded || isDragging || frames.order.length <= 1 || config.showProps
    },
    updateConfig: (patch: Partial<P.TabDockConfig>) => configUpdateCmd?.execute(patch),
    switchFrame: (id: string) => actions.switchFrame(id),
    removeFrame: (id: string) => actions.adv.frame.create.remove.execute(id),
    handleReorder: (newTrunkOrder: typeof trunkFrames) => {
      const nextFrames = newTrunkOrder.flatMap(root => {
        const descendants = branchesByParent[root.id] || [];
        return [root, ...descendants.map(d => d.frame)];
      });
      actions.setFrames(nextFrames);
    },
    openSettings: () => openSettingsCmd?.execute(),
    handleDockDragEnd: (rect: DOMRect, parentRect: { left: number; top: number }) => {
      setIsDragging(false);
      configUpdateCmd?.execute({ 
        position: { x: rect.left - parentRect.left, y: rect.top - parentRect.top } 
      });
    },
    setIsHovered,
    setIsDragging,
    setHoveredTrunkId,
  }), [
    actions, config, isHovered, isDragging, isPhysicalExpanded,
    hoveredTrunkId, activeTrunkId, trunkFrames, branchesByParent, initialPos,
    frames.order.length, activeFrameId, configUpdateCmd, openSettingsCmd
  ]);
};
