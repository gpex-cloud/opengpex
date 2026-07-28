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

"use client";

import React, { useState, useCallback } from "react";
import { Layers, ChevronDown, Undo2 } from "lucide-react";
import { motion } from "framer-motion";
import { useEditorState, useEditorServices } from "@opengpex/editor/core/context";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import { DISPLAY_CHANNEL_SIGNAL_KEY } from "@opengpex/editor/core/engine/protocol/DisplayTransform";
import { LayersPanel } from "./LayersPanel";
import { ChannelsPanel } from "./ChannelsPanel";

type DrawerView = 'layers' | 'channels';

/**
 * LayersComponent: View router for the LayersDrawer.
 * Switches between LayersPanel and ChannelsPanel based on user selection.
 */
export const LayersComponent = React.memo(function LayersComponent() {
  const { activeFrame, activeLayer } = useEditorState();
  const { actions } = useEditorServices();
  const [activeView, setActiveView] = useState<DrawerView>('layers');

  const handleViewSwitch = useCallback((val: string) => {
    const view = val as DrawerView;
    setActiveView(view);
    // When switching back to layers, reset channel display to RGB
    if (view === 'layers') {
      actions.setStateSignal(DISPLAY_CHANNEL_SIGNAL_KEY, 'rgb');
    }
  }, [actions]);

  if (!activeFrame) return null;

  if (activeView === 'channels') {
    return (
      <div className="flex flex-col gap-2 px-2 pt-1 pb-1 overflow-hidden">
        <motion.div layout="position" className="flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Layers size={12} className="text-indigo-600 dark:text-indigo-400" />
            <ActionDropdown
              options={[
                { value: 'layers', label: 'Layers' },
                { value: 'channels', label: 'Channels' },
              ]}
              onSelect={handleViewSwitch}
              trigger={(isOpen) => (
                <div className="flex items-center gap-1 group cursor-pointer">
                  <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-main)] group-hover transition-colors">
                    Channels
                  </span>
                  <ChevronDown
                    size={10}
                    className={`text-[var(--text-muted)] transition-transform duration-200 group-hover ${isOpen ? 'rotate-180' : ''}`}
                  />
                </div>
              )}
            />
            <ActionButton
              onClick={(e) => {
                e.stopPropagation();
                handleViewSwitch('layers');
              }}
              icon={<Undo2 size={12} />}
              tooltip="Back to Layers"
              variant="glass"
              size="sm"
              className="text-[var(--text-muted)] hover:text-emerald-500"
            />
          </div>
        </motion.div>
        <ChannelsPanel />
      </div>
    );
  }

  return (
    <LayersPanel
      activeFrame={activeFrame}
      activeLayerId={activeLayer?.id}
      activeLayerHostId={activeLayer?.hostId}
      onViewSwitch={handleViewSwitch}
    />
  );
});
