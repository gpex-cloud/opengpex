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
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use client';

import { useMemo, useState, useCallback } from 'react';
import { useEditorState, usePluginSelfConfig, usePluginCommands, usePluginList } from '@opengpex/editor/core/context';
import { useLayout } from '@opengpex/editor/workspace/LayoutContext';
import { EDITOR_Z_INDEX } from '@opengpex/editor/core/helpers/config';
import type { LayoutInfoPanelCommandsMap } from './commands.d';
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
 * RuntimeSlotGroup: a resolved slot group that may include dynamically
 * discovered slots.
 */
export interface RuntimeSlotGroup {
  id: string;
  name: string;
  icon: React.ComponentType<{ size?: number; className: string }>;
  slots: EditorSlot[];
  segmentId: string;
}

/**
 * useLayoutConfig: plugin config toggle via usePluginSelfConfig + toggleCmd.
 */
export const useLayoutConfig = () => {
  const [selfConfig] = usePluginSelfConfig<P.LayoutConfig>();
  const { toggleCmd } = usePluginCommands<LayoutInfoPanelCommandsMap>();

  return {
    isEnabled: selfConfig?.enabled === true,
    toggleCmd,
  };
};

/**
 * useLayoutInfo: aggregates the workspace layout registry, safe rectangle,
 * viewport size, slot contributions and the SEGMENT_STACK matrix view.
 *
 * Selection is imperative: `selectSlot(slot)` and `focusSegment(segmentId)`
 * write the slot tab, its group and the 3D focus in ONE state commit — there
 * are no cross-sync effects, so no echo loops and no settle timers.
 */
