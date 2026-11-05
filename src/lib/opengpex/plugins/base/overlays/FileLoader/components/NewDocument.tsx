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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, AlertCircle, ImagePlus, RectangleHorizontal, RectangleVertical } from 'lucide-react';
import { Motion } from '@opengpex/editor/core/motion';
import { EDITOR_Z_INDEX } from '@opengpex/editor/core/helpers/config';
import FancyButton from '@opengpex/editor/widgets/FancyButton';
import ComboInput from '@opengpex/editor/widgets/ComboInput';
import ColorSwatchRow from '@opengpex/editor/widgets/ColorSwatchRow';
import FunctionTabs from '@opengpex/editor/widgets/FunctionTabs';
import { useEditorState, useEditorServices, usePluginCommands } from '@opengpex/editor/core/context';
import { DPI_PRESETS } from '@opengpex/editor/core/files';
import type { FileLoaderCommandsMap } from '../commands.d';
import type { CreateBlankPayload } from '../commands';
import {
  generateCreationName,
  sizeToPixels,
  validateBlankCanvasSize,
  type BlankGamut,
  type BlankSizeUnit,
} from '../_new-doc';

// ─── Option tables (FunctionTabs option shape) ──────────────────────────────

const UNITS: Array<{ label: string; value: BlankSizeUnit }> = [
  { label: 'px', value: 'px' },
  { label: 'in', value: 'in' },
  { label: 'mm', value: 'mm' },
];

/** Preset backgrounds; a swatch pick switches to the custom colour (no tab active). */
type BackgroundPreset = 'white' | 'black' | 'transparent';
const BACKGROUNDS: Array<{ label: string; value: BackgroundPreset }> = [
  { label: 'White', value: 'white' },
  { label: 'Transparent', value: 'transparent' },
  { label: 'Black', value: 'black' },
];

/**
 * Size presets: one tap fills size + unit + DPI, everything else stays. The
 * active chip is derived from the current fields, so any manual edit simply
 * drops the highlight instead of fighting the user.
 */
type SizePresetId = 'fhd' | '4k' | 'mobile' | 'a4' | 'letter';
interface SizePreset { id: SizePresetId; label: string; w: number; h: number; unit: BlankSizeUnit; dpi: number }
const SIZE_PRESETS: SizePreset[] = [
  // Generic 9:16 portrait baseline (the dialog default); real handsets differ
  // per model, so there is no OS split.
  { id: 'mobile', label: 'Mobile', w: 1080, h: 1920, unit: 'px', dpi: 72 },
  { id: 'fhd', label: 'FHD', w: 1920, h: 1080, unit: 'px', dpi: 72 },
  { id: '4k', label: '4K', w: 3840, h: 2160, unit: 'px', dpi: 72 },
  { id: 'a4', label: 'A4', w: 210, h: 297, unit: 'mm', dpi: 300 },
  { id: 'letter', label: 'Letter', w: 8.5, h: 11, unit: 'in', dpi: 300 },
];
const SIZE_PRESET_OPTIONS: Array<{ label: string; value: SizePresetId }> = SIZE_PRESETS.map((p) => ({ label: p.label, value: p.id }));

const GAMUTS: Array<{ label: string; value: BlankGamut }> = [
  { label: 'sRGB', value: 'srgb' },
  { label: 'Display P3', value: 'display-p3' },
  { label: 'Adobe RGB', value: 'adobe-rgb' },
  { label: 'ProPhoto', value: 'prophoto-rgb' },
];

/** FunctionTabs is keyed on strings; the numeric depth is mapped at the edges. */
type BitDepthKey = '8' | '16';
const BIT_DEPTHS: Array<{ label: string; value: BitDepthKey }> = [
  { label: '8-bit', value: '8' },
  { label: '16-bit', value: '16' },
];

/** Defaults track the Mobile preset so it opens highlighted. */
const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1920;
const DEFAULT_DPI = 72;
const DEFAULT_CUSTOM_HEX = '#808080';
/** Engine default when the GPU has not negotiated limits yet (mirrors `commands.ts`). */
const FALLBACK_LIMITS = { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024 };

