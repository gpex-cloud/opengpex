import type React from "react";
import type { ColorValue } from "@opengpex/editor/core/engine/color";
import type { GamutId } from "@opengpex/editor/core/types/primitives";

export interface ColorPickerProProps {
  /**
   * Legacy 8-bit sRGB string API (`"#rrggbb"`). Kept for compact swatch
   * consumers (brush / marker / text) that adapt at the boundary via `.hex` /
   * `fromHex`. Prefer the structured `value` API for wide-gamut-aware callers.
   */
  color?: string;
  onChange?: (color: string) => void;
  onCommit?: (color: string) => void;
  /**
   * Structured colour API (proposal §3.1). When `value` is supplied the picker is
   * ColorValue-driven and, with {@link enablePro}, can expose the wide-gamut Pro
   * tier. `onValueChange` / `onValueCommit` fire alongside legacy string callbacks.
   */
  value?: ColorValue;
  onValueChange?: (value: ColorValue) => void;
  onValueCommit?: (value: ColorValue) => void;
  /**
   * Offer the Pro / wide-gamut tier (a disclosure toggle → locked gamut badge +
   * f32 SV/Hue + float numeric read-out). Full variant + structured mode only.
   */
  enablePro?: boolean;
  /**
   * The current frame's colour gamut (§5.4 / decision H/I). `ColorPickerPro` is
   * frame-agnostic — the caller (`ColorOptions`) resolves this from
   * `frame.assetId → ColorIdentity` and passes it down. In Pro mode this is the
   * LOCKED view gamut: selection = this prop, display = `convertColorGamut(value,
   * frameGamut)`. Never derived from `value.space`, never user-switchable.
   * Defaults to `'srgb'` for non-frame-aware consumers (brush/marker/text).
   */
  frameGamut?: GamutId;
  /**
   * Auto-expand the Pro tier on mount (wide gamut OR high bit depth, independent
   * axes). Only ever turns Pro mode ON — never auto-collapses a panel the user
   * (or a previous auto-expand) already opened.
   */
  autoExpandPro?: boolean;
  showAlpha?: boolean;
  alpha?: number;
  onAlphaChange?: (alpha: number) => void;
  showHarmony?: boolean;
  showRecents?: boolean;
  /** 'full' = default full panel, 'compact' = smaller inline picker */
  variant?: "full" | "compact";
  /** Optional element rendered on the right side of the top header bar (e.g. Pin button). */
  headerRight?: React.ReactNode;
}

/**
 * Gamut choices for the Pro selector (every {@link GamutId}), in a stable display order.
 */
export const PRO_GAMUTS: readonly { id: GamutId; label: string }[] = [
  { id: "srgb", label: "sRGB" },
  { id: "display-p3", label: "Display P3" },
  { id: "adobe-rgb", label: "Adobe RGB" },
  { id: "rec2020", label: "Rec.2020" },
  { id: "prophoto-rgb", label: "ProPhoto" },
];