export const useLayoutInfo = () => {
  const { state } = useEditorState();
  const { isEnabled, toggleCmd } = useLayoutConfig();
  const pluginList = usePluginList();
  const layout = useLayout();

  // Selection state — the single source for both the 3D stack and the slots
  // explorer. Every navigation goes through selectSlot / focusSegment below.
  const [activeGroupId, setActiveGroupId] = useState<string>('');
  const [activeSlotTab, setActiveSlotTab] = useState<EditorSlot | ''>('');
  const [focusedSegment, setFocusedSegment] = useState<string | null>(null);

  // 1. Dynamically discover every unique slot name from the plugin registry.
  const discoveredSlots = useMemo(() => {
    const slotSet = new Set<EditorSlot>();

    pluginList.forEach(p => {
      if (p.slot && p.slot !== 'HIDDEN') {
        slotSet.add(p.slot);
      }
      p.contributions?.ui?.forEach(contrib => {
        if (contrib.slot && contrib.slot !== 'HIDDEN') {
          slotSet.add(contrib.slot);
        }
      });
    });

    return slotSet;
  }, [pluginList]);

  // 2. Resolved slot groups: declared groups + fallback for unknown slots.
  const resolvedSlotGroups = useMemo((): RuntimeSlotGroup[] => {
    const groups: RuntimeSlotGroup[] = P.SLOT_GROUPS.map(g => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
      slots: [...g.slots],
      segmentId: g.segmentId,
    }));

    const knownSlots = new Set<string>();
    groups.forEach(g => g.slots.forEach(s => knownSlots.add(s)));

    const unknownSlots: EditorSlot[] = [];
    discoveredSlots.forEach(slot => {
      if (!knownSlots.has(slot)) unknownSlots.push(slot);
    });

    if (unknownSlots.length > 0) {
      groups.push({
        id: P.FALLBACK_GROUP_TEMPLATE.id,
        name: P.FALLBACK_GROUP_TEMPLATE.name,
        icon: P.FALLBACK_GROUP_TEMPLATE.icon,
        slots: unknownSlots.sort(),
        segmentId: P.FALLBACK_GROUP_TEMPLATE.segmentId,
      });
    }

    return groups;
  }, [discoveredSlots]);

  // 3. Slot contribution analysis.
  const allSlots = useMemo((): EditorSlot[] => {
    const slotSet = new Set<EditorSlot>();
    resolvedSlotGroups.forEach(g => g.slots.forEach(s => slotSet.add(s)));
    discoveredSlots.forEach(s => slotSet.add(s));
    return Array.from(slotSet);
  }, [resolvedSlotGroups, discoveredSlots]);

  const slotsAnalysis = useMemo((): SlotAnalysis[] => {
    return allSlots.map(slotName => {
      const items: ContributionItem[] = [];

      pluginList.forEach(p => {
        const showPolicy = p.show ?? 'always-show';

        if (p.slot === slotName) {
          items.push({
            pluginId: p.uid,
            pluginName: p.uid.toUpperCase(),
            type: 'primary',
            order: p.order || 0,
            showPolicy,
          });
        }

        p.contributions?.ui?.forEach((contrib, idx) => {
          if (contrib.slot === slotName) {
            items.push({
              pluginId: p.uid,
              pluginName: `${p.uid.toUpperCase()} (Contrib #${idx + 1})`,
              type: 'contribution',
              order: contrib.order ?? (p.order || 0),
              showPolicy,
            });
          }
        });
      });

      items.sort((a, b) => a.order - b.order);
      return { name: slotName, items };
    });
  }, [allSlots, pluginList]);

  // 4. Effective slot→segment bindings (protocol map + dynamic fallback).
  const slotSegmentMap = useMemo((): Record<string, P.SlotSegmentBinding> => {
    const map: Record<string, P.SlotSegmentBinding> = { ...P.SLOT_SEGMENT_MAP };
    resolvedSlotGroups.forEach(group => {
      group.slots.forEach(slot => {
        if (!(slot in map)) map[slot] = { ...P.FALLBACK_SEGMENT_BINDING };
      });
    });
    return map;
  }, [resolvedSlotGroups]);

  // 5. Resolved selection values. Empty strings on first render resolve to
  //    the first available group/slot so the panel always opens consistent.
  const effectiveGroupId = useMemo(() => {
    if (activeGroupId && resolvedSlotGroups.some(g => g.id === activeGroupId)) return activeGroupId;
    return resolvedSlotGroups[0]?.id ?? '';
  }, [activeGroupId, resolvedSlotGroups]);

  const effectiveGroup = useMemo(
    () => resolvedSlotGroups.find(g => g.id === effectiveGroupId),
    [resolvedSlotGroups, effectiveGroupId],
  );

  const effectiveSlotTab = useMemo((): EditorSlot | '' => {
    if (activeSlotTab && effectiveGroup?.slots.includes(activeSlotTab)) return activeSlotTab;
    return effectiveGroup?.slots[0] ?? '';
  }, [activeSlotTab, effectiveGroup]);

  // 6. Imperative navigation — the only writers of selection state. Each
  //    commit is a single setState batch from React's perspective (called
  //    inside one event handler), so the 3D stack and the explorer can never
  //    disagree even for one frame.
  const selectSlot = useCallback((slotName: string) => {
    const parentGroup = resolvedSlotGroups.find(g => g.slots.includes(slotName as EditorSlot));
    if (!parentGroup) return;
    setActiveGroupId(parentGroup.id);
    setActiveSlotTab(slotName as EditorSlot);
    const binding = slotSegmentMap[slotName];
    setFocusedSegment(binding ? binding.segmentId : null);
  }, [resolvedSlotGroups, slotSegmentMap]);

  const focusSegment = useCallback((segmentId: string | null) => {
    setFocusedSegment(segmentId);
    if (segmentId === null) return;
    // Jump the explorer to the segment's group; prefer the group whose own
    // segment matches, else the first group bound to that segment.
    const targetGroup =
      resolvedSlotGroups.find(g => g.id === effectiveGroupId && g.segmentId === segmentId) ??
      resolvedSlotGroups.find(g => g.segmentId === segmentId);
    if (targetGroup) {
      setActiveGroupId(targetGroup.id);
      if (!targetGroup.slots.includes(activeSlotTab)) {
        setActiveSlotTab(targetGroup.slots[0]);
      }
    }
  }, [resolvedSlotGroups, effectiveGroupId, activeSlotTab]);

  // Stable identity: a fresh object literal here would defeat the memoized
  // presenter and re-render the whole 3D stack on every editor state change.
  const layoutSnapshot = useMemo(
    () => ({ registeredSlots: layout.slots, safeRect: layout.safeRect, status: layout.status }),
    [layout.slots, layout.safeRect, layout.status],
  );

  return {
    isEnabled,
    toggleCmd,
    layout: layoutSnapshot,
    viewportDim: state.ui.viewportDim,
    slotsAnalysis,
    slotGroups: resolvedSlotGroups,
    segmentStack: P.SEGMENT_STACK,
    slotSegmentMap,
    // Selection
    activeGroupId: effectiveGroupId,
    activeSlotTab: effectiveSlotTab,
    focusedSegment,
    selectSlot,
    focusSegment,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Runtime Z Audit
// ─────────────────────────────────────────────────────────────────────────────

export interface ZAuditEntry {
  /** Effective z-index value */
  z: number;
  /** Segment whose [base, base+1000) span contains z; null = out-of-segment */
  segmentId: string | null;
  /** Named seat whose constant equals z exactly; null = unmapped value */
  seatLabel: string | null;
  /** How many elements carry this value */
  count: number;
  /** Up to 3 element descriptions (tag + id + first class names) */
  samples: string[];
}

export interface ZAuditResult {
  scannedAt: number;
  elementTotal: number;
  /** All entries, ascending by z */
  entries: ZAuditEntry[];
  /** Subset with segmentId === null — the runtime leak probe */
  outOfSegment: ZAuditEntry[];
  /** True when the element budget was exhausted before the DOM was done */
  truncated: boolean;
}

/** Named seats flattened once: seatLabel → value, for exact-match lookup. */
const SEAT_INDEX: Array<{ label: string; value: number }> = (() => {
  const index: Array<{ label: string; value: number }> = [];
  const groups = EDITOR_Z_INDEX as unknown as Record<string, Record<string, number>>;
  for (const [group, seats] of Object.entries(groups)) {
    for (const [seat, value] of Object.entries(seats)) {
      if (typeof value === 'number') index.push({ label: `${group}.${seat} ${value}`, value });
    }
  }
  return index.sort((a, b) => a.value - b.value);
})();

/** Element budget: one-shot scan stays O(n) with a hard ceiling. */
const AUDIT_ELEMENT_BUDGET = 20000;
const SAMPLE_LIMIT = 3;

/** Short human-readable description of an element for sample lists. */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  return `${tag}${id}${cls ? `.${cls}` : ''}`;
}