/** Display a pixel count in the chosen unit (inverse of `sizeToPixels`), rounded for the field. */
function pixelsToUnit(px: number, unit: BlankSizeUnit, dpi: number): number {
  if (unit === 'px') return px;
  const inches = px / dpi;
  const value = unit === 'in' ? inches : inches * 25.4;
  return Math.round(value * 100) / 100;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-20 shrink-0">
      {children}
    </span>
  );
}

// ─── Dialog ─────────────────────────────────────────────────────────────────

interface NewDocumentModalProps {
  isVisible: boolean;
  onCancel: () => void;
}

/**
 * NewDocumentModal — the New Document dialog.
 *
 * Shell (overlay, panel, title bar, Motion enter/exit, Escape) mirrors
 * `widgets/FancyChoice.tsx` so it reads as the same family as `askChoice`;
 * the body is a form rather than a choice list, which is why it is its own
 * component rather than a reuse of `askChoice`.
 */
export function NewDocumentModal({ isVisible, onCancel }: NewDocumentModalProps) {
  const { state } = useEditorState();
  const { pixels } = useEditorServices();
  const { createBlankCmd } = usePluginCommands<FileLoaderCommandsMap>();

  const containerRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  /** Wraps the Name field: ComboInput exposes no ref, so focus is driven from here. */
  const nameFieldRef = useRef<HTMLDivElement>(null);
  const onCancelRef = useRef(onCancel);
  useEffect(() => { onCancelRef.current = onCancel; }, [onCancel]);

  const [shouldRender, setShouldRender] = useState(isVisible);
  const [prevIsVisible, setPrevIsVisible] = useState(isVisible);

  // ── Form state (reset on every open) ──
  const [unit, setUnit] = useState<BlankSizeUnit>('px');
  const [widthValue, setWidthValue] = useState(DEFAULT_WIDTH);
  const [heightValue, setHeightValue] = useState(DEFAULT_HEIGHT);
  const [dpi, setDpi] = useState(DEFAULT_DPI);
  const [background, setBackground] = useState<BackgroundPreset | 'custom'>('transparent');
  const [customHex, setCustomHex] = useState(DEFAULT_CUSTOM_HEX);
  const [gamut, setGamut] = useState<BlankGamut>('display-p3');
  const [bitDepth, setBitDepth] = useState<8 | 16>(8);
  const [name, setName] = useState('');

  if (isVisible !== prevIsVisible) {
    setPrevIsVisible(isVisible);
    if (isVisible) {
      setShouldRender(true);
      setUnit('px');
      setWidthValue(DEFAULT_WIDTH);
      setHeightValue(DEFAULT_HEIGHT);
      setDpi(DEFAULT_DPI);
      setBackground('transparent');
      setCustomHex(DEFAULT_CUSTOM_HEX);
      setGamut('display-p3');
      setBitDepth(8);
      setName(generateCreationName(state.frames.order.map((id) => state.frames.byId[id]?.name ?? '')));
    }
  }

  useEffect(() => {
    if (isVisible) {
      if (containerRef.current) {
        Motion.to(containerRef.current, { opacity: 1, duration: 0.3, pointerEvents: 'auto' });
      }
      if (modalRef.current) {
        Motion.fromTo(modalRef.current,
          { scale: 0.92, opacity: 0, y: 20 },
          { scale: 1, opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
        );
      }
      // Focus the generated name with the caret at the end (append, not replace).
      // Deferred one frame so the field exists after the delayed-mount render.
      const focusTimer = requestAnimationFrame(() => {
        const input = nameFieldRef.current?.querySelector('input');
        if (!input) return;
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
      });
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancelRef.current();
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => {
        cancelAnimationFrame(focusTimer);
        window.removeEventListener('keydown', handleKeyDown);
      };
    } else {
      if (containerRef.current) {
        Motion.to(containerRef.current, {
          opacity: 0,
          duration: 0.2,
          pointerEvents: 'none',
          onComplete: () => { setShouldRender(false); },
        });
      }
      if (modalRef.current) {
        Motion.to(modalRef.current, { scale: 0.95, opacity: 0, y: 8, duration: 0.2 });
      }
    }
  }, [isVisible]);

  // ── Derived pixel size + validation ──
  const widthPx = sizeToPixels(widthValue, unit, dpi);
  const heightPx = sizeToPixels(heightValue, unit, dpi);
  const limits = useMemo(() => {
    const info = pixels.system?.gpuInfo?.();
    return info?.ready ? info.limits : FALLBACK_LIMITS;
  }, [pixels]);
  const verdict = validateBlankCanvasSize(widthPx, heightPx, limits);
  const trimmedName = name.trim();
  const nameTaken = state.frames.order.some((id) => state.frames.byId[id]?.name === trimmedName);
  const nameError = !trimmedName ? 'Name cannot be empty.' : nameTaken ? 'A document with this name already exists.' : null;
  const canCreate = verdict.ok && !nameError && !!createBlankCmd;

  const activePreset: SizePresetId | '' =
    SIZE_PRESETS.find((p) => p.unit === unit && p.dpi === dpi && p.w === widthValue && p.h === heightValue)?.id ?? '';
  const applyPreset = (id: SizePresetId) => {
    const p = SIZE_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setUnit(p.unit);
    setDpi(p.dpi);
    setWidthValue(p.w);
    setHeightValue(p.h);
  };

  const isPortrait = heightPx > widthPx;
  const swapOrientation = () => {
    setWidthValue(heightValue);
    setHeightValue(widthValue);
  };

  const handleUnitChange = (next: BlankSizeUnit) => {
    if (next === unit) return;
    // Keep the pixel size constant across the unit switch; the field just re-expresses it.
    setWidthValue(pixelsToUnit(widthPx, next, dpi));
    setHeightValue(pixelsToUnit(heightPx, next, dpi));
    setUnit(next);
  };

  const handleCreate = () => {
    if (!canCreate) return;
    const payload: CreateBlankPayload = {
      width: widthPx,
      height: heightPx,
      dpi,
      background: background === 'custom' ? { hex: customHex } : background,
      gamut,
      bitDepth,
      name: trimmedName,
    };
    void createBlankCmd?.execute(payload);
  };

  if (!shouldRender) return null;

  const unitSuffix = <span className="text-[9px] text-[var(--text-muted)]">{unit}</span>;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 flex items-center justify-center p-4 bg-zinc-950/30 backdrop-blur-[2px] opacity-0 pointer-events-none"
      style={{ zIndex: EDITOR_Z_INDEX.MODAL.DIALOG }}
    >
      <div
        ref={modalRef}
        className="relative w-full max-w-[520px] bg-[var(--bg-panel)] backdrop-blur-3xl rounded-2xl border border-[var(--border-light)] shadow-[0_32px_80px_rgba(0,0,0,0.25)]"
      >
        {/* Title bar */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <h3 className="flex items-center gap-2 text-[var(--text-main)] text-base font-black tracking-tight leading-tight">
            <ImagePlus size={16} strokeWidth={2.5} className="text-indigo-500" />
            Create a blank image
          </h3>
          <button
            onClick={onCancel}
            className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center outline-none
              bg-[var(--bg-stage)] dark:bg-white/[0.04]
              border border-[var(--border-subtle)] dark:border-white/[0.08]
              hover:bg-[var(--bg-panel)] dark:hover:bg-white/[0.08]
              hover:border-[var(--border-light)]
              text-[var(--text-muted)] hover:text-[var(--text-main)]
              transition-all duration-200 cursor-pointer"
          >
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>

        {/* Form */}
        <div className="px-5 pb-5 space-y-3">
          {/* Name */}
          <div ref={nameFieldRef} className="flex items-center gap-2">
            <FieldLabel>Name</FieldLabel>
            <ComboInput<string>
              type="text"
              value={name}
              onChange={setName}
              inputStyle={{ fontSize: 11 }}
              className="flex-1"
            />
          </div>

          {/* Presets */}
          <div className="flex items-center gap-2">
            <FieldLabel>Preset</FieldLabel>
            <FunctionTabs<SizePresetId | ''> forModal
              options={SIZE_PRESET_OPTIONS}
              value={activePreset}
              onChange={(v) => { if (v) applyPreset(v); }}
              size="sm"
              className="flex-1"
            />
          </div>
          <div className="border-t border-[var(--border-subtle)] dark:border-white/[0.06]" />

          {/* Size */}
          <div className="flex items-center gap-2">
            <FieldLabel>Size</FieldLabel>
            <div className="flex-1 flex items-center gap-1.5">
              <ComboInput<number>
                label="W"
                type="number"
                value={widthValue}
                onChange={setWidthValue}
                suffix={unitSuffix}
                className="flex-1"
              />
              <span className="text-[var(--text-muted)] text-[10px]">×</span>
              <ComboInput<number>
                label="H"
                type="number"
                value={heightValue}
                onChange={setHeightValue}
                suffix={unitSuffix}
                className="flex-1"
              />
              {/* DPI dropdown rendered in-container: the portal variant sits at
                  portal variant sits at z-index 1100 inside the popup root,
                  underneath this dialog. */}
              <ComboInput<number>
                type="number"
                value={dpi}
                onChange={(v) => setDpi(Math.max(1, Math.round(v || DEFAULT_DPI)))}
                options={DPI_PRESETS.map((p) => p.value)}
                byPortal={false}
                suffix={<span className="text-[9px] text-[var(--text-muted)]">dpi</span>}
                className="w-[7.5rem] shrink-0"
              />
              <FancyButton forModal
                onClick={swapOrientation}
                title={isPortrait ? 'Switch to landscape' : 'Switch to portrait'}
                iconOnly
                size="xs"
                shape="rect"
                variant="zinc"
                subtle
                className="shrink-0"
              >
                {isPortrait ? <RectangleVertical size={14} /> : <RectangleHorizontal size={14} />}
              </FancyButton>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <FieldLabel>Unit</FieldLabel>
            <FunctionTabs<BlankSizeUnit> forModal options={UNITS} value={unit} onChange={handleUnitChange} size="sm" className="w-44" />
            <span className="ml-auto text-[10px] tabular-nums text-[var(--text-muted)]/70">
              {widthPx} × {heightPx} px
            </span>
          </div>

          {/* Background: preset tabs, or a custom swatch (no tab active when custom). */}
          <div className="flex items-center gap-2">
            <FieldLabel>Background</FieldLabel>
            <FunctionTabs<BackgroundPreset | ''> forModal
              options={BACKGROUNDS}
              value={background === 'custom' ? '' : background}
              onChange={(v) => { if (v) setBackground(v); }}
              size="sm"
              className="w-64 shrink-0"
            />
            <span className="text-[9px] font-black uppercase tracking-tight text-[var(--text-muted)]/60">-or-</span>
            <div className="flex-1 min-w-0">
              <ColorSwatchRow forModal
                label="Fill"
                labelClassName="hidden"
                color={customHex}
                onChange={(hex) => { setCustomHex(hex); setBackground('custom'); }}
              />
            </div>
          </div>

          {/* Colour profile + bit depth */}
          <div className="flex items-center gap-2">
            <FieldLabel>Profile</FieldLabel>
            <FunctionTabs<BlankGamut> forModal options={GAMUTS} value={gamut} onChange={setGamut} size="sm" className="flex-1" />
          </div>
          <div className="flex items-center gap-2">
            <FieldLabel>Depth</FieldLabel>
            <FunctionTabs<BitDepthKey> forModal
              options={BIT_DEPTHS}
              value={String(bitDepth) as BitDepthKey}
              onChange={(v) => setBitDepth(v === '16' ? 16 : 8)}
              size="sm"
              className="w-44"
            />
          </div>

          {/* Validation */}
          {(!verdict.ok || nameError || (verdict.ok && verdict.warning)) && (
            <div className="flex items-start gap-2 pt-1">
              <AlertCircle
                size={12}
                className={`flex-shrink-0 mt-0.5 ${!verdict.ok || nameError ? 'text-rose-500' : 'text-amber-500'}`}
                strokeWidth={2.5}
              />
              <p className={`text-[10px] leading-relaxed ${!verdict.ok || nameError ? 'text-rose-500' : 'text-amber-500'}`}>
                {!verdict.ok ? verdict.reason : nameError ?? (verdict.ok ? verdict.warning : '')}
              </p>
            </div>
          )}

          {/* Create */}
          <div className="pt-2">
            <FancyButton forModal
              onClick={handleCreate}
              disabled={!canCreate}
              variant="green"
              size="md"
              shape="pill"
              className="w-full justify-center"
            >
              Create
            </FancyButton>
          </div>
        </div>
      </div>
    </div>
  );
}

export default NewDocumentModal;
