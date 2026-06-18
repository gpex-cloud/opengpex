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

import { useMemo } from 'react';
import { useEditorState, usePluginSelfConfig, usePluginCommands, usePluginList } from '@opengpex/editor/core/context';
import { useLayout } from '@opengpex/editor/workspace/LayoutContext';
import * as P from './protocols';
import type { EditorSlot } from '@opengpex/editor/core/types';

export interface ContributionItem {
  pluginId: string;
  pluginName: string;
  type: 'primary' | 'contribution';
  order: number;
  showPolicy: string;
}

export interface SlotAnalysis {
  name: EditorSlot;
  items: ContributionItem[];
}

/**
 * RuntimeSlotGroup: A resolved slot group that may include dynamically discovered slots.
 */
export interface RuntimeSlotGroup {
  id: string;
  name: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  slots: EditorSlot[];
  layerId: string;
}

/**
 * useLayoutConfig: Gets plugin config toggle status via usePluginSelfConfig, and exposes toggleCmd
 */
export const useLayoutConfig = () => {
  const [selfConfig] = usePluginSelfConfig<P.LayoutConfig>();
  const { toggleCmd } = usePluginCommands();

  return {
    isEnabled: selfConfig?.enabled === true,
    toggleCmd,
  };
};

/**
 * useLayoutInfo: Aggregates real-time workspace layout registry data, safe rectangle boundaries,
 * ResizeObserver-measured dimensions, and maps all system plugin slot contributions.
 * 
 * Key improvement: Slots are now dynamically discovered from the plugin registry rather than
 * being hardcoded. If new slots are added by community/user plugins, they will automatically
 * appear in the inspector.
 */
export const useLayoutInfo = () => {
  const { state } = useEditorState();
  const { isEnabled, toggleCmd } = useLayoutConfig();
  const pluginList = usePluginList();

  const layout = useLayout();

  // 1. Dynamically discover all unique slot names from the plugin registry
  const discoveredSlots = useMemo(() => {
    const slotSet = new Set<EditorSlot>();

    pluginList.forEach(p => {
      if (p.slot && p.slot !== 'HIDDEN') {
        slotSet.add(p.slot);
      }
      // Also collect slots from contributions
      p.contributions?.forEach(contrib => {
        if (contrib.slot && contrib.slot !== 'HIDDEN') {
          slotSet.add(contrib.slot);
        }
      });
    });

    return slotSet;
  }, [pluginList]);

  // 2. Build resolved slot groups: known groups + fallback for unknown slots
  const resolvedSlotGroups = useMemo((): RuntimeSlotGroup[] => {
    // Start with the declared groups from protocols
    const groups: RuntimeSlotGroup[] = P.SLOT_GROUPS.map(g => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
      slots: [...g.slots],
      layerId: g.layerId,
    }));

    // Collect all known slots from declared groups
    const knownSlots = new Set<string>();
    groups.forEach(g => g.slots.forEach(s => knownSlots.add(s)));

    // Find dynamically discovered slots that don't belong to any known group
    const unknownSlots: EditorSlot[] = [];
    discoveredSlots.forEach(slot => {
      if (!knownSlots.has(slot)) {
        unknownSlots.push(slot);
      }
    });

    // If there are unknown slots, create a fallback "Extensions" group
    if (unknownSlots.length > 0) {
      groups.push({
        id: P.FALLBACK_GROUP_TEMPLATE.id,
        name: P.FALLBACK_GROUP_TEMPLATE.name,
        icon: P.FALLBACK_GROUP_TEMPLATE.icon,
        slots: unknownSlots.sort(),
        layerId: P.FALLBACK_GROUP_TEMPLATE.layerId,
      });
    }

    return groups;
  }, [discoveredSlots]);

  // 3. Build the complete slot list for analysis (union of known + discovered)
  const allSlots = useMemo((): EditorSlot[] => {
    const slotSet = new Set<EditorSlot>();
    // Include all slots from resolved groups
    resolvedSlotGroups.forEach(g => g.slots.forEach(s => slotSet.add(s)));
    // Also include any discovered slots (should already be covered, but safety net)
    discoveredSlots.forEach(s => slotSet.add(s));
    return Array.from(slotSet);
  }, [resolvedSlotGroups, discoveredSlots]);

  // 4. Accumulate slot components and contributions programmatically from plugin registry
  const slotsAnalysis = useMemo((): SlotAnalysis[] => {
    return allSlots.map(slotName => {
      const items: ContributionItem[] = [];

      pluginList.forEach(p => {
        const showPolicy = p.show ?? 'always-show';

        // 1. Primary Components
        if (p.slot === slotName) {
          items.push({
            pluginId: p.uid,
            pluginName: p.uid.toUpperCase(),
            type: 'primary',
            order: p.order || 0,
            showPolicy
          });
        }

        // 2. Extra Visual Contributions
        p.contributions?.forEach((contrib, idx) => {
          if (contrib.slot === slotName) {
            items.push({
              pluginId: p.uid,
              pluginName: `${p.uid.toUpperCase()} (Contrib #${idx + 1})`,
              type: 'contribution',
              order: contrib.order ?? (p.order || 0),
              showPolicy
            });
          }
        });
      });

      // Sort contributions strictly based on layout rendering sequence index
      items.sort((a, b) => a.order - b.order);

      return {
        name: slotName,
        items
      };
    });
  }, [allSlots, pluginList]);

  // 5. Build runtime slot-to-layer map (extends protocol defaults with dynamic slots)
  const slotToLayerMap = useMemo((): Record<string, string | null> => {
    const map: Record<string, string | null> = { ...P.SLOT_TO_LAYER_MAP };
    // For any dynamic slots not in the protocol map, assign based on their group's layerId
    resolvedSlotGroups.forEach(group => {
      group.slots.forEach(slot => {
        if (!(slot in map)) {
          map[slot] = group.layerId;
        }
      });
    });
    return map;
  }, [resolvedSlotGroups]);

  // 6. Build runtime layer-to-default-slot map (extends protocol defaults with dynamic slots)
  const layerToDefaultSlot = useMemo((): Record<string, string> => {
    const map: Record<string, string> = { ...P.LAYER_TO_DEFAULT_SLOT };
    // For any layers that have new dynamic slots, ensure there's a default
    resolvedSlotGroups.forEach(group => {
      if (group.slots.length > 0 && !map[group.layerId]) {
        map[group.layerId] = group.slots[0];
      }
    });
    return map;
  }, [resolvedSlotGroups]);

  return {
    isEnabled,
    toggleCmd,
    layout: {
      registeredSlots: layout.slots,
      safeRect: layout.safeRect,
      status: layout.status
    },
    viewportDim: state.ui.viewportDim,
    slotsAnalysis,
    // New dynamic data for components to consume
    slotGroups: resolvedSlotGroups,
    layerStack: P.LAYER_STACK,
    slotToLayerMap,
    layerToDefaultSlot,
  };
};
