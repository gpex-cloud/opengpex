/**
 * Built-in filter preset table — pure data.
 *
 * Every entry is a single-stage authored look (partial grade arms); the chain
 * kernel (`preset-chain.ts`) normalizes it into the one-entry chain every
 * consumer speaks. Values are structured first-pass renditions pending
 * real-device calibration; the golden snapshot test locks each preset's
 * structure so accidental edits cannot slip in.
 *
 * @module plugins/base/drawers/AdjustmentDrawer/presets/preset-data
 */

import type { FilterPreset, FilterPresetGroup } from './preset-chain';
import type { CurvePoints } from '@opengpex/editor/core/types/models';

/** Curve helper: builds a `CurvePoints` list from `[x, y]` tuples with rounded
 * coordinates so snapshots stay stable across float noise. */
const curve = (pts: Array<[number, number]>): CurvePoints =>
  pts.map(([x, y]) => [x, y] as [number, number]);

/**
 * All 20 built-in presets in four groups: `basic` = everyday one-click
 * fixes, `film` = film-stock emulations, `tone` = stylized color
 * signatures, `mood` = scene-specific renditions.
 */
export const FILTER_PRESETS: FilterPreset[] = [
  // ── Basic fixes ──
  {
    id: 'vivid',
    nameKey: 'presets.vivid',
    name: 'Vivid',
    group: 'basic',
    state: {
      // Punch comes from a film S-curve (steep mids, anchored ends), not a
      // global contrast multiplier; a tiny blue-leaning midtone cast (positive
      // yellow-blue axis) keeps skies blue.
      curves: { rgb: curve([[0, 0], [0.25, 0.22], [0.75, 0.82], [1, 1]]) },
      adjustments: { saturation: 106, contrast: 104 },
      colorBalance: { midtones: [0, 0, 5] },
    },
  },
  {
    id: 'soft',
    nameKey: 'presets.soft',
    name: 'Soft',
    group: 'basic',
    state: {
      // Gentle lifted toe + slightly rolled shoulder reads as a soft, low-key
      // glow; a whisper of warm highlight tint keeps it from going gray.
      curves: { rgb: curve([[0, 0.06], [0.3, 0.34], [0.7, 0.68], [1, 0.97]]) },
      adjustments: { saturation: 94 },
      colorBalance: { highlights: [4, 2, 0] },
    },
  },
  {
    id: 'highKey',
    nameKey: 'presets.highKey',
    name: 'High Key',
    group: 'basic',
    state: {
      // Neutral bright key: lifted toe (0→0.08) plus a compressed shoulder
      // (1→0.94) with a flat ~0.86 slope — the curve does the lift, no
      // brightness multiplier, and no color cast anywhere.
      curves: { rgb: curve([[0, 0.08], [0.35, 0.44], [0.7, 0.78], [1, 0.94]]) },
      adjustments: { saturation: 88, contrast: 94 },
    },
  },
  {
    id: 'lowKey',
    nameKey: 'presets.lowKey',
    name: 'Low Key',
    group: 'basic',
    state: {
      // Neutral dark key: inputBlack crushes the floor first (levels), then
      // the S-curve amplifies mid-high contrast without touching a region
      // that is already black. Contrast stays at identity — the curve owns it.
      curves: { rgb: curve([[0, 0], [0.2, 0.12], [0.6, 0.56], [0.85, 0.82], [1, 0.96]]) },
      levels: { inputBlack: 10 },
      adjustments: { saturation: 94 },
    },
  },
  {
    id: 'portrait',
    nameKey: 'presets.portrait',
    name: 'Portrait',
    group: 'basic',
    state: {
      // Skin-friendly midtone-forward softness without a global brightness
      // bump: a gentle toe lift and slight shoulder roll smooth the extremes,
      // the red channel rises slightly through the mids with a softened red
      // shadow floor for smooth skin rendering, and a whisper of warm
      // (red+green) midtone/highlight tint adds subtle pink warmth.
      curves: {
        rgb: curve([[0, 0.03], [0.3, 0.31], [0.7, 0.72], [1, 0.97]]),
        red: curve([[0, 0.02], [0.5, 0.52], [1, 1]]),
      },
      adjustments: { saturation: 96, contrast: 98 },
      colorBalance: { midtones: [2, 2, -2], highlights: [4, 2, -2] },
    },
  },
  {
    id: 'mono',
    nameKey: 'presets.mono',
    name: 'Mono',
    group: 'basic',
    state: {
      // Punchy neutral B&W: the S-curve carries all of the contrast so the
      // basic arm stays at identity.
      curves: { rgb: curve([[0, 0], [0.25, 0.18], [0.75, 0.85], [1, 1]]) },
      adjustments: { saturation: 0 },
    },
  },
  {
    id: 'monoFilm',
    nameKey: 'presets.monoFilm',
    name: 'Mono Film',
    group: 'basic',
    state: {
      // Filmic B&W: lifted toe + rolled shoulder via the curve, then a cool
      // shadows / warm highlights split-tone applied after desaturation.
      curves: { rgb: curve([[0, 0.07], [0.3, 0.32], [0.75, 0.82], [1, 0.95]]) },
      adjustments: { saturation: 0 },
      colorBalance: { shadows: [-4, 0, 8], highlights: [6, 4, -2] },
    },
  },
  {
    id: 'trix',
    nameKey: 'presets.trix',
    name: 'Tri-X',
    group: 'basic',
    state: {
      // Hard documentary B&W after Kodak Tri-X: levels crush the input black
      // point (pixels below it map to 0 — deep, gritty shadow floor the curve
      // alone cannot reach since curve y must stay >= 0), then a steep S-curve
      // carries the punch. Fully desaturated, contrast stays at identity.
      curves: { rgb: curve([[0, 0], [0.22, 0.14], [0.78, 0.88], [1, 1]]) },
      levels: { inputBlack: 8 },
      adjustments: { saturation: 0 },
    },
  },
  // ── Film ──
  {
    id: 'filmWarm',
    nameKey: 'presets.filmWarm',
    name: 'Film Warm',
    group: 'film',
    state: {
      // Portra-like: lifted toe, rolled shoulder, blue channel pulled down in
      // highlights (warm cast), red channel nudged up mid-high.
      curves: {
        rgb: curve([[0, 0.05], [0.2, 0.16], [0.8, 0.86], [1, 0.97]]),
        blue: curve([[0, 0.07], [0.5, 0.5], [1, 0.94]]),
        red: curve([[0, 0], [0.5, 0.52], [1, 1]]),
      },
      adjustments: { contrast: 100, saturation: 94 },
      colorBalance: { shadows: [-4, 0, 6], highlights: [10, 2, -6] },
    },
  },
  {
    id: 'filmCold',
    nameKey: 'presets.filmCold',
    name: 'Film Cold',
    group: 'film',
    state: {
      // Fuji-like: slightly compressed mids, blue lifted through the range,
      // green channel gently dropping the midtones toward cyan.
      curves: {
        rgb: curve([[0, 0.04], [0.5, 0.5], [0.85, 0.88], [1, 0.96]]),
        blue: curve([[0, 0.06], [0.5, 0.5], [1, 1]]),
        green: curve([[0, 0.04], [0.5, 0.49], [1, 1]]),
      },
      adjustments: { contrast: 102, saturation: 92 },
      colorBalance: { shadows: [-2, -4, 10], highlights: [-8, 0, 4] },
    },
  },
  {
    id: 'faded',
    nameKey: 'presets.faded',
    name: 'Faded',
    group: 'film',
    state: {
      // The fade is controlled at exactly ONE point: the levels arm lifts the
      // black point / drops the white point. The curve arms stay near-neutral
      // so they cannot compound the fade into a muddy gray wash — the blue
      // channel keeps only a whisper of a cool floor. Contrast stays identity.
      levels: { outputBlack: 18, outputWhite: 242, gamma: 1.05 },
      curves: {
        rgb: curve([[0, 0], [0.3, 0.3], [0.7, 0.7], [1, 1]]),
        blue: curve([[0, 0.04], [1, 0.94]]),
      },
      adjustments: { saturation: 84, contrast: 100 },
      colorBalance: { shadows: [0, 0, 4], highlights: [4, 2, -2] },
    },
  },
  {
    id: 'crossProcess',
    nameKey: 'presets.crossProcess',
    name: 'Cross Process',
    group: 'film',
    state: {
      // Cross-processing (slide film in negative chemistry) signatures:
      // punchy slide-contrast S-curve; a lifted green toe makes greens pop
      // slightly electric; the blue channel lifts the shadow floor while
      // dropping the highlight ceiling (teal shadows, warm-yellow highlights),
      // and the split-tone amplifies exactly that shadow/highlight split.
      curves: {
        rgb: curve([[0, 0], [0.25, 0.22], [0.75, 0.82], [1, 1]]),
        red: curve([[0, 0], [0.5, 0.52], [1, 1]]),
        green: curve([[0, 0.04], [0.4, 0.42], [0.75, 0.78], [1, 0.98]]),
        blue: curve([[0, 0.08], [0.5, 0.49], [1, 0.88]]),
      },
      adjustments: { saturation: 112, contrast: 106 },
      colorBalance: {
        shadows: [-8, 2, 10],
        highlights: [12, 2, -12],
      },
    },
  },
  {
    id: 'slide',
    nameKey: 'presets.slide',
    name: 'Slide',
    group: 'film',
    state: {
      // Reversal (slide) film look: strong S-curve with extreme saturation.
      // The green channel gets a gentle mid push — Velvia-style "electric
      // greens" come from green outrunning red in the midtones; the split
      // tone keeps shadows slightly cool-green and highlights cool-green
      // too, so the cast reads as foliage vividness rather than warmth.
      curves: {
        rgb: curve([[0, 0], [0.25, 0.22], [0.75, 0.84], [1, 1]]),
        green: curve([[0, 0], [0.5, 0.52], [1, 1]]),
      },
      adjustments: { saturation: 118, contrast: 108 },
      colorBalance: {
        shadows: [-4, 2, 4],
        highlights: [2, 2, -4],
      },
    },
  },
  // ── Tone ──
  {
    id: 'tealOrange',
    nameKey: 'presets.tealOrange',
    name: 'Teal & Orange',
    group: 'tone',
    state: {
      // Hue-dependent separation: small off-diagonal channel-mix weights
      // spread skin tones toward orange while pushing the floor toward teal,
      // then split-toning amplifies the split.
      channelMix: {
        red: [1.06, 0.02, 0],
        green: [0.02, 0.98, 0.02],
        blue: [0, 0.04, 1.04],
        constant: [0.01, 0, -0.02],
      },
      colorBalance: {
        shadows: [-14, 0, 10],
        highlights: [12, 2, -10],
        midtones: [4, 0, -2],
      },
      curves: { rgb: curve([[0, 0.02], [0.5, 0.5], [1, 0.98]]) },
      adjustments: { saturation: 106 },
    },
  },
  {
    id: 'cinematic',
    nameKey: 'presets.cinematic',
    name: 'Cinematic',
    group: 'tone',
    state: {
      // Crushed-but-lifted floor (levels) under a film S-curve, with a strong
      // cool-shadows / warm-highlights split and muted saturation.
      curves: { rgb: curve([[0, 0.03], [0.25, 0.2], [0.75, 0.8], [1, 0.97]]) },
      levels: { inputBlack: 6, outputBlack: 10, outputWhite: 248 },
      colorBalance: { shadows: [-12, 0, 8], midtones: [-2, 0, -4], highlights: [8, 2, -8] },
      adjustments: { saturation: 90, contrast: 100 },
    },
  },
  {
    id: 'vintage',
    nameKey: 'presets.vintage',
    name: 'Vintage',
    group: 'tone',
    state: {
      // Heavy fade (big toe lift, dropped white) plus a true sepia cast: the
      // red toe sits clearly ABOVE the green toe so shadows go magenta-brown
      // (real sepia) instead of yellow-green, and the split-tone keeps a
      // slight red/magenta lean in shadows with warm highlights.
      curves: {
        rgb: curve([[0, 0.1], [0.5, 0.53], [1, 0.92]]),
        red: curve([[0, 0.1], [0.5, 0.54], [1, 0.95]]),
        green: curve([[0, 0.05], [1, 0.94]]),
      },
      adjustments: { saturation: 74, contrast: 96 },
      colorBalance: { shadows: [4, -2, -6], highlights: [10, 2, -8] },
    },
  },
  {
    id: 'japanese',
    nameKey: 'presets.japanese',
    name: 'Japanese',
    group: 'tone',
    state: {
      // Airy high-key: gently lifted toe, highlights allowed to bloom (y=1
      // anchor at 0.85 keeps mids bright), cool blue floor — no brightness
      // multiplier, the curve does the lift.
      curves: {
        rgb: curve([[0, 0.05], [0.4, 0.46], [0.85, 0.94], [1, 1]]),
        blue: curve([[0, 0.08], [0.5, 0.51], [1, 1]]),
      },
      adjustments: { saturation: 88, contrast: 96 },
      colorBalance: { shadows: [-4, -2, 8], highlights: [-8, 2, 8] },
    },
  },
  // ── Mood ──
  {
    id: 'goldenHour',
    nameKey: 'presets.goldenHour',
    name: 'Golden Hour',
    group: 'mood',
    state: {
      // Sunset warmth authored in sync across three places: the blue channel
      // pulls blue out of the highlights, the red channel lifts slightly
      // through the whole range, and the split-tone adds the final amber
      // bloom in the highlights (with only a faint amber echo in shadows).
      curves: {
        rgb: curve([[0, 0.03], [0.5, 0.52], [1, 0.98]]),
        red: curve([[0, 0.03], [0.5, 0.54], [1, 1]]),
        blue: curve([[0, 0], [0.5, 0.46], [1, 0.88]]),
      },
      adjustments: { saturation: 106, contrast: 102 },
      colorBalance: {
        shadows: [4, 0, -6],
        midtones: [4, 2, -4],
        highlights: [14, 4, -14],
      },
    },
  },
  {
    id: 'night',
    nameKey: 'presets.night',
    name: 'Night',
    group: 'mood',
    state: {
      // Dark, cool, muted: shoulder pulled down (dropped white), blue channel
      // lifted through the mids, shadows pushed toward a cool cyan-blue
      // (negative cyan-red + positive yellow-blue).
      curves: {
        rgb: curve([[0, 0.03], [0.3, 0.26], [0.8, 0.84], [1, 0.94]]),
        blue: curve([[0, 0.04], [0.5, 0.52], [1, 1]]),
      },
      levels: { outputWhite: 246 },
      adjustments: { saturation: 88, contrast: 100 },
      colorBalance: { shadows: [-6, 0, 10], highlights: [-4, 0, 6] },
    },
  },
  {
    id: 'cinestill',
    nameKey: 'presets.cinestill',
    name: 'Cinestill',
    group: 'mood',
    state: {
      // Neon night, distinct from `night`'s quiet cool ambience: a deep
      // cyan-split floor (strong negative cyan-red in shadows), a dropped
      // shoulder that keeps the base dark, and warm-amber highlights that
      // bloom like halated neon signage. Mid saturation stays muted; the
      // slight over-contrast lets highlight glow read as bloom.
      curves: {
        rgb: curve([[0, 0.04], [0.3, 0.26], [0.8, 0.86], [1, 0.98]]),
        blue: curve([[0, 0.06], [0.5, 0.52], [1, 0.98]]),
      },
      adjustments: { saturation: 92, contrast: 102 },
      colorBalance: {
        shadows: [-10, -2, 8],
        midtones: [-2, 0, 2],
        highlights: [12, 4, -10],
      },
    },
  },
];

/**
 * Panel render order for the BUILT-IN groups (narrative order, presets in
 * table order). The `'custom'` section is rendered separately at the bottom
 * of the wall from the user's saved presets, so it is intentionally absent
 * here.
 */
export const FILTER_PRESET_GROUP_ORDER: FilterPresetGroup[] = ['basic', 'film', 'tone', 'mood'];

/** Group display labels (English fallback; panels localize via `presets.group.*`). */
export const FILTER_PRESET_GROUP_LABELS: Record<FilterPresetGroup, string> = {
  basic: 'Basic',
  film: 'Film',
  tone: 'Tone',
  mood: 'Mood',
  custom: 'Custom',
};

/** Look up a preset by id (`undefined` when unknown). */
export function getFilterPreset(id: string): FilterPreset | undefined {
  return FILTER_PRESETS.find((p) => p.id === id);
}