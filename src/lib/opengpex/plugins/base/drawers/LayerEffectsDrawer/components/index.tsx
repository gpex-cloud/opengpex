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

/**
 * LayerEffectsDrawerComponent (A8 P3) — the vertical-tab drawer.
 *
 * TAB MODEL (user rulings 20261125 + 20261126; entry-write ruling
 * 20261127): the rail ALWAYS renders all shipped PS categories (the
 * family's final shape stays visible; unimplemented ones are empty
 * placeholder tabs exactly like Shadow before P5), and the header dropdown
 * is the SAME data's second entry point — both stay. Each AVAILABLE
 * category resolves to:
 *
 *   • zero instances → one placeholder VIRTUAL tab. OPENING it writes
 *     NOTHING (the retired lazy-floor auto-materialization was the original
 *     sin: an undoable write per drawer open — a meaningless Undo step and
 *     a ⌘Z fight). The eye on it creates the instance enabled (PS checkbox
 *     semantics); the FIRST parameter edit lands a DISABLED carrier with
 *     the edited values (editing must not switch the effect on);
 *   • n instances → n tabs in chain order — enabled AND disabled (a
 *     disabled instance is the OFF tab carrying its edited parameters),
 *     ordinally labelled ("Stroke", "Stroke 2").
 *
 * The eye is a pure enabled-flag flip (params survive the toggle); deletion
 * is the trash's job and is unconditional (a category may empty back to its
 * placeholder). The header "+" inserts a new same-category instance beneath
 * the active tab (chain order = tab order).
 *
 * Parameter rows run the Q4 fast channel (identical to the adjustments
 * sliders): one undoable checkpoint on pointerdown, volatile-buffer writes
 * during the drag, ONE Redux write on pointerup = exactly one Undo step.
 * The per-category panels live under components/panels/ (one file per
 * available category); this file owns only the drawer shell (rail model,
 * tab resolution, header, panel routing).
 */

import React, { useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Eye, EyeOff, Plus, RotateCcw as ResetIcon, Trash2 } from "lucide-react";
import { EfxIcon } from "../icon";
import { useEditorState, useEditorServices, usePluginCommands, usePluginSignals } from "@opengpex/editor/core/context";
import { DrawerHeader } from "@opengpex/editor/workspace/components/DrawerHeader";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import VerticalTabs, { type VerticalTabItem } from "@opengpex/editor/widgets/VerticalTabs";
import { ChevronDown } from "lucide-react";
import SplitButton from "@opengpex/editor/widgets/SplitButton";
import type { EffectCategory, EffectInstance } from "@opengpex/editor/core/types/models";
import {
  appendEffectInstance,
  defaultParamsFor,
  disableAllEffectInstances,
  updateEffectParams,
  effectInstanceOrdinal,
  getEffectChain,
  newEffectInstanceId,
} from "@opengpex/editor/core/layer/effects";
import type { LayerEffectsDrawerCommandsMap, LayerEffectsDrawerSignalsMap } from "../commands.d";
import { StrokePanel } from "./panels/StrokePanel";
import { ShadowPanel } from "./panels/ShadowPanel";
import { ColorOverlayPanel } from "./panels/ColorOverlayPanel";
import { OuterGlowPanel } from "./panels/OuterGlowPanel";
import { GradientOverlayPanel } from "./panels/GradientOverlayPanel";
import { InnerGlowPanel } from "./panels/InnerGlowPanel";
import { InnerShadowPanel } from "./panels/InnerShadowPanel";
import { EmptyCategoryPanel } from "./panels/shared";
import {
  ADDABLE_CATEGORIES,
  EFFECT_CATEGORY_LABELS,
  EFFECT_TABS,
  isVirtualTabId,
  virtualTabCategory,
  virtualTabId,
  type EffectTabDef,
  type EffectTabId,
} from "../protocols";

