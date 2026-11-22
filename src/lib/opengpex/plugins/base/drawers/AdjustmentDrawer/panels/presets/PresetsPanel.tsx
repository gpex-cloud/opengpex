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
 * PresetsPanel — the one-click filter wall + the layer's adjustment details.
 *
 * Two tabs (shared FunctionTabs widget):
 * - "Filters": a 2-column grid of live miniatures. The panel captures the
 *   current composite ONCE (downscaled through `pixels.render.capture`) and
 *   grades that base through the preset arms for every card, so each
 *   thumbnail shows the preset applied to THIS photo (not a static sticker).
 * - "Details": an ordered read-only list of every adjustment mask currently
 *   on the active layer (chain order = commit order = render order), one row
 *   per mask with a compact human-readable value summary. The "Save as
 *   Preset" entry lives here too — the save action targets the layer's WHOLE
 *   combined look, so it sits next to the list that shows that look.
 *
 * Interaction contract (mirrors the sibling panels' gesture semantics):
 * - Click a preset   → `beginAdjustmentsEdit` checkpoint + one
 *   `applyFilterPreset` write = exactly ONE undo step.
 * - Click it again   → `presetId: 'none'` (back to a neutral chain).
 * - Strength tiers   → a 3-tier segmented control (Weak / Medium / Strong)
 *   replaces the old continuous slider. Changing the tier while a BUILT-IN
 *   preset is active re-interpolates the SAME preset through
 *   `updateFilterPreset`, which is NON-undoable: no new checkpoint opens, so
 *   a preset application plus any number of re-tiers stays exactly ONE undo
 *   entry (the click's checkpoint owns the whole session). If the tier is
 *   changed when no preset is active, it only records the tier for the next
 *   click. CUSTOM presets are exempt from tiering: a saved look is the final
 *   authored grade, so clicking a custom card always applies at t = 1
 *   exactly, and the tier strip never re-writes a custom application (it
 *   stays visible and keeps recording the tier for built-in clicks).
 *
 * Thumbnails render at full strength (t = 1) regardless of the active tier —
 * the card shows what the look IS; the tier scales what the layer GETS.
 *
 * Selection highlight: every preset-owned mask carries `fromPreset` — the id
 * of the preset whose application wrote it — so the highlighted card is
 * simply the preset found by that id across built-ins + saved customs. No
 * value comparison is involved: identity is recorded at write time and
 * survives re-tiers and page refreshes unchanged. A chain without the id
 * (legacy documents, masks tagged before the field existed) highlights
 * nothing, and an id pointing at a deleted custom preset finds no card —
 * both states still leave the presets-panel Reset fully functional.
 *
 * Save as Preset: click the entry button in the Details tab → an inline name
 * field appears pre-filled with the sensible DEFAULT name ("Custom Look",
 * collision-incremented to "Custom Look 2" etc., the same naming convention
 * as layer copies); Enter / the trailing check button (or blur) saves,
 * Escape / the trailing X button cancels. The confirm and cancel buttons
 * swallow `mousedown` so pressing them never blurs the input first (blur
 * commits, which would double-fire before the click lands). While either
 * name input is open, Escape also stops propagation: the craft overlays
 * keep document-level keydown listeners that deactivate the active tool on
 * Escape, and a name edit must not eject the user from the brush/mosaic
 * they are working in. Disabled when the
 * active layer has no grade (nothing to extract). Extraction snapshots the
 * chain itself — one saved stage per enabled grade mask, in chain order — so
 * re-applying the saved look reproduces the screen exactly, compounding
 * included.
 *
 * Custom presets persist in the AdjustmentDrawer plugin config (survives
 * reloads). Custom cards live in their own trailing section, reuse the same
 * thumbnail path and id-based highlight as the built-ins, carry a delete
 * affordance, and are renamable by double-clicking the name label
 * (Enter / blur commits, Escape cancels). Built-in cards are never
 * renamable.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { usePluginCommands } from "@opengpex/editor/core/context";
import { useEditorServices, useEditorState } from "@opengpex/editor/core/context";
import { usePluginSelfConfig } from "@opengpex/editor/core/context";
import {
  appendCustomFilterPreset,
  DEFAULT_PRESET_TIER,
  extractPresetChainFromMasks,
  PRESET_STRENGTH_TIERS,
  findSelectedPresetId,
  presetApplyStrength,
  resolvePresetChain,
  tierToStrength,
} from "@opengpex/editor/plugins/base/drawers/AdjustmentDrawer/grading/presets/preset-chain";
import type { FilterPreset, FilterPresetGroup, PresetChainEntry, PresetStrengthTier } from "@opengpex/editor/plugins/base/drawers/AdjustmentDrawer/grading/presets/preset-chain";
import { buildPresetEnvelope, parseImportedPresetEnvelope, presetFileName } from "@opengpex/editor/plugins/base/drawers/AdjustmentDrawer/grading/presets/preset-io";
import {
  FILTER_PRESETS,
  FILTER_PRESET_GROUP_LABELS,
  FILTER_PRESET_GROUP_ORDER,
} from "@opengpex/editor/plugins/base/drawers/AdjustmentDrawer/grading/presets/preset-data";
import type { AdjustmentDrawerCommandsMap } from "../../commands.d";
import type { AdjustmentDrawerConfig } from "../../protocols";
import { useAdjustmentDrawer, useFilterGesture } from "../../hooks";
import { baselineCaptureLayers, captureThumbSource, renderPresetChainThumb } from "../../grading/presets/preview";
import FunctionTabs from "@opengpex/editor/widgets/FunctionTabs";
import FancyButton from "@opengpex/editor/widgets/FancyButton";
import { SavePreset } from "./SavePreset";
import { PresetCard } from "./PresetCard";
import { summarizeMask, type AdjustmentDetailRow } from "./details-rows";


/**
 * Capture readiness retries: the engine's WebGPU surface comes up shortly
 * after a page reload, so a failed first capture is retried on a short fixed
 * backoff instead of failing silently for the session.
 */
const CAPTURE_RETRY_ATTEMPTS = 10;
const CAPTURE_RETRY_DELAY_MS = 250;

/** Base name for freshly saved custom presets. */
const CUSTOM_PRESET_BASE_NAME = "Custom Look";

/**
 * Fixed height both tab bodies share, so switching tabs never resizes the
 * panel. Sized to the Filters tab's natural height (its ~392px scroll wall
 * plus the tier footer); the Details tab fills the same box and scrolls
 * internally when its list overflows.
 */
const TAB_BODY_HEIGHT_CLASS = "h-[360px]";

/**
 * Collision-aware default name for a new custom preset, mirroring the layer
 * factory's copy-naming convention (`getNewLayerName`): the bare base name
 * when free, otherwise `"<base> N+1"` where N is the highest existing
 * suffix — so saves in a row yield "Custom Look", "Custom Look 2", ...
 */
function nextCustomPresetName(existing: FilterPreset[]): string {
  const names = existing.map((p) => p.name);
  if (!names.includes(CUSTOM_PRESET_BASE_NAME)) return CUSTOM_PRESET_BASE_NAME;
  const escapedBase = CUSTOM_PRESET_BASE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedBase}\\s+(\\d+)$`);
  let maxNumber = 1;
  for (const name of names) {
    const match = name.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNumber) maxNumber = num;
    }
  }
  return `${CUSTOM_PRESET_BASE_NAME} ${maxNumber + 1}`;
}
  type FiltersPanelTab = 'filters' | 'details';

export function PresetsPanel() {
  const {
    beginAdjustmentsEditCmd,
    applyFilterPresetCmd,
    updateFilterPresetCmd,
  } = usePluginCommands<AdjustmentDrawerCommandsMap>();
  const { activeLayer } = useAdjustmentDrawer();
  const { activeFrame } = useEditorState();
  const { pixels, actions } = useEditorServices();
  const gesture = useFilterGesture(beginAdjustmentsEditCmd);
  const [selfConfig, setSelfConfig] = usePluginSelfConfig<AdjustmentDrawerConfig>();
  // Memoized so the callbacks below keep stable identities across renders
  // (the config store hands back a fresh array reference per read).
  const customPresets = useMemo(
    () => selfConfig?.customFilterPresets ?? [],
    [selfConfig?.customFilterPresets],
  );

  // Tab state is local (no reason to persist which half of one panel the user
  // was reading); defaults to the preset wall.
  const [tab, setTab] = useState<FiltersPanelTab>('filters');

  const [tier, setTier] = useState<PresetStrengthTier>(DEFAULT_PRESET_TIER);
  // The preset the tier control targets: the last one clicked, falling back
  // to whatever the layer currently carries.
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  // The captured base miniature shared by every card. `null` while the first
  // capture is in flight (or retrying) — cards render a neutral pulse instead
  // of an empty canvas until a base lands.
  const [baseCanvas, setBaseCanvas] = useState<HTMLCanvasElement | null>(null);
  const canvasesRef = useRef<Map<string, HTMLCanvasElement>>(new Map());

  const registerCanvas = useCallback((id: string, el: HTMLCanvasElement | null) => {
    if (el) canvasesRef.current.set(id, el);
    else canvasesRef.current.delete(id);
  }, []);

  // ── Save-as-preset (Details tab) ──
  // Inline name-entry state: closed, or open with the pre-filled draft.
  const [saveDraft, setSaveDraft] = useState<string | null>(null);

  const saveDisabled = extractPresetChainFromMasks(activeLayer?.adjustMasks) === null;

  // The DEFAULT name is applied when the field opens — the user can just hit
  // Enter; they rename the card afterwards if they want a different name.
  const openSaveInput = useCallback(() => {
    if (saveDisabled) return;
    setSaveDraft(nextCustomPresetName(customPresets));
  }, [saveDisabled, customPresets]);

  // ── Export / Import (Details tab) ──
  // The same disabled guard as Save: export needs a grade to extract.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // A pending imported chain awaiting its inline name confirm (validated by
  // `parseImportedPresetEnvelope` — never raw file data).
  const [importDraftChain, setImportDraftChain] = useState<PresetChainEntry[] | null>(null);
  // Inline error text shown next to the buttons when an import file is
  // rejected; cleared on the next import attempt or save/cancel.
  const [importError, setImportError] = useState<string | null>(null);

  // Commit path shared by Enter and blur. Extraction is also the no-save
  // guard here (a layer without grade masks yields `null`; the disabled
  // button makes this unreachable except through a race with a layer change).
  // When the draft came from an IMPORT, the already-validated imported chain
  // takes precedence over a fresh extraction — the imported look must land
  // verbatim, not whatever the chain happens to carry at confirm time.
  const commitSaveInput = useCallback(() => {
    if (saveDraft === null) return;
    const name = saveDraft.trim();
    setSaveDraft(null);
    if (!name) return; // Escape-cancelled or emptied draft — nothing saved.
    const chain = importDraftChain ?? extractPresetChainFromMasks(activeLayer?.adjustMasks);
    const wasImported = importDraftChain !== null;
    setImportDraftChain(null);
    setImportError(null);
    if (!chain) return;
    // An IMPORTED look announces itself through the house HUD once it has
    // actually landed in the saved list (the confirm commit is the moment
    // the import is real; a parse success alone would lie if the user then
    // cancelled the name row).
    if (wasImported) actions.notifyHUD('Filter preset imported', 'success');
    const id = `fp_${Date.now().toString(36)}`;
    const preset: FilterPreset = {
      id,
      nameKey: `presets.custom.${id}`,
      name,
      group: 'custom',
      chain,
    };
    setSelfConfig({ customFilterPresets: appendCustomFilterPreset(customPresets, preset) });
  }, [saveDraft, activeLayer, customPresets, setSelfConfig, importDraftChain, actions]);

  const cancelSaveInput = useCallback(() => {
    setSaveDraft(null);
    setImportDraftChain(null);
    setImportError(null);
  }, []);

  // Export: serialize the extracted chain into the versioned envelope and
  // hand it to the browser as a .json download. All DOM mechanics live here;
  // the envelope text itself comes from the pure, unit-tested builder.
  const exportCurrentLook = useCallback(() => {
    const chain = extractPresetChainFromMasks(activeLayer?.adjustMasks);
    if (!chain) return;
    const name = nextCustomPresetName(customPresets);
    const json = buildPresetEnvelope(name, chain);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = presetFileName(name);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [activeLayer, customPresets]);

  const openImportPicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Import: read the picked file, validate it through the strict whitelist
  // parser, then open the SAME inline name row used by Save — pre-filled with
  // the envelope's name (or the collision-aware default when the file's name
  // is unusable). A rejected file shows an inline error and opens nothing.
  const handleImportFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset the input so re-picking the SAME file fires change again.
      event.target.value = '';
      if (!file) return;
      let parsed: ReturnType<typeof parseImportedPresetEnvelope>;
      try {
        parsed = parseImportedPresetEnvelope(await file.text());
      } catch {
        // A rejected import shows the inline error next to the buttons AND
        // raises the house HUD — the user may have already moved focus or
        // switched tabs, and the transient toast keeps the failure visible.
        setImportError('Could not read the selected file');
        actions.notifyHUD('Could not read the selected file', 'error');
        return;
      }
      if (!parsed.ok) {
        setImportError(parsed.error);
        actions.notifyHUD(parsed.error, 'error');
        return;
      }
      setImportError(null);
      setImportDraftChain(parsed.chain);
      setSaveDraft(parsed.name || nextCustomPresetName(customPresets));
    },
    [customPresets, actions],
  );

  const deleteCustomPreset = useCallback(
    (id: string) => {
      setSelfConfig({ customFilterPresets: customPresets.filter((p) => p.id !== id) });
    },
    [customPresets, setSelfConfig],
  );

  const renameCustomPreset = useCallback(
    (id: string, name: string) => {
      setSelfConfig({
        customFilterPresets: customPresets.map((p) => (p.id === id ? { ...p, name } : p)),
      });
    },
    [customPresets, setSelfConfig],
  );

  // Selection highlight reads the applied preset's id straight off the
  // preset-owned chain (`fromPreset`), then resolves it across built-ins +
  // saved customs. No value comparison: identity is recorded at write time,
  // so the highlight survives re-tiers and page refreshes and cannot confuse
  // a saved look with the built-in it came from.
  const masks = activeLayer?.adjustMasks;
  const allPresets = useMemo(() => [...FILTER_PRESETS, ...customPresets], [customPresets]);
  const selectedId = useMemo(() => {
    const id = findSelectedPresetId(masks);
    return id !== null && allPresets.some((p) => p.id === id) ? id : null;
  }, [masks, allPresets]);

  // One capture when the panel opens or the frame changes. Thumbnails grade
  // this base at FULL strength (the card shows the look; the tier scales what
  // the layer gets). The previous base stays visible until the fresh capture
  // lands — the completion callback is guarded against unmount / effect
  // re-run races by the `cancelled` flag.
  //
  // RETRY: right after a page reload the panel can mount before the WebGPU
  // engine has a usable device/surface, so the first capture rejects (or
  // yields an empty readback). A rejected first attempt used to leave every
  // card black until some unrelated interaction; retries with a short backoff
  // ride the engine's readiness and land the base as soon as the surface is
  // live. The click-to-apply path never depended on the thumbnails.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (!activeFrame) return;
    // Baseline-locked capture: strip the active layer's grade chain from the
    // subset so an applied preset never bakes into the base miniature (which
    // would compound preset-on-preset on the next capture). Deliberately NOT
    // keyed on the layer's grade state — the baseline must not shift when a
    // preset lands.
    const layers = baselineCaptureLayers(activeFrame, activeLayer?.id);
    const attempt = (remaining: number) => {
      captureThumbSource(activeFrame, (frame, opts) => pixels.render.capture(frame, opts), layers)
        .then((canvas) => {
          if (cancelled) return;
          if (canvas) {
            setBaseCanvas(canvas);
          } else if (remaining > 0) {
            timer = setTimeout(() => attempt(remaining - 1), CAPTURE_RETRY_DELAY_MS);
          }
        })
        .catch(() => {
          if (cancelled) return;
          if (remaining > 0) {
            timer = setTimeout(() => attempt(remaining - 1), CAPTURE_RETRY_DELAY_MS);
          }
        });
    };
    attempt(CAPTURE_RETRY_ATTEMPTS);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [activeFrame, pixels, activeLayer?.id]);

  // Grade every card's canvas from the shared base whenever the base arrives
  // (or the custom list changes — new cards need their thumbnails). A chain
  // preset's stages are graded sequentially so the thumbnail shows the
  // compounded look, exactly what application writes to the layer.
  useEffect(() => {
    if (!baseCanvas) return;
    for (const preset of allPresets) {
      const el = canvasesRef.current.get(preset.id);
      if (!el) continue;
      renderPresetChainThumb(baseCanvas, el, resolvePresetChain(preset));
    }
    // `allPresets` is a fresh array each render; keyed on the identities the
    // thumbnails actually depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseCanvas, customPresets]);

  const handleSelect = useCallback(
    (preset: FilterPreset) => {
      if (!activeLayer) return;
      const isReset = selectedId === preset.id;
      gesture.begin();
      if (isReset) {
        // Second click on the selected preset: back to neutral.
        applyFilterPresetCmd?.execute({ presetId: 'none', strength: 1 });
        setActivePresetId(null);
      } else {
        // Built-ins apply at the CURRENT tier (the control defaults to
        // Medium). Custom presets are EXEMPT: a saved look IS the final
        // authored grade, so it always applies at t = 1 exactly — blending it
        // toward neutral at Medium would deform every value (a 0.7 blend of
        // an already-combined look), which is not a weaker version of the
        // look the user saved but a different look. The tier strip stays
        // visible and keeps recording the tier for the next BUILT-IN click,
        // but it is inert while a custom card is selected: it never re-writes
        // a custom application, and clicking a custom card ignores it.
        const strength = presetApplyStrength(preset, tier);
        applyFilterPresetCmd?.execute({ presetId: preset.id, strength });
        setActivePresetId(preset.id);
      }
      gesture.end();
    },
    [activeLayer, selectedId, tier, gesture, applyFilterPresetCmd],
  );

  const handleTierChange = useCallback(
    (next: PresetStrengthTier) => {
      setTier(next);
      // Re-write the active preset at the new tier WITHOUT opening a gesture:
      // `updateFilterPreset` is non-undoable, so the click's checkpoint stays
      // the only undo entry for the whole apply + re-tier session. No active
      // preset yet → the tier only records the value for the next click.
      // Custom presets are exempt from re-tiering (they always sit at t = 1,
      // see handleSelect): moving the strip while a custom card is selected
      // only records the tier for a future built-in click.
      if (!activeLayer || !activePresetId) return;
      const activeIsCustom = allPresets.find((p) => p.id === activePresetId)?.group === 'custom';
      if (activeIsCustom) return;
      updateFilterPresetCmd?.execute({ presetId: activePresetId, strength: tierToStrength(next) });
    },
    [activeLayer, activePresetId, allPresets, updateFilterPresetCmd],
  );

  const renderGrid = (presets: FilterPreset[], isCustom: boolean) => (
    <div className="grid grid-cols-2 gap-1">
      {presets.map((preset) => (
        <PresetCard
          key={preset.id}
          preset={preset}
          selected={selectedId === preset.id}
          pending={!baseCanvas}
          onSelect={handleSelect}
          registerCanvas={registerCanvas}
          onDelete={isCustom ? deleteCustomPreset : undefined}
          onRename={isCustom ? renameCustomPreset : undefined}
        />
      ))}
    </div>
  );

  // Details rows: one per mask, chain order. Recomputed per render — the
  // chain is small (capped masks per layer) and this stays a pure read.
  const detailRows: AdjustmentDetailRow[] = (masks ?? []).map((mask) => {
    const { categoryLabel, summary } = summarizeMask(mask);
    return {
      maskId: mask.id,
      categoryLabel,
      summary,
      disabled: mask.enabled === false,
    };
  });

  const tabOptions = [
    { label: 'Filters', value: 'filters' as FiltersPanelTab },
    { label: 'Details', value: 'details' as FiltersPanelTab },
  ];

  return (
    <div className="flex flex-col gap-1.5 min-h-0">
      {/* Tab switcher: preset wall vs the layer's adjustment details. Same
          compact `sm` language as the other drawer tab strips. */}
      <FunctionTabs
        options={tabOptions}
        value={tab}
        onChange={(next) => setTab(next)}
        size="sm"
      />

      {/* Both tab bodies stay MOUNTED at all times — the inactive one is
          hidden with CSS (`display: none`). Conditional rendering used to
          unmount the preset grid on the Details tab, and the per-card
          canvases came back BLACK on return until the capture retry logic
          fired again; keeping the DOM alive preserves the captured base and
          the graded thumbnails across tab flips with zero re-captures. Both
          bodies share one fixed height so switching tabs never resizes the
          panel; each scrolls internally when its content overflows. */}
      <div className={`${TAB_BODY_HEIGHT_CLASS} ${tab === 'filters' ? 'flex flex-col gap-1.5 min-h-0' : 'hidden'}`}>
        {/* Preset wall scrolls internally so the tier footer stays pinned and
            the drawer icons below the expanded panel stay reachable. Vertical
            only: any child poking past the right edge (card badges, long
            labels) must clip, never widen the panel with a horizontal
            scrollbar. */}
        <div className="flex flex-col gap-1.5 min-h-0 flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar">
          {FILTER_PRESET_GROUP_ORDER.map((group: FilterPresetGroup) => {
            const presets = FILTER_PRESETS.filter((p) => p.group === group);
            if (presets.length === 0) return null;
            return (
              <div key={group} className="flex flex-col gap-1">
                <span className="text-[8px] font-black tracking-widest uppercase text-[var(--text-muted)]">
                  {FILTER_PRESET_GROUP_LABELS[group]}
                </span>
                {renderGrid(presets, false)}
              </div>
            );
          })}
          {/* Custom section: hidden while nothing is saved. */}
          {customPresets.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[8px] font-black tracking-widest uppercase text-[var(--text-muted)]">
                {FILTER_PRESET_GROUP_LABELS.custom}
              </span>
              {renderGrid(customPresets, true)}
            </div>
          )}
        </div>

        {/* Footer — tier control only. Non-scrolling: always visible
            regardless of how far the wall is scrolled. */}
        <div className="flex items-center gap-1 pt-0.5 shrink-0">
          {/* 3-tier strength control. Compact segmented strip in the same
              visual language as the Curves channel tabs (rounded track +
              active pill) so it reads as part of the drawer, not a foreign
              widget. Changing the tier re-interpolates the active preset
              through the non-undoable update command — one undo entry total
              per preset application. */}
          <div
            role="radiogroup"
            aria-label="Preset strength"
            className="flex flex-1 p-0.5 gap-0.5 rounded-lg border border-zinc-200 dark:border-white/5 bg-zinc-100/80 dark:bg-black/20 shadow-inner"
          >
            {PRESET_STRENGTH_TIERS.map((def) => {
              const active = def.key === tier;
              return (
                <button
                  key={def.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => handleTierChange(def.key)}
                  title={`${def.label} strength`}
                  className={`flex-1 h-5 rounded-md text-[9px] font-black tracking-tight transition-colors outline-none focus:outline-none focus-visible:outline-none ${
                    active
                      ? "bg-white dark:bg-zinc-700 shadow-sm text-[var(--text-main)]"
                      : "hover:bg-white/40 dark:hover:bg-white/5 text-[var(--text-muted)] hover:text-[var(--text-main)]"
                  }`}
                >
                  {def.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Details tab: the layer's whole adjustment chain + save entry ── */}
      <div className={`${TAB_BODY_HEIGHT_CLASS} ${tab === 'details' ? 'flex flex-col gap-1.5 min-h-0' : 'hidden'}`}>
        <div className="flex flex-col gap-1.5 min-h-0 flex-1 overflow-y-auto custom-scrollbar">
          {detailRows.length === 0 ? (
            <span className="py-3 text-center text-[9px] font-bold tracking-tight text-[var(--text-muted)] select-none">
              No adjustments
            </span>
          ) : (
            <ol className="flex flex-col gap-0.5">
              {detailRows.map((row) => (
                <li
                  key={row.maskId}
                  className="flex items-baseline gap-1.5 px-1.5 py-1 rounded-md bg-zinc-100/60 dark:bg-white/[0.03]"
                >
                  <span className="text-[9px] font-black tracking-tight text-[var(--text-main)] shrink-0">
                    {row.categoryLabel}
                    {row.disabled ? ' (off)' : ''}
                  </span>
                  {row.summary && (
                    <span className="text-[9px] font-bold tracking-tight text-[var(--text-muted)] truncate">
                      {row.summary}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}

          {/* Save / Export / Import entry. Lives in Details because all three
              target the WHOLE combined look this list is showing (extraction
              snapshots the chain stage by stage, so the saved look reproduces
              exactly what these rows render). Save opens the inline name
              input pre-filled with the
              default name; Enter / blur commits, Escape cancels. Export
              downloads the look as a versioned .json envelope; Import opens a
              file picker and routes the file through the strict whitelist
              parser before it may touch pluginConfig. Save/Export are disabled
              when the layer carries no grade masks (nothing to extract);
              Import stays enabled so a file can be loaded on an empty layer. */}
          {saveDraft === null ? (
            <>
              <div className="flex items-center gap-1 w-full mt-auto pt-1.5 shrink-0">
                <FancyButton
                  variant="indigo"
                  subtle
                  shape="rect"
                  size="xs"
                  onClick={openSaveInput}
                  disabled={saveDisabled}
                  className="h-5 flex-1 min-w-0"
                >
                  Save as Preset
                </FancyButton>
                <FancyButton
                  variant="indigo"
                  subtle
                  shape="rect"
                  size="xs"
                  onClick={exportCurrentLook}
                  disabled={saveDisabled}
                  className="h-5 shrink-0"
                >
                  <span className="flex items-center gap-0.5">
                    <Download size={9} strokeWidth={2.5} />
                    Export
                  </span>
                </FancyButton>
                <FancyButton
                  variant="indigo"
                  subtle
                  shape="rect"
                  size="xs"
                  onClick={openImportPicker}
                  className="h-5 shrink-0"
                >
                  <span className="flex items-center gap-0.5">
                    <Upload size={9} strokeWidth={2.5} />
                    Import
                  </span>
                </FancyButton>
              </div>
              {importError && (
                <span className="text-[9px] font-bold tracking-tight text-red-600 dark:text-red-400 shrink-0 select-none">
                  {importError}
                </span>
              )}
              {/* Hidden picker backing the Import button. Triggered
                  programmatically so the visible row stays a plain button. */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleImportFile}
                className="hidden"
                aria-hidden="true"
                tabIndex={-1}
              />
            </>
          ) : (
            <SavePreset
              value={saveDraft}
              onChange={setSaveDraft}
              onCommit={commitSaveInput}
              onCancel={cancelSaveInput}
            />
          )}
        </div>
      </div>
    </div>
  );
}