/**
 * useRuntimeZAudit: on-demand DOM scan listing every effective z-index,
 * classified into the segment matrix. Complements the static source guard:
 * the guard pins src/ literals, this pins whatever actually reached the DOM
 * (third-party plugins, dynamic styles, portals).
 */
export const useRuntimeZAudit = () => {
  const [result, setResult] = useState<ZAuditResult | null>(null);
  const [scanning, setScanning] = useState(false);

  const scan = useCallback(() => {
    setScanning(true);
    // Deferred one frame so the scanning state paints before the sync walk.
    requestAnimationFrame(() => {
      const buckets = new Map<number, { count: number; samples: string[] }>();
      const all = document.body.querySelectorAll('*');
      const total = all.length;
      const truncated = total > AUDIT_ELEMENT_BUDGET;
      const bound = Math.min(total, AUDIT_ELEMENT_BUDGET);

      for (let i = 0; i < bound; i++) {
        const el = all[i];
        const style = window.getComputedStyle(el);
        const raw = style.zIndex;
        if (raw === 'auto') continue;
        const z = parseInt(raw, 10);
        if (Number.isNaN(z)) continue;
        const bucket = buckets.get(z);
        if (bucket) {
          bucket.count += 1;
          if (bucket.samples.length < SAMPLE_LIMIT && style.position !== 'static') {
            const description = describeElement(el);
            if (!bucket.samples.includes(description)) bucket.samples.push(description);
          }
        } else {
          const samples = style.position !== 'static' ? [describeElement(el)] : [];
          buckets.set(z, { count: 1, samples });
        }
      }

      const entries: ZAuditEntry[] = [...buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([z, bucket]) => {
          const segment = P.SEGMENT_STACK.find(s => z >= s.base && z < s.base + 1000);
          const seat = SEAT_INDEX.find(s => s.value === z);
          return {
            z,
            segmentId: segment ? segment.id : null,
            seatLabel: seat ? seat.label : null,
            count: bucket.count,
            samples: bucket.samples,
          };
        });

      setResult({
        scannedAt: Date.now(),
        elementTotal: total,
        entries,
        outOfSegment: entries.filter(e => e.segmentId === null),
        truncated,
      });
      setScanning(false);
    });
  }, []);

  return { result, scanning, scan };
};