/**
 * The panel body's DEFAULT height: sized to fit the full 10-category rail
 * without scrolling — 10 tabs × ~24px rows + 3px gaps + container padding
 * ≈ 271px, rounded up to 280 for breathing room. Sparse parameter rows keep
 * this height; content taller than it grows the panel naturally (no max —
 * auto-expand, never scroll). User ruling 20261125 (240px baseline superseded
 * by the fit-all-tabs requirement).
 */
const PANEL_MIN_HEIGHT_PX = 320;

// ─── Tab model ────────────────────────────────────────────────────────────────

interface RailTab {
  /** Instance id, or a `virtual:<category>` id for the zero-instance state. */
  readonly id: string;
  readonly label: string;
  readonly category: EffectTabCategory;
  readonly available: boolean;
  /** The chain instance this tab drives (null = virtual / placeholder). */
  readonly instance: EffectInstance | null;
}

type EffectTabCategory = EffectTabId | (string & {});

/** Ordinal label ("Stroke", "Stroke 2", …) — core's single numbering authority. */
function categoryLabel(base: string, chain: readonly EffectInstance[], instanceId: string): string {
  const ordinal = effectInstanceOrdinal(chain, instanceId);
  return ordinal === 1 ? base : `${base} ${ordinal}`;
}

/**
 * Build the rail: every listed category (shipped ones only — see EFFECT_TABS)
 * contributes max(1, instances) tabs at its list position (the first anchors
 * the category slot, extras follow); a category with no instance on this
 * layer contributes one virtual tab (eye click creates the first instance).
 */
function buildRail(chain: readonly EffectInstance[]): RailTab[] {
  const tabs: RailTab[] = [];
  for (const def of EFFECT_TABS as readonly EffectTabDef[]) {
    if (!def.available) {
      tabs.push({ id: def.id, label: def.label, category: def.id, available: false, instance: null });
      continue;
    }
    const instances = chain.filter((i) => i.category === def.id);
    if (instances.length === 0) {
      tabs.push({ id: virtualTabId(def.id as EffectTabId), label: def.label, category: def.id, available: true, instance: null });
      continue;
    }
    instances.forEach((instance) => {
      tabs.push({
        id: instance.id,
        label: categoryLabel(def.label, chain, instance.id),
        category: def.id,
        available: true,
        instance,
      });
    });
  }
  return tabs;
}

// ─── Parameter panels ────────────────────────────────────────────────────────
// One panel file per available category under components/panels/ (StrokePanel
// now; ShadowPanel joins at P5). The shell routes by category with a plain
// switch — deliberately NOT a registry (the A8 architecture rollback lesson:
// core-direct until a real second axis of variation demands more).

// ─── LayerEffectsDrawerComponent ─────────────────────────────────────────────

