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
 * TAB MODEL (user rulings 20261125 + 20261126): the rail ALWAYS renders all
 * TEN PS categories (the family's final shape stays visible; unimplemented
 * ones are empty placeholder tabs exactly like Shadow before P5), and
 * the header dropdown is the SAME data's second entry point — both stay.
 * Each AVAILABLE category carries at least one tab:
 *
 *   • zero instances → one transient VIRTUAL tab, auto-materialized the
 *     moment the category's panel is entered (the lazy-floor ensure writes a
 *     DISABLED instance with default parameters through the patch channel);
 *     the eye on it creates the instance enabled directly (PS checkbox
 *     semantics — one click lands a visibly-on effect);
 *   • n instances → n tabs in chain order, the first anchored at the
 *     category's PS-menu position, ordinally labelled ("Stroke", "Stroke 2").
 *
 * Inside the drawer a category is therefore UNIFORMLY "enabled vs disabled"
 * instances — the panel always addresses a real chain instance and shows its
 * parameters even while the eye is off. Delete is floor-guarded (a category
 * never empties — "no effect" is a disabled instance, never a missing one).
 * The header "+" inserts a new same-category instance beneath the active tab
 * (chain order = tab order).
 *
 * Parameter rows run the Q4 fast channel (identical to the adjustments
 * sliders): one undoable checkpoint on pointerdown, volatile-buffer writes
 * during the drag, ONE Redux write on pointerup = exactly one Undo step.
 * The per-category panels live under components/panels/ (one file per
 * available category); this file owns only the drawer shell (rail model,
 * tab resolution, header, panel routing).
 */

