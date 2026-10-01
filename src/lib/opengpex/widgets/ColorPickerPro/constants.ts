import { hsvToRgb, rgbToHex } from "@opengpex/editor/core/engine/color";

export const RECENT_COLORS_KEY = "gpex-recent-colors";
export const MAX_RECENT = 10;

export function getRecentColors(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(RECENT_COLORS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export function addRecentColor(color: string) {
  if (typeof window === "undefined") return;
  try {
    const recents = getRecentColors().filter(
      (c) => c.toLowerCase() !== color.toLowerCase(),
    );
    recents.unshift(color.toUpperCase());
    localStorage.setItem(
      RECENT_COLORS_KEY,
      JSON.stringify(recents.slice(0, MAX_RECENT)),
    );
  } catch {
    /* ignore */
  }
}

export const PRESET_PALETTES = {
  Vibrant: [
    "#ef4444",
    "#f97316",
    "#f59e0b",
    "#eab308",
    "#84cc16",
    "#22c55e",
    "#06b6d4",
    "#3b82f6",
    "#8b5cf6",
    "#ec4899",
  ],
  Pastel: [
    "#fecaca",
    "#fed7aa",
    "#fef08a",
    "#bbf7d0",
    "#a7f3d0",
    "#a5f3fc",
    "#bfdbfe",
    "#c4b5fd",
    "#f5d0fe",
    "#fecdd3",
  ],
  Neutral: [
    "#ffffff",
    "#f5f5f5",
    "#d4d4d4",
    "#a3a3a3",
    "#737373",
    "#525252",
    "#404040",
    "#262626",
    "#171717",
    "#000000",
  ],
} as const;

export function getHarmonyColors(
  h: number,
  s: number,
  v: number,
): { label: string; colors: string[] }[] {
  const makeHex = (hue: number, sat: number, val: number) => {
    const rgb = hsvToRgb(((hue % 1) + 1) % 1, sat, val);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  };

  return [
    {
      label: "Complementary",
      colors: [makeHex(h, s, v), makeHex(h + 0.5, s, v)],
    },
    {
      label: "Analogous",
      colors: [
        makeHex(h - 1 / 12, s, v),
        makeHex(h, s, v),
        makeHex(h + 1 / 12, s, v),
      ],
    },
    {
      label: "Triadic",
      colors: [
        makeHex(h, s, v),
        makeHex(h + 1 / 3, s, v),
        makeHex(h + 2 / 3, s, v),
      ],
    },
    {
      label: "Split-Comp",
      colors: [
        makeHex(h, s, v),
        makeHex(h + 5 / 12, s, v),
        makeHex(h + 7 / 12, s, v),
      ],
    },
  ];
}