export const LayerEffectsDrawerComponent = React.memo(function LayerEffectsDrawerComponent() {
  const { activeLayer } = useEditorState();
  const { actions } = useEditorServices();
  const {
    applyEffectPatchCmd,
    removeEffectInstanceCmd,
  } = usePluginCommands<LayerEffectsDrawerCommandsMap>();
  const { activeEffectInstanceSignal } = usePluginSignals<LayerEffectsDrawerSignalsMap>();
  // P4 jump channel payload ({ instanceId, nonce }) set by effectsOpenAtCmd
  // (the layers-drawer family row's ⤴ button).
  const jump = activeEffectInstanceSignal?.value as { readonly instanceId: string; readonly nonce: number } | null | undefined;
  const jumpNonce = jump?.nonce ?? 0;

  const chain = useMemo(
    () => (activeLayer ? getEffectChain(activeLayer) : []),
    [activeLayer],
  );
  const rail = useMemo(() => buildRail(chain), [chain]);

  // Active-tab resolution, fully render-derived (no effects, no
  // set-state-in-effect), three inputs in priority order:
  //   1. the user's manual tab click — recorded as an override STAMPED WITH
  //      the jump nonce it superseded, so a FRESH jump (new nonce) invalidates
  //      it and the signal wins again;
  //   2. a jump signal whose instance still exists on the rail;
  //   3. the layer-switch default (chain mutations / layer switches fall back
  //      here): the first ENABLED instance's tab — the panel follows what is
  //      actually rendering on the newly-selected layer; when NOTHING is
  //      enabled, the first AVAILABLE category's tab (stroke).
  const [override, setOverride] = useState<{
    layerId: string;
    id: string;
    category: string;
    nonce: number;
  } | null>(null);
  const selectTab = (id: string, category?: string) => {
    if (!activeLayer) return;
    const resolvedCategory =
      category ??
      (isVirtualTabId(id)
        ? virtualTabCategory(id)
        : rail.find((t) => t.id === id)?.category ?? activeCategory);
    setOverride({ layerId: activeLayer.id, id, category: resolvedCategory, nonce: jumpNonce });
  };
  // Resolve the user's manual override when it belongs to the active layer and
  // hasn't been superseded by a newer jump signal:
  //   1. Exact tab id match (normal selection, or multi-instance selection);
  //   2. Same-category fallback when the exact id disappears — covers both a
  //      placeholder (`virtual:<cat>`) materializing into a real instance on
  //      first parameter edit, and deleting/undoing an instance back to its
  //      sibling or placeholder without snapping back to Stroke.
  const overrideTab =
    override && activeLayer && override.layerId === activeLayer.id && override.nonce === jumpNonce
      ? (rail.find((t) => t.id === override.id) ??
         rail.find((t) => t.category === override.category) ??
         null)
      : null;
  const signalTab = jump && rail.some((t) => t.id === jump.instanceId)
    ? jump.instanceId
    : null;
  const firstAvailableTabId = rail.find((t) => t.available)?.id ?? rail[0]?.id ?? "";
  const defaultTabId =
    rail.find((t) => t.instance?.enabled)?.id ?? firstAvailableTabId;
  // Placeholder tab → pre-generated STABLE carrier id, lazily registered
  // per (layer, category) in a ref map so React keys and the fast-drag
  // channel stay stable across the virtual → materialized transition.
  const pendingIdsRef = useRef<Map<string, string>>(new Map());
  const pendingIdFor = (layerId: string, category: string): string => {
    const k = `${layerId}:${category}`;
    let id = pendingIdsRef.current.get(k);
    if (!id) {
      id = newEffectInstanceId();
      pendingIdsRef.current.set(k, id);
    }
    return id;
  };
  const resolvedActiveId = overrideTab
    ? overrideTab.id
    : signalTab ?? defaultTabId;
  const activeRailTab = rail.find((t) => t.id === resolvedActiveId) ?? null;
  const activeCategory = activeRailTab?.category ?? "stroke";
  const canAdd = !!activeLayer
    && activeRailTab?.available === true
    && (ADDABLE_CATEGORIES as readonly string[]).includes(activeCategory);

  // NO ENTRY WRITE (20261127 ruling): opening a category's panel — or the
  // drawer itself — must never write the layer. The retired lazy-floor
  // auto-materialization spent an Undo step per drawer open and fought ⌘Z
  // (its undoable patch was the step ⌘Z consumed, and the ensure effect
  // re-materialized what ⌘Z removed). Instances exist only after an
  // explicit user act: the eye (enable with defaults) or a parameter edit
  // (disabled carrier — see handlePanelEdit below).

  // The EYE is the on/off switch: a real instance flips `enabled` (params
  // survive the toggle). On the untouched zero-instance tab it CREATES the
  // instance enabled — one click lands a visibly-on effect, the PS checkbox
  // semantics (§5.2).
  const handleEye = (railTab: RailTab) => {
    if (!activeLayer || !applyEffectPatchCmd) return;
    if (railTab.instance) {
      // Core adv command (typed namespace) — the chain toggle mutates
      // document state, so it lives with its mask siblings.
      actions.adv.layer.effect.toggle.execute({
        layerId: activeLayer.id,
        instanceId: railTab.instance.id,
        enabled: !railTab.instance.enabled,
      });
      return;
    }
    if (!isVirtualTabId(railTab.id)) return;
    const id = newEffectInstanceId();
    // The eye on a virtual floor is an explicit ON request — land the
    // instance enabled (PS checkbox semantics).
    const patch = appendEffectInstance(activeLayer, virtualTabCategory(railTab.id), { id, enabled: true });
    applyEffectPatchCmd.execute({ patch });
    selectTab(id, railTab.category);
  };

  // ─── First-interaction materialization (20261127 ruling) ─────────────────
  // A placeholder tab renders the FULL parameter panel against factory
  // defaults (so an OFF effect can be configured before it is switched on),
  // but nothing exists in the chain yet. Materialization happens INSIDE the
  // first parameter write — NOT on pointerdown (an entry-time write was its
  // own undo step, the exact "meaningless undo" this model removes): the
  // panels write through the commands' UPSERT channel (upsertEffectParams),
  // which lands the DISABLED carrier with the edited values under this
  // pre-generated STABLE id (declared above the tab resolution — the
  // pending-tab carry reads it), so "instance + first parameters" hit
  // history as the gesture's ONE undo step. Opening the panel alone writes
  // nothing.

  const tabs: VerticalTabItem[] = useMemo(() => {
    return rail.map((railTab) => {
      // Presence of the delete affordance: a real instance is deletable
      // outright (deletion is unconditional — a category may empty back to
      // its placeholder tab); a placeholder tab has nothing to delete, so
      // its trash renders dimmed (the button ROW stays aligned across every
      // tab — user ruling 20261126).
      const enabled = railTab.instance ? railTab.instance.enabled : false;
      const eyeVisible = railTab.available;
      return {
        id: railTab.id,
        label: railTab.label,
        indicatorClassName: eyeVisible
          ? (enabled ? "bg-cyan-500 dark:bg-cyan-400" : "bg-red-500 dark:bg-red-400")
          : undefined,
        trailing: !eyeVisible ? undefined : (
          <span className="flex items-center gap-0.5">
            {/* ⚠️ span[role=button], NOT <button>: the VerticalTabs tab body
                renders as <button role="tab">, and HTML forbids nested buttons
                (React hydration error — observed on the first real-device
                run). The floor state uses aria-disabled + a guard instead of
                the disabled attribute (spans have none). */}
            <span
              role="button"
              aria-label={railTab.instance
                ? (enabled ? "Disable effect" : "Enable effect")
                : "Enable effect (creates it with defaults)"}
              title={railTab.instance
                ? (enabled ? "Disable effect" : "Enable effect")
                : "Enable effect (creates it with defaults)"}
              className={`p-0.5 rounded outline-none cursor-pointer ${enabled
                ? "text-cyan-500 dark:text-cyan-400 hover:text-cyan-600 dark:hover:text-cyan-300"
                : "text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300"}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                handleEye(railTab);
              }}
            >
              {enabled ? <Eye size={9} /> : <EyeOff size={9} />}
            </span>
            {(
              <span
                role="button"
                aria-label={railTab.instance
                  ? "Delete instance"
                  : "Nothing added yet on this layer"}
                aria-disabled={!railTab.instance}
                title={railTab.instance
                  ? "Delete instance"
                  : "Nothing added yet on this layer"}
                className={`p-0.5 rounded outline-none ${railTab.instance
                  ? "hover:text-red-500 text-[var(--text-muted)] cursor-pointer"
                  : "opacity-30 cursor-not-allowed"}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!railTab.instance) return;
                  removeEffectInstanceCmd?.execute({ instanceId: railTab.instance.id });
                }}
              >
                <Trash2 size={9} />
              </span>
            )}
          </span>
        ),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rail, activeLayer, actions, removeEffectInstanceCmd]);

  const isDisabled = !activeLayer;

  return (
    <div className="flex flex-col gap-1 pt-1 pb-1">
      <div className="px-2">
        <DrawerHeader
          icon={<EfxIcon size={12} className="text-indigo-600 dark:text-indigo-400" />}
          title={
            // "Effects <dropdown>" — fixed product label + category picker; the
            // dropdown and the tab rail are the SAME data's two entry points
            // (user ruling 20261125: neither may be removed).
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)]">
                Effects
              </span>
              <ActionDropdown
                closeOnMouseLeave
                // The dropdown lists the RAIL'S OWN TABS — same data, same
                // entry-point contract, and the same per-instance ordinal
                // names ("Stroke", "Stroke 2", …) instead of bare category
                // labels. A per-INSTANCE eye (not per-category): the eye's
                // colour is exactly that instance's on/off state.
                options={rail.map((rt) => {
                  const eye = rt.instance?.enabled
                    ? <Eye size={10} className="text-cyan-500 dark:text-cyan-400" />
                    : <EyeOff
                        size={10}
                        className={rt.instance
                          ? "text-red-500 dark:text-red-400"
                          : "text-[var(--text-muted)] opacity-50"}
                      />;
                  return {
                    value: rt.id,
                    label: rt.label,
                    trailing: <span className="mr-0.5">{eye}</span>,
                  };
                })}
                onSelect={(value) => {
                  // Activate that rail tab directly (instance id or the
                  // virtual category floor — the rail id IS the target).
                  selectTab(value);
                }}
                trigger={(isOpen) => {
                  // The closed trigger names the ACTIVE rail tab (its
                  // instance ordinal name, or the category for a placeholder)
                  // with that tab's own status eye (display-only).
                  const activeHasOn = !!activeRailTab?.instance?.enabled;
                  const activeHasAny = !!activeRailTab?.instance;
                  return (
                    <div className="flex items-center gap-1 group cursor-pointer" title="Switch effect instance">
                      <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-main)]">
                        {activeRailTab?.label
                          ?? EFFECT_CATEGORY_LABELS[activeCategory]
                          ?? activeCategory}
                      </span>
                      {activeHasOn
                        ? <Eye size={10} className="text-cyan-500 dark:text-cyan-400" />
                        : <EyeOff
                            size={10}
                            className={activeHasAny
                              ? "text-red-500 dark:text-red-400"
                              : "text-[var(--text-muted)] opacity-50"}
                          />}
                      <ChevronDown
                        size={10}
                        className={`text-[var(--text-muted)] transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                      />
                    </div>
                  );
                }}
              />
            </div>
          }
          actions={
            <>
            {/* AdjustmentDrawer reset-SplitButton precedent: the "+" is the
                primary action (add an instance beneath the active tab); the
                split menu carries the two maintenance actions — disable-all
                (layer-scoped, one patch) and per-instance factory reset. */}
            <SplitButton
              icon={<Plus size={12} />}
              // The drawer hugs the window edge: a centered tooltip overflows
              // and clips — anchor it to the LEFT of the button instead.
              tooltipPosition="left"
              tooltip={canAdd
                ? `Add ${EFFECT_CATEGORY_LABELS[activeCategory] ?? activeCategory} instance`
                : undefined}
              disabled={!activeLayer}
              primaryDisabled={!canAdd}
              onClick={() => {
                if (!activeLayer || !applyEffectPatchCmd || !canAdd) return;
                const id = newEffectInstanceId();
                const patch = appendEffectInstance(activeLayer, activeCategory as EffectCategory, { afterId: activeRailTab?.instance?.id, id });
                applyEffectPatchCmd.execute({ patch });
                selectTab(id, activeCategory);
              }}
              dropdownOptions={[
                { label: "Disable all effects", value: 'disable-all', icon: <EyeOff size={10} />, variant: 'danger' },
                { label: "Reset to defaults", value: 'reset-defaults', icon: <ResetIcon size={10} /> },
              ]}
              onDropdownSelect={(value) => {
                if (!activeLayer || !applyEffectPatchCmd) return;
                if (value === 'disable-all') {
                  const patch = disableAllEffectInstances(activeLayer);
                  if (patch) applyEffectPatchCmd.execute({ patch });
                  return;
                }
                if (value === 'reset-defaults') {
                  if (!activeRailTab?.instance) return;
                  const patch = updateEffectParams(
                    activeLayer,
                    activeRailTab.instance.id,
                    defaultParamsFor(activeCategory as EffectCategory),
                  );
                  if (patch) applyEffectPatchCmd.execute({ patch });
                }
              }}
            />
</>
          }
          actionsClassName="gap-1"
        />
      </div>

      {isDisabled ? (
        <motion.div
          layout="position"
          className="mx-2 flex flex-col bg-[var(--bg-stage)] p-4 rounded-xl border border-[var(--border-subtle)] items-center justify-center py-8 text-center gap-2"
        >
          <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest">
            No Layer Selected
          </span>
          <span className="text-[9px] text-[var(--text-muted)] tracking-tight">
            Select a layer to edit its effects.
          </span>
        </motion.div>
      ) : (
        <motion.div layout="position" className="flex flex-col">
          {/* spineOffsetPx=-3 aligns the tab spine flush against DrawerBar's
              outer left edge (2px sidebarInner paddingLeft + 1px border). */}
          <VerticalTabs
            items={tabs}
            activeId={resolvedActiveId}
            spineOffsetPx={-3}
            onSelect={(id) => selectTab(id)}
          >
            {/* Default panel height (P1 baseline); auto-expand when content
                exceeds it — never scroll (user ruling 20261125). The wrapper
                owns the first-interaction materialization (capture phase —
                ahead of any slider gesture inside the panel). */}
            <div
              className="flex flex-col"
              style={{ minHeight: PANEL_MIN_HEIGHT_PX }}
            >
              {(() => {
                // A placeholder (zero-instance) AVAILABLE tab renders the
                // FULL panel against factory defaults under a pre-generated
                // stable id — the first parameter write lands the DISABLED
                // carrier with that id through the commands' UPSERT channel
                // (see pendingIdFor above), as the gesture's single
                // undo step. Only UNAVAILABLE categories keep the empty
                // placeholder.
                const tab = activeRailTab;
                if (!tab || !activeLayer) return null;
                if (!tab.available) {
                  return <EmptyCategoryPanel label={tab.label} available={false} />;
                }
                const instance: EffectInstance = tab.instance ?? {
                  id: pendingIdFor(activeLayer.id, tab.category),
                  category: tab.category as EffectCategory,
                  enabled: false,
                  params: defaultParamsFor(tab.category as EffectCategory),
                };
                switch (instance.category) {
                  case "stroke":
                    return <StrokePanel key={instance.id} layer={activeLayer} instance={instance} />;
                  case "shadow":
                    return <ShadowPanel key={instance.id} layer={activeLayer} instance={instance} />;
                  case "colorOverlay":
                    return <ColorOverlayPanel key={instance.id} layer={activeLayer} instance={instance} />;
                  case "outerGlow":
                    return <OuterGlowPanel key={instance.id} layer={activeLayer} instance={instance} />;
                  case "gradientOverlay":
                    return <GradientOverlayPanel key={instance.id} layer={activeLayer} instance={instance} />;
                  case "innerGlow":
                    return <InnerGlowPanel key={instance.id} layer={activeLayer} instance={instance} />;
                  case "innerShadow":
                    return <InnerShadowPanel key={instance.id} layer={activeLayer} instance={instance} />;
                  default:
                    return <EmptyCategoryPanel label={EFFECT_CATEGORY_LABELS[instance.category] ?? instance.category} available={tab.available} />;
                }
              })()}
            </div>
          </VerticalTabs>
        </motion.div>
      )}
    </div>
  );
});
