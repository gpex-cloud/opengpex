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

import type { AdjustmentMask } from "@opengpex/editor/core/types/models";
import { DEFAULT_LEVELS_STATE } from "../../protocols";


// ─── Details tab: per-mask value summaries ─────────────────────────────────────

/** One row of the Details list: the category plus a compact value summary. */
export interface AdjustmentDetailRow {
  maskId: string;
  /** Human-readable category label (e.g. "Curves"). */
  categoryLabel: string;
  /** Compact value summary (e.g. "Brightness 104 · Contrast 112"). */
  summary: string;
  /** A disabled mask is shown but marked so the list stays truthful. */
  disabled: boolean;
}

/** Round a float for display: trims float noise without hiding fractional steps. */
const fmt = (v: number): string => String(Math.round(v * 100) / 100);

const CURVE_CHANNEL_LABELS: Record<string, string> = {
  rgb: 'RGB',
  red: 'Red',
  green: 'Green',
  blue: 'Blue',
};

const LEVELS_FIELD_LABELS: Array<{ key: keyof typeof DEFAULT_LEVELS_STATE; label: string }> = [
  { key: 'inputBlack', label: 'inBlack' },
  { key: 'inputWhite', label: 'inWhite' },
  { key: 'gamma', label: 'gamma' },
  { key: 'outputBlack', label: 'outBlack' },
  { key: 'outputWhite', label: 'outWhite' },
];

/**
 * Human-readable summary of one mask's grade arm. Only NON-identity values
 * are listed — a mask whose every field sits at identity reads "Neutral",
 * which keeps a long chain scannable.
 */
export function summarizeMask(mask: AdjustmentMask): { categoryLabel: string; summary: string } {
  const grade = (mask.grade ?? {}) as Record<string, Record<string, unknown> | undefined>;
  switch (mask.category) {
    case 'basic': {
      const a = grade.adjustments as Record<string, number | undefined> | undefined;
      if (!a) return { categoryLabel: 'Basic', summary: 'Neutral' };
      const parts: string[] = [];
      if (a.brightness !== undefined && a.brightness !== 100) parts.push(`Brightness ${fmt(a.brightness)}`);
      if (a.contrast !== undefined && a.contrast !== 100) parts.push(`Contrast ${fmt(a.contrast)}`);
      if (a.saturation !== undefined && a.saturation !== 100) parts.push(`Saturation ${fmt(a.saturation)}`);
      if (a.hueRotate !== undefined && a.hueRotate !== 0) parts.push(`Hue ${fmt(a.hueRotate)}`);
      if (a.blur !== undefined && a.blur !== 0) parts.push(`Blur ${fmt(a.blur)}`);
      if (a.edgeFeather !== undefined && a.edgeFeather !== 0) parts.push(`Feather ${fmt(a.edgeFeather)}`);
      return { categoryLabel: 'Basic', summary: parts.length ? parts.join(' · ') : 'Neutral' };
    }
    case 'curves': {
      const c = grade.curves as Record<string, unknown> | undefined;
      const channels = c
        ? (['rgb', 'red', 'green', 'blue'] as const).filter((ch) => Array.isArray(c[ch]))
        : [];
      const label = channels.map((ch) => CURVE_CHANNEL_LABELS[ch]).join(' + ');
      return { categoryLabel: 'Curves', summary: label ? `(${label})` : '(empty)' };
    }
    case 'levels': {
      const l = grade.levels as Record<string, number | undefined> | undefined;
      if (!l) return { categoryLabel: 'Levels', summary: 'Neutral' };
      const parts: string[] = [];
      for (const { key, label } of LEVELS_FIELD_LABELS) {
        const v = l[key];
        if (v !== undefined && v !== DEFAULT_LEVELS_STATE[key]) parts.push(`${label} ${fmt(v)}`);
      }
      return { categoryLabel: 'Levels', summary: parts.length ? `(${parts.join(' · ')})` : '(neutral)' };
    }
    case 'colorBalance': {
      const b = grade.colorBalance as Record<string, number[] | undefined> | undefined;
      if (!b) return { categoryLabel: 'Color Balance', summary: 'Neutral' };
      const parts: string[] = [];
      for (const key of ['shadows', 'midtones', 'highlights'] as const) {
        const v = b[key];
        if (v && (v[0] !== 0 || v[1] !== 0 || v[2] !== 0)) parts.push(`${key} ${fmt(v[0])}/${fmt(v[1])}/${fmt(v[2])}`);
      }
      return { categoryLabel: 'Color Balance', summary: parts.length ? `(${parts.join(' · ')})` : '(neutral)' };
    }
    case 'channelMix': {
      const m = grade.channelMix as Record<string, number[] | undefined> | undefined;
      if (!m) return { categoryLabel: 'Channel Mix', summary: 'Neutral' };
      const identity: Record<string, number[]> = {
        red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], constant: [0, 0, 0],
      };
      const parts: string[] = [];
      for (const key of ['red', 'green', 'blue', 'constant'] as const) {
        const v = m[key];
        const id = identity[key];
        if (v && (v[0] !== id[0] || v[1] !== id[1] || v[2] !== id[2])) parts.push(key);
      }
      return { categoryLabel: 'Channel Mix', summary: parts.length ? `(${parts.join(' + ')})` : '(neutral)' };
    }  }
}