import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { EfxIcon } from "../icon";
import { useEditorState, useEditorServices, usePluginCommands, usePluginSignals } from "@opengpex/editor/core/context";
import { DrawerHeader } from "@opengpex/editor/workspace/components/DrawerHeader";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import VerticalTabs, { type VerticalTabItem } from "@opengpex/editor/widgets/VerticalTabs";
import { ChevronDown } from "lucide-react";
import type { EffectCategory, EffectInstance } from "@opengpex/editor/core/types/models";
import {
  appendEffectInstance,
  disableAllEffectInstances,
  ensureEffectCategoryInstance,
  effectInstanceOrdinal,
  getEffectChain,
  isCategoryFloorInstance,
  newEffectInstanceId,
} from "@opengpex/editor/core/layer/effects";
import type { LayerEffectsDrawerCommandsMap, LayerEffectsDrawerSignalsMap } from "../commands.d";
import { StrokePanel } from "./panels/StrokePanel";
import { ShadowPanel } from "./panels/ShadowPanel";
import { ColorOverlayPanel } from "./panels/ColorOverlayPanel";
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
  // [A8-DEBUG-RAILLABEL] temporary diagnosis log — remove once the
  // "Stroke 2 shows as Stroke" mismatch is closed.
  React.useEffect(() => {
    console.debug(
      `[A8 rail] layer=${activeLayer?.id ?? "none"} chainLen=${chain.length}`
      + ` chain=[${chain.map((i) => `${i.category}:${i.id}:${i.enabled}`).join(", ")}]`
      + ` rail=[${rail.map((t) => `${t.label}<${t.id.slice(0, 10)}${t.instance ? "inst" : "virt"}>`).join(", ")}]`,
    );
  }, [activeLayer, chain, rail]);

  // Active-tab resolution, fully render-derived (no effects, no
  // set-state-in-effect), three inputs in priority order:
  //   1. the user's manual tab click — recorded as an override STAMPED WITH
  //      the jump nonce it superseded, so a FRESH jump (new nonce) invalidates
  //      it and the signal wins again;
  //   2. a jump signal whose instance still exists on the rail;
  //   3. the layer-switch default (chain mutations / layer switches fall back
  //      here): the first ENABLED instance's tab — the panel follows what is
  //      actually rendering on the newly-selected layer; when NOTHING is
  //      enabled, the first AVAILABLE category's tab (stroke), which the
  //      lazy-floor ensure below materializes into a real disabled instance
  //      the moment the drawer opens on it.
  const [override, setOverride] = useState<{ id: string; nonce: number } | null>(null);
  const selectTab = (id: string) => setOverride({ id, nonce: jumpNonce });
  const overrideActive = !!override
    && override.nonce === jumpNonce
    && rail.some((t) => t.id === override.id);
  const signalTab = jump && rail.some((t) => t.id === jump.instanceId)
    ? jump.instanceId
    : null;
  const firstAvailableTabId = rail.find((t) => t.available)?.id ?? rail[0]?.id ?? "";
  const defaultTabId =
    rail.find((t) => t.instance?.enabled)?.id ?? firstAvailableTabId;
  const resolvedActiveId = overrideActive
    ? override.id
    : signalTab ?? defaultTabId;
  const activeRailTab = rail.find((t) => t.id === resolvedActiveId) ?? null;
  const activeCategory = activeRailTab?.category ?? "stroke";
  // [A8-DEBUG-RAILLABEL] temporary diagnosis log — remove with the block above.
  console.debug(
    `[A8 rail] resolved=${resolvedActiveId.slice(0, 10)} override=${override ? `${override.id.slice(0, 10)}@${override.nonce}` : "null"}`
    + ` jumpNonce=${jumpNonce} signalTab=${signalTab?.slice(0, 10) ?? "null"}`
    + ` activeLabel=${activeRailTab?.label ?? "none"}`,
  );
  const canAdd = !!activeLayer
    && activeRailTab?.available === true
    && (ADDABLE_CATEGORIES as readonly string[]).includes(activeCategory);

  // Lazy floor materialization (user ruling 20261126): entering an AVAILABLE
  // category that has no instance yet lands its DISABLED floor instance via
  // the patch channel — the panel's parameters then always address a real
  // chain instance, and "no effect" is uniformly a disabled instance, never
  // a missing one. Idempotent (ensure returns null when the category already
  // has an instance), so the effect only ever fires for the transient
  // zero-instance frame; one Undo step per category, at the moment the user
  // first edits that category on this layer.
  React.useEffect(() => {
    if (!activeLayer || !applyEffectPatchCmd) return;
    if (!activeRailTab?.available || activeRailTab.instance) return;
    // The drawer generates the id (appendEffectInstance precedent) so the
    // tab selection can FOLLOW the materialized instance: the virtual-tab
    // override would otherwise dangle once the rail replaces `virtual:<cat>`
    // with the real instance id (observed on device: the first click on an
    // untouched category flashed and fell back to the previous tab).
    const id = newEffectInstanceId();
    const patch = ensureEffectCategoryInstance(
      activeLayer,
      activeRailTab.category as EffectCategory,
      { id },
    );
    if (patch) {
      applyEffectPatchCmd.execute({ patch });
      selectTab(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLayer, activeRailTab?.available, activeRailTab?.instance, applyEffectPatchCmd]);

  // The EYE is the on/off switch: real instance → toggle enabled. On the
  // transient zero-instance tab (a category never touched on this layer) it
  // CREATES the instance enabled — one click lands a visibly-on effect, the
  // PS checkbox semantics (§5.2).
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
    selectTab(id);
  };

  const tabs: VerticalTabItem[] = useMemo(() => {
    return rail.map((railTab) => {
      const floor = railTab.instance
        ? (activeLayer ? isCategoryFloorInstance(activeLayer, railTab.instance.id) : false)
        : false;
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
            {railTab.instance && (
              <span
                role="button"
                aria-label={floor ? "The last instance of a kind cannot be deleted" : "Delete instance"}
                aria-disabled={floor}
                title={floor ? "The last instance of a kind cannot be deleted" : "Delete instance"}
                className={`p-0.5 rounded outline-none ${floor
                  ? "opacity-30 cursor-not-allowed"
                  : "hover:text-red-500 text-[var(--text-muted)] cursor-pointer"}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (floor) return;
                  removeEffectInstanceCmd?.execute({ instanceId: railTab.instance!.id });
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
  // The disable-all header action only matters while at least one instance is on.
  const hasEnabledInstances = rail.some((t) => t.instance?.enabled === true);

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
              {/* Disable-all: one patch turns every instance off (instances
                  stay listed — same semantics as a per-instance eye toggle,
                  never a removal). Always visible next to the add button;
                  dimmed while nothing is enabled (no-op by contract). */}
              <button
                disabled={!hasEnabledInstances}
                title={hasEnabledInstances
                  ? "Disable all effects on this layer"
                  : "No enabled effects to disable"}
                onClick={() => {
                  if (!activeLayer || !applyEffectPatchCmd) return;
                  const patch = disableAllEffectInstances(activeLayer);
                  if (patch) applyEffectPatchCmd.execute({ patch });
                }}
                className={`p-1 rounded outline-none ${hasEnabledInstances
                  ? "cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-main)]"
                  : "text-[var(--text-muted)] opacity-40 cursor-not-allowed"}`}
              >
                <EyeOff size={12} />
              </button>
              <button
                disabled={!canAdd}
                title={canAdd
                  ? `Add ${EFFECT_CATEGORY_LABELS[activeCategory] ?? activeCategory} instance (inserted beneath the active tab)`
                  : "Adding arrives with the shadow pipeline (P5)"}
                onClick={() => {
                  if (!activeLayer || !applyEffectPatchCmd || !canAdd) return;
                  const id = newEffectInstanceId();
                  const patch = appendEffectInstance(activeLayer, activeCategory as EffectCategory, { afterId: activeRailTab?.instance?.id, id });
                  applyEffectPatchCmd.execute({ patch });
                  selectTab(id);
                }}
                className={`p-1 rounded outline-none ${canAdd
                  ? "cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-main)]"
                  : "text-[var(--text-muted)] opacity-40 cursor-not-allowed"}`}
              >
                <Plus size={12} />
              </button>
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
                exceeds it — never scroll (user ruling 20261125). */}
            <div className="flex flex-col" style={{ minHeight: PANEL_MIN_HEIGHT_PX }}>
              {activeRailTab?.instance ? (
                activeRailTab.instance.category === "stroke" ? (
                  <StrokePanel
                    key={activeRailTab.instance.id}
                    layer={activeLayer}
                    instance={activeRailTab.instance}
                  />
                ) : activeRailTab.instance.category === "shadow" ? (
                  <ShadowPanel
                    key={activeRailTab.instance.id}
                    layer={activeLayer}
                    instance={activeRailTab.instance}
                  />
                ) : activeRailTab.instance.category === "colorOverlay" ? (
                  <ColorOverlayPanel
                    key={activeRailTab.instance.id}
                    layer={activeLayer}
                    instance={activeRailTab.instance}
                  />
                ) : (
                  <EmptyCategoryPanel
                    label={EFFECT_CATEGORY_LABELS[activeRailTab.instance.category] ?? activeRailTab.instance.category}
                    available={activeRailTab.available}
                  />
                )
              ) : (
                <EmptyCategoryPanel
                  label={activeRailTab?.label ?? ""}
                  available={activeRailTab?.available ?? false}
                />
              )}
            </div>
          </VerticalTabs>
        </motion.div>
      )}
    </div>
  );
});
