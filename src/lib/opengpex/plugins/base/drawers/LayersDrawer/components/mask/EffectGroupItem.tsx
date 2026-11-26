/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the GNU General Public License.
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

/**
 * EffectGroupItem — the collapsed single row for a layer's effects family
 * (the MaskGroupItem sibling): a stacked-cards badge with the letter "E",
 * the family label, and the ×N count (enabled instances — the same number
 * the floating panel lists). Hovering (or tapping) the row opens the
 * floating member panel — the SAME generic MaskGroupPanel the mask families
 * use (content-agnostic chrome), filled with the effects member rows.
 *
 * The caller passes ENABLED instances only; this component adds no commands
 * and derives nothing into storage — pure display + the panel orchestration,
 * the same discipline as MaskGroupItem.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Eye } from 'lucide-react';
import type { EffectInstance } from '@opengpex/editor/core/types/models';
import { EFFECT_CATEGORY_LABELS, effectInstanceOrdinal } from '@opengpex/editor/core/layer/effects';
import { useEditorServices } from '@opengpex/editor/core/context';
// Cross-plugin invocation per the facade spec (20260628): the producing
// plugin's XxxAPI carries the registered uid; the consumer dispatches by
// `actions.executeCommand(uid)` — never a hand-typed id string.
import { EffectsDrawerAPI } from '@opengpex/editor/plugins/base/drawers/LayerEffectsDrawer/protocols';
import { MaskGroupPanel } from './MaskGroupPanel';

/** Shared 28px row geometry — mirrors the mask family rows. */
const ROW_CLASS =
  'group/effect flex items-center gap-2 px-2 py-1 rounded-md transition-all h-[28px] select-none cursor-pointer shadow-[0_1px_2px_rgba(0,0,0,0.02)] bg-[var(--bg-stage)]/30 hover:bg-[var(--bg-stage)]/60 border border-[var(--border-subtle)]/60 hover:border-[var(--border-light)]';

/** Hover-open delay before the floating panel appears (the MaskGroupItem rhythm). */
export const EFFECT_PANEL_OPEN_DELAY_MS = 120;
/** Grace period after the pointer leaves before the panel auto-closes. */
export const EFFECT_PANEL_CLOSE_DELAY_MS = 200;

export function memberLabel(instance: EffectInstance, ordinal: number): string {
  const base = EFFECT_CATEGORY_LABELS[instance.category] ?? instance.category;
  return ordinal === 1 ? base : `${base} ${ordinal}`;
}

/**
 * One effect member row, rendered both FLAT under the layer row (a family
 * with a single enabled instance) and as a member row inside the floating
 * group panel — the same dual-mount discipline as MaskItem.
 */
export function EffectMemberRow({
  layerId,
  instance,
  ordinal,
}: {
  layerId: string;
  instance: EffectInstance;
  ordinal: number;
}) {
  const { actions } = useEditorServices();

  return (
    <div
      className={ROW_CLASS}
      data-testid={`effect-row-${instance.id}`}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Family badge, letter "E" — the MaskItem member badge with the
          effects letter and the indigo family tint. */}
      <div className="w-[18px] h-[18px] rounded-sm flex items-center justify-center shrink-0 border border-indigo-500/20 bg-black text-white text-[10px] font-black tracking-tighter">
        E
      </div>
      <span
        className="text-[10px] font-bold truncate text-[var(--text-main)]"
      >
        {memberLabel(instance, ordinal)}
      </span>
      <span className="flex-1" />
      {/* Trailing hover actions — the MaskItem placement: the eye and the
          jump stay hidden until row hover, in the row's right cluster. */}
      <div className="flex items-center gap-0 opacity-0 group-hover/effect:opacity-100 transition-opacity">
        <span
          role="button"
          aria-label="Disable effect"
          title="Disable effect"
          className="p-0.5 rounded outline-none cursor-pointer"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            // Core adv command (typed namespace) — the chain toggle mutates
            // document state, so it lives with its mask siblings.
            actions.adv.layer.effect.toggle.execute({ layerId, instanceId: instance.id, enabled: false });
          }}
        >
          <Eye size={11} />
        </span>
        <span
          role="button"
          aria-label="Open in Effects drawer"
          title="Open in Effects drawer"
          className="p-0.5 rounded outline-none cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-main)]"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            // ⚠️ CROSS-PLUGIN dispatch: openEffectInstancePanel is plugin-owned UI routing
            // (cannot be an adv command) — global executor with the core
            // protocol id.
            actions.executeCommand(EffectsDrawerAPI.commands.openEffectInstancePanel.uid, { instanceId: instance.id });
          }}
        >
          <ArrowUpRight size={11} />
        </span>
      </div>
    </div>
  );
}

export function EffectGroupItem({
  layerId,
  instances,
  chain,
}: {
  layerId: string;
  instances: EffectInstance[];
  /** The layer's FULL effect chain (enabled or not) — the ordinal authority
   *  numbers within the category over ALL instances, never the enabled subset. */
  chain: EffectInstance[];
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelHovered = useRef(false);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const openPanel = useCallback(() => {
    if (!rowRef.current) return;
    setAnchorRect(rowRef.current.getBoundingClientRect());
    setOpen(true);
  }, []);

  const handlePointerEnter = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    openTimer.current = setTimeout(openPanel, EFFECT_PANEL_OPEN_DELAY_MS);
  }, [openPanel]);

  const armAutoClose = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (!open) return;
    closeTimer.current = setTimeout(() => {
      if (!panelHovered.current) setOpen(false);
    }, EFFECT_PANEL_CLOSE_DELAY_MS);
  }, [open]);

  return (
    <>
      <div
        ref={rowRef}
        data-testid="effect-family-group"
        onPointerEnter={handlePointerEnter}
        onPointerLeave={armAutoClose}
        onClick={(e) => {
          e.stopPropagation();
          if (open) {
            setOpen(false);
          } else {
            openPanel();
          }
        }}
        className={ROW_CLASS}
      >
        {/* Stacked-cards badge, letter "E" — the MaskGroupItem family badge
            with the effects letter, reading as "a stack of effects". */}
        <div className="relative w-[18px] h-[18px] shrink-0">
          <div className="absolute left-[5px] top-[5px] w-[16px] h-[16px] rounded-sm border border-white/15 bg-black" />
          <div className="absolute left-[3px] top-[3px] w-[16px] h-[16px] rounded-sm bg-white" />
          <div className="absolute left-[0px] top-[0px] w-full h-full rounded-sm flex items-center justify-center border border-white/20 bg-black text-white text-[10px] font-black tracking-tighter">
            E
          </div>
        </div>
        <span className="text-[10px] font-bold text-[var(--text-main)] shrink-0 leading-none tracking-tight">
          Effects
        </span>
        <span className="flex-1 min-w-0" />
        <span className="text-[10px] font-bold text-[var(--text-muted)] shrink-0 leading-none tracking-tight">
          {`×${instances.length}`}
        </span>
      </div>

      {open && anchorRect && (
        <MaskGroupPanel
          testId="effect-group-panel"
          anchorRect={anchorRect}
          remeasureKey={instances.length}
          onPointerEnter={() => {
            panelHovered.current = true;
          }}
          onPointerLeave={() => {
            panelHovered.current = false;
          }}
          onClose={() => setOpen(false)}
        >
          {instances.map((instance) => (
            <EffectMemberRow key={instance.id} layerId={layerId} instance={instance} ordinal={effectInstanceOrdinal(chain, instance.id)} />
          ))}
        </MaskGroupPanel>
      )}
    </>
  );
}
