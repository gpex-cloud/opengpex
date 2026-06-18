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

/* eslint-disable react-hooks/set-state-in-effect */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { Copy, Check, RotateCcw, Pipette } from "lucide-react";

// ============================================================
// Color Math Utilities
// ============================================================

export function hsvToRgb(h: number, s: number, v: number) {
  let r = 0,
    g = 0,
    b = 0;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      r = v;
      g = t;
      b = p;
      break;
    case 1:
      r = q;
      g = v;
      b = p;
      break;
    case 2:
      r = p;
      g = v;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = v;
      break;
    case 4:
      r = t;
      g = p;
      b = v;
      break;
    case 5:
      r = v;
      g = p;
      b = q;
      break;
  }
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

export function rgbToHsv(r: number, g: number, b: number) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (max === min) {
    h = 0;
  } else {
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return { h, s, v };
}

export function rgbToHsl(r: number, g: number, b: number) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }
  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

export function hslToRgb(h: number, s: number, l: number) {
  h /= 360;
  s /= 100;
  l /= 100;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

export function rgbToHex(r: number, g: number, b: number) {
  return (
    "#" +
    [r, g, b]
      .map((x) => {
        const hex = x.toString(16);
        return hex.length === 1 ? "0" + hex : hex;
      })
      .join("")
  );
}

export function hexToRgb(hex: string) {
  let c = hex.replace("#", "");
  if (c.length === 3)
    c = c
      .split("")
      .map((x) => x + x)
      .join("");
  if (c.length !== 6) return null;
  const num = parseInt(c, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

// ============================================================
// Color Harmony Calculations
// ============================================================

function getHarmonyColors(
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

// ============================================================
// Recent Colors Storage
// ============================================================

const RECENT_COLORS_KEY = "gpex-recent-colors";
const MAX_RECENT = 12;

function getRecentColors(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(RECENT_COLORS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function addRecentColor(color: string) {
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

// ============================================================
// Preset Palettes
// ============================================================

const PRESET_PALETTES = {
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
};

// ============================================================
// Types
// ============================================================

interface ColorPickerProProps {
  color: string;
  onChange: (color: string) => void;
  onCommit?: (color: string) => void;
  showAlpha?: boolean;
  alpha?: number;
  onAlphaChange?: (alpha: number) => void;
  showHarmony?: boolean;
  showRecents?: boolean;
  /** 'full' = default full panel, 'compact' = smaller inline picker */
  variant?: "full" | "compact";
}

// ============================================================
// Sub-components
// ============================================================

/** Checkerboard pattern for alpha backgrounds */
function CheckerBg({ className }: { className?: string }) {
  return (
    <div
      className={`absolute inset-0 ${className || ""}`}
      style={{
        backgroundImage: `
          linear-gradient(45deg, #ccc 25%, transparent 25%),
          linear-gradient(-45deg, #ccc 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, #ccc 75%),
          linear-gradient(-45deg, transparent 75%, #ccc 75%)
        `,
        backgroundSize: "8px 8px",
        backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0",
      }}
    />
  );
}

/** EyeDropper sampling helper */
async function sampleColorFromScreen(): Promise<string | null> {
  if (typeof window === "undefined" || !("EyeDropper" in window)) return null;
  try {
    // @ts-expect-error - EyeDropper is a modern API
    const eyeDropper = new window.EyeDropper();
    const result = await eyeDropper.open();
    return result.sRGBHex || null;
  } catch {
    return null;
  }
}

// ============================================================
// Main Component
// ============================================================

export function ColorPickerPro({
  color,
  onChange,
  onCommit,
  showAlpha = false,
  alpha = 1,
  onAlphaChange,
  showHarmony = true,
  showRecents = true,
  variant = "full",
}: ColorPickerProProps) {
  const [hsv, setHsv] = useState({ h: 0, s: 0, v: 1 });
  const [hexInput, setHexInput] = useState(color);
  const [copied, setCopied] = useState(false);
  const [copiedRgb, setCopiedRgb] = useState(false);
  const [copiedHsl, setCopiedHsl] = useState(false);
  const [originalColor] = useState(color);
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [showHarmonyPanel, setShowHarmonyPanel] = useState(false);
  const [activePalette, setActivePalette] =
    useState<keyof typeof PRESET_PALETTES>("Vibrant");

  const hsvRef = useRef({ h: 0, s: 0, v: 1 });
  const areaRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const alphaRef = useRef<HTMLDivElement>(null);
  const hexInputRef = useRef<HTMLInputElement>(null);

  const isCompact = variant === "compact";
  const hasEyeDropper = typeof window !== "undefined" && "EyeDropper" in window;

  // Load recent colors on mount
  useEffect(() => {
    setRecentColors(getRecentColors());
  }, []);

  // Auto-select hex on mount (full variant only)
  useEffect(() => {
    if (isCompact) return;
    const timer = setTimeout(() => {
      if (hexInputRef.current) {
        hexInputRef.current.focus();
        hexInputRef.current.select();
      }
    }, 80);
    return () => clearTimeout(timer);
  }, [isCompact]);

  // Sync internal HSV from external color prop
  useEffect(() => {
    const rgb = hexToRgb(color);
    if (rgb) {
      const newHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      setHsv((prev) => {
        const nextHsv = {
          h: newHsv.s === 0 ? prev.h : newHsv.h,
          s: newHsv.s,
          v: newHsv.v,
        };
        hsvRef.current = nextHsv;
        return nextHsv;
      });
      setHexInput(color.toUpperCase());
    }
  }, [color]);

  // ---- SV Area Interaction ----
  const handleAreaMove = useCallback(
    (e: MouseEvent | React.MouseEvent | TouchEvent | React.TouchEvent) => {
      if (!areaRef.current) return;
      e.preventDefault();
      const { left, top, width, height } =
        areaRef.current.getBoundingClientRect();
      const clientX =
        "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const clientY =
        "touches" in e ? e.touches[0].clientY : (e as MouseEvent).clientY;

      const x = Math.max(0, Math.min(1, (clientX - left) / width));
      const y = Math.max(0, Math.min(1, (clientY - top) / height));

      const next = { ...hsvRef.current, s: x, v: 1 - y };
      setHsv(next);
      hsvRef.current = next;

      const rgb = hsvToRgb(next.h, next.s, next.v);
      const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
      onChange(hex);
      setHexInput(hex.toUpperCase());
    },
    [onChange],
  );

  const handleAreaDown = (e: React.MouseEvent | React.TouchEvent) => {
    handleAreaMove(e);
    const stop = () => {
      document.removeEventListener("mousemove", handleAreaMove);
      document.removeEventListener("mouseup", stop);
      document.removeEventListener("touchmove", handleAreaMove);
      document.removeEventListener("touchend", stop);
    };
    document.addEventListener("mousemove", handleAreaMove);
    document.addEventListener("mouseup", stop);
    document.addEventListener("touchmove", handleAreaMove, { passive: false });
    document.addEventListener("touchend", stop);
  };

  // ---- Hue Slider ----
  const handleHueMove = useCallback(
    (e: MouseEvent | React.MouseEvent | TouchEvent | React.TouchEvent) => {
      if (!hueRef.current) return;
      e.preventDefault();
      const { left, width } = hueRef.current.getBoundingClientRect();
      const clientX =
        "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const x = Math.max(0, Math.min(1, (clientX - left) / width));

      const next = { ...hsvRef.current, h: x };
      setHsv(next);
      hsvRef.current = next;

      const rgb = hsvToRgb(next.h, next.s, next.v);
      const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
      onChange(hex);
      setHexInput(hex.toUpperCase());
    },
    [onChange],
  );

  const handleHueDown = (e: React.MouseEvent | React.TouchEvent) => {
    handleHueMove(e);
    const stop = () => {
      document.removeEventListener("mousemove", handleHueMove);
      document.removeEventListener("mouseup", stop);
      document.removeEventListener("touchmove", handleHueMove);
      document.removeEventListener("touchend", stop);
    };
    document.addEventListener("mousemove", handleHueMove);
    document.addEventListener("mouseup", stop);
    document.addEventListener("touchmove", handleHueMove, { passive: false });
    document.addEventListener("touchend", stop);
  };

  // ---- Alpha Slider ----
  const handleAlphaMove = useCallback(
    (e: MouseEvent | React.MouseEvent | TouchEvent | React.TouchEvent) => {
      if (!alphaRef.current || !onAlphaChange) return;
      e.preventDefault();
      const { left, width } = alphaRef.current.getBoundingClientRect();
      const clientX =
        "touches" in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const a = Math.max(0, Math.min(1, (clientX - left) / width));
      onAlphaChange(Math.round(a * 100) / 100);
    },
    [onAlphaChange],
  );

  const handleAlphaDown = (e: React.MouseEvent | React.TouchEvent) => {
    handleAlphaMove(e);
    const stop = () => {
      document.removeEventListener("mousemove", handleAlphaMove);
      document.removeEventListener("mouseup", stop);
      document.removeEventListener("touchmove", handleAlphaMove);
      document.removeEventListener("touchend", stop);
    };
    document.addEventListener("mousemove", handleAlphaMove);
    document.addEventListener("mouseup", stop);
    document.addEventListener("touchmove", handleAlphaMove, { passive: false });
    document.addEventListener("touchend", stop);
  };

  // ---- Input Handlers ----
  const handleHexInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.toUpperCase();
    setHexInput(val);
    if (/^#?[0-9A-F]{6}$/i.test(val)) {
      const safeVal = val.startsWith("#") ? val : "#" + val;
      onChange(safeVal);
    }
  };

  const handleRgbChange = (channel: "r" | "g" | "b", val: string) => {
    let num = parseInt(val, 10);
    if (isNaN(num)) return;
    num = Math.max(0, Math.min(255, num));
    const rgb = hexToRgb(color) || { r: 0, g: 0, b: 0 };
    rgb[channel] = num;
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    onChange(hex);
  };

  const handleHslChange = (channel: "h" | "s" | "l", val: string) => {
    let num = parseInt(val, 10);
    if (isNaN(num)) return;
    const currentRgb = hexToRgb(color) || { r: 0, g: 0, b: 0 };
    const currentHsl = rgbToHsl(currentRgb.r, currentRgb.g, currentRgb.b);
    if (channel === "h") num = Math.max(0, Math.min(360, num));
    else num = Math.max(0, Math.min(100, num));
    currentHsl[channel] = num;
    const rgb = hslToRgb(currentHsl.h, currentHsl.s, currentHsl.l);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    onChange(hex);
  };

  // ---- Actions ----
  const handleCopy = () => {
    navigator.clipboard.writeText(color.toUpperCase());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleEyeDropper = async () => {
    const sampled = await sampleColorFromScreen();
    if (sampled) {
      onChange(sampled);
      setHexInput(sampled.toUpperCase());
      handleCommitColor(sampled);
    }
  };

  const handleCommitColor = (c: string) => {
    addRecentColor(c);
    setRecentColors(getRecentColors());
    onCommit?.(c);
  };

  const handlePresetClick = (c: string) => {
    onChange(c);
    setHexInput(c.toUpperCase());
    handleCommitColor(c);
  };

  const handleResetToOriginal = () => {
    onChange(originalColor);
    setHexInput(originalColor.toUpperCase());
  };

  // ---- Computed Values ----
  const currentRgb = hexToRgb(color) || { r: 0, g: 0, b: 0 };
  const currentHsl = rgbToHsl(currentRgb.r, currentRgb.g, currentRgb.b);
  const hueColor = rgbToHex(
    hsvToRgb(hsv.h, 1, 1).r,
    hsvToRgb(hsv.h, 1, 1).g,
    hsvToRgb(hsv.h, 1, 1).b,
  );

  const harmonyColors = useMemo(() => {
    return getHarmonyColors(hsv.h, hsv.s, hsv.v);
  }, [hsv.h, hsv.s, hsv.v]);

  // ============================================================
  // COMPACT VARIANT
  // ============================================================
  if (isCompact) {
    return (
      <div className="flex flex-col gap-2 w-full select-none">
        {/* SV Area (smaller) */}
        <div
          ref={areaRef}
          onMouseDown={handleAreaDown}
          onTouchStart={handleAreaDown}
          className="w-full h-[100px] rounded-lg relative overflow-hidden cursor-crosshair ring-1 ring-black/8 dark:ring-white/10"
          style={{ backgroundColor: hueColor }}
        >
          <div className="absolute inset-0 bg-gradient-to-r from-white to-transparent pointer-events-none" />
          <div className="absolute inset-0 bg-gradient-to-t from-black to-transparent pointer-events-none" />
          <div
            className="absolute w-3.5 h-3.5 pointer-events-none"
            style={{
              left: `${hsv.s * 100}%`,
              top: `${(1 - hsv.v) * 100}%`,
              transform: "translate(-50%, -50%)",
            }}
          >
            <div
              className="w-full h-full rounded-full border-2 border-white"
              style={{
                boxShadow:
                  "0 0 0 1px rgba(0,0,0,0.3), 0 2px 4px rgba(0,0,0,0.3)",
              }}
            />
          </div>
        </div>

        {/* Hue slider */}
        <div
          ref={hueRef}
          onMouseDown={handleHueDown}
          onTouchStart={handleHueDown}
          className="w-full h-2.5 rounded-full relative cursor-ew-resize ring-1 ring-black/8 dark:ring-white/10"
          style={{
            background:
              "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)",
          }}
        >
          <div
            className="absolute w-3 h-3 rounded-full border-2 border-white pointer-events-none"
            style={{
              left: `${hsv.h * 100}%`,
              top: "50%",
              transform: "translate(-50%, -50%)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            }}
          />
        </div>

        {/* Alpha (if enabled) */}
        {showAlpha && (
          <div
            ref={alphaRef}
            onMouseDown={handleAlphaDown}
            onTouchStart={handleAlphaDown}
            className="w-full h-2.5 rounded-full relative cursor-ew-resize ring-1 ring-black/8 dark:ring-white/10 overflow-hidden"
          >
            <CheckerBg className="rounded-full" />
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background: `linear-gradient(to right, transparent 0%, ${color} 100%)`,
              }}
            />
            <div
              className="absolute w-3 h-3 rounded-full border-2 border-white pointer-events-none"
              style={{
                left: `${alpha * 100}%`,
                top: "50%",
                transform: "translate(-50%, -50%)",
                boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
              }}
            />
          </div>
        )}

        {/* Compact Inputs: HEX + Eyedropper */}
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={hexInput}
            onChange={handleHexInput}
            onFocus={(e) => e.target.select()}
            onBlur={() => {
              setHexInput(color.toUpperCase());
              handleCommitColor(color);
            }}
            spellCheck={false}
            className="flex-1 bg-zinc-50 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-md px-2 h-6 text-[10px] font-mono font-bold text-center text-zinc-700 dark:text-zinc-300 outline-none focus:border-indigo-500/50 transition-all uppercase"
          />
          {hasEyeDropper && (
            <button
              onClick={handleEyeDropper}
              title="Pick from screen"
              className="flex items-center justify-center w-6 h-6 rounded-md bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-500 hover:text-amber-500 hover:border-amber-400/50 transition-all"
            >
              <Pipette size={11} />
            </button>
          )}
          <button
            onClick={handleCopy}
            title="Copy color"
            className="flex items-center justify-center w-6 h-6 rounded-md bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-all"
          >
            {copied ? (
              <Check size={10} className="text-emerald-500" />
            ) : (
              <Copy size={10} />
            )}
          </button>
        </div>

        {/* Compact Presets */}
        <div className="flex gap-0.5">
          {PRESET_PALETTES["Vibrant"].map((c) => {
            const isActive = color.toLowerCase() === c.toLowerCase();
            return (
              <button
                key={c}
                onClick={() => handlePresetClick(c)}
                className="group flex-1 aspect-square"
                title={c}
              >
                <div
                  className={`w-full h-full rounded transition-all ring-1 ring-inset ring-black/8 dark:ring-white/10
                    ${isActive ? "ring-2 !ring-indigo-500 scale-110 shadow-sm z-10" : "group-hover:scale-110 group-active:scale-95"}`}
                  style={{ backgroundColor: c }}
                />
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ============================================================
  // FULL VARIANT
  // ============================================================
  return (
    <div className="flex flex-col gap-2.5 w-[264px] select-none">
      {/* ===== Saturation/Value Area ===== */}
      <div
        ref={areaRef}
        onMouseDown={handleAreaDown}
        onTouchStart={handleAreaDown}
        className="w-full h-[160px] rounded-xl relative overflow-hidden cursor-crosshair ring-1 ring-black/8 dark:ring-white/10"
        style={{ backgroundColor: hueColor }}
      >
        <div className="absolute inset-0 bg-gradient-to-r from-white to-transparent pointer-events-none" />
        <div className="absolute inset-0 bg-gradient-to-t from-black to-transparent pointer-events-none" />
        {/* Cursor indicator */}
        <div
          className="absolute w-4 h-4 pointer-events-none"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            transform: "translate(-50%, -50%)",
          }}
        >
          <div
            className="w-full h-full rounded-full border-2 border-white"
            style={{
              boxShadow:
                "0 0 0 1px rgba(0,0,0,0.3), inset 0 0 0 1px rgba(0,0,0,0.15), 0 2px 4px rgba(0,0,0,0.3)",
            }}
          />
        </div>
      </div>

      {/* ===== Sliders Section ===== */}
      <div className="flex gap-2.5 items-center">
        {/* Color Preview (Old vs New) */}
        <div className="flex flex-col gap-0 shrink-0">
          <div
            className="w-8 h-4 rounded-t-md ring-1 ring-inset ring-black/10 dark:ring-white/10"
            style={{ backgroundColor: color }}
            title={`Current: ${color}`}
          />
          <div
            className="w-8 h-4 rounded-b-md ring-1 ring-inset ring-black/10 dark:ring-white/10 cursor-pointer hover:ring-2 hover:ring-amber-400/50 transition-all"
            style={{ backgroundColor: originalColor }}
            title={`Original: ${originalColor} — Click to reset`}
            onClick={handleResetToOriginal}
          />
        </div>

        {/* Hue + Alpha Sliders */}
        <div className="flex-1 flex flex-col gap-2">
          {/* Hue */}
          <div
            ref={hueRef}
            onMouseDown={handleHueDown}
            onTouchStart={handleHueDown}
            className="w-full h-3 rounded-full relative cursor-ew-resize ring-1 ring-black/8 dark:ring-white/10"
            style={{
              background:
                "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)",
            }}
          >
            <div
              className="absolute w-[14px] h-[14px] rounded-full border-2 border-white pointer-events-none"
              style={{
                left: `${hsv.h * 100}%`,
                top: "50%",
                transform: "translate(-50%, -50%)",
                boxShadow:
                  "0 1px 3px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.1)",
              }}
            />
          </div>

          {/* Alpha */}
          {showAlpha && (
            <div
              ref={alphaRef}
              onMouseDown={handleAlphaDown}
              onTouchStart={handleAlphaDown}
              className="w-full h-3 rounded-full relative cursor-ew-resize ring-1 ring-black/8 dark:ring-white/10 overflow-hidden"
            >
              <CheckerBg className="rounded-full" />
              <div
                className="absolute inset-0 rounded-full"
                style={{
                  background: `linear-gradient(to right, transparent 0%, ${color} 100%)`,
                }}
              />
              <div
                className="absolute w-[14px] h-[14px] rounded-full border-2 border-white pointer-events-none"
                style={{
                  left: `${alpha * 100}%`,
                  top: "50%",
                  transform: "translate(-50%, -50%)",
                  boxShadow:
                    "0 1px 3px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.1)",
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* ===== Separator ===== */}
      <div className="w-full h-px bg-zinc-200/80 dark:bg-white/8" />

      {/* ===== All Color Inputs (HEX + RGB + HSL) Flattened ===== */}
      <div className="flex flex-col gap-2">
        {/* Row 1: HEX + Copy */}
        <div className="flex items-center gap-1.5">
          <div className="flex-1 flex flex-col gap-0.5">
            <input
              ref={hexInputRef}
              type="text"
              value={hexInput}
              onChange={handleHexInput}
              onFocus={(e) => e.target.select()}
              onBlur={() => {
                setHexInput(color.toUpperCase());
                handleCommitColor(color);
              }}
              spellCheck={false}
              className="w-full bg-zinc-50 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-lg px-2 h-7 text-[11px] font-mono font-bold text-center text-zinc-700 dark:text-zinc-300 outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 transition-all uppercase"
            />
            <span className="text-[8px] font-bold text-zinc-400 text-center tracking-widest uppercase">
              Hex
            </span>
          </div>
          {showAlpha && (
            <div className="w-12 flex flex-col gap-0.5">
              <input
                type="text"
                value={Math.round(alpha * 100)}
                onChange={(e) => {
                  let v = parseInt(e.target.value, 10);
                  if (isNaN(v)) return;
                  v = Math.max(0, Math.min(100, v));
                  onAlphaChange?.(v / 100);
                }}
                onFocus={(e) => e.target.select()}
                className="w-full bg-zinc-50 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-lg px-1 h-7 text-[11px] font-mono font-bold tabular-nums text-center text-zinc-600 dark:text-zinc-400 outline-none focus:border-indigo-500/50 transition-all"
              />
              <span className="text-[8px] font-bold text-zinc-400 text-center uppercase">
                A%
              </span>
            </div>
          )}
          <button
            onClick={handleCopy}
            className="flex items-center justify-center w-7 h-7 rounded-lg bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20 transition-all self-start"
            title="Copy hex color"
          >
            {copied ? (
              <Check size={11} className="text-emerald-500" />
            ) : (
              <Copy size={11} />
            )}
          </button>
        </div>

        {/* Row 2: RGB + Copy */}
        <div className="flex items-center gap-1.5">
          {(["r", "g", "b"] as const).map((ch) => (
            <div key={ch} className="flex-1 flex flex-col gap-0.5">
              <input
                type="text"
                value={currentRgb[ch]}
                onChange={(e) => handleRgbChange(ch, e.target.value)}
                onFocus={(e) => e.target.select()}
                onBlur={() => handleCommitColor(color)}
                className="w-full bg-zinc-50 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-lg px-1 h-6 text-[10px] font-mono font-bold tabular-nums text-center text-zinc-600 dark:text-zinc-400 outline-none focus:border-indigo-500/50 transition-all"
              />
              <span className="text-[8px] font-bold text-zinc-400 text-center uppercase">
                {ch}
              </span>
            </div>
          ))}
          <button
            onClick={() => {
              navigator.clipboard.writeText(
                `rgb(${currentRgb.r}, ${currentRgb.g}, ${currentRgb.b})`,
              );
              setCopiedRgb(true);
              setTimeout(() => setCopiedRgb(false), 1500);
            }}
            className="flex items-center justify-center w-6 h-6 rounded-md bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20 transition-all self-start"
            title="Copy rgb()"
          >
            {copiedRgb ? (
              <Check size={9} className="text-emerald-500" />
            ) : (
              <Copy size={9} />
            )}
          </button>
        </div>

        {/* Row 3: HSL + Copy */}
        <div className="flex items-center gap-1.5">
          <div className="flex-1 flex flex-col gap-0.5">
            <input
              type="text"
              value={currentHsl.h}
              onChange={(e) => handleHslChange("h", e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => handleCommitColor(color)}
              className="w-full bg-zinc-50 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-lg px-1 h-6 text-[10px] font-mono font-bold tabular-nums text-center text-zinc-600 dark:text-zinc-400 outline-none focus:border-indigo-500/50 transition-all"
            />
            <span className="text-[8px] font-bold text-zinc-400 text-center uppercase">
              H°
            </span>
          </div>
          <div className="flex-1 flex flex-col gap-0.5">
            <input
              type="text"
              value={currentHsl.s}
              onChange={(e) => handleHslChange("s", e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => handleCommitColor(color)}
              className="w-full bg-zinc-50 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-lg px-1 h-6 text-[10px] font-mono font-bold tabular-nums text-center text-zinc-600 dark:text-zinc-400 outline-none focus:border-indigo-500/50 transition-all"
            />
            <span className="text-[8px] font-bold text-zinc-400 text-center uppercase">
              S%
            </span>
          </div>
          <div className="flex-1 flex flex-col gap-0.5">
            <input
              type="text"
              value={currentHsl.l}
              onChange={(e) => handleHslChange("l", e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => handleCommitColor(color)}
              className="w-full bg-zinc-50 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-lg px-1 h-6 text-[10px] font-mono font-bold tabular-nums text-center text-zinc-600 dark:text-zinc-400 outline-none focus:border-indigo-500/50 transition-all"
            />
            <span className="text-[8px] font-bold text-zinc-400 text-center uppercase">
              L%
            </span>
          </div>
          <button
            onClick={() => {
              navigator.clipboard.writeText(
                `hsl(${currentHsl.h}, ${currentHsl.s}%, ${currentHsl.l}%)`,
              );
              setCopiedHsl(true);
              setTimeout(() => setCopiedHsl(false), 1500);
            }}
            className="flex items-center justify-center w-6 h-6 rounded-md bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20 transition-all self-start"
            title="Copy hsl()"
          >
            {copiedHsl ? (
              <Check size={9} className="text-emerald-500" />
            ) : (
              <Copy size={9} />
            )}
          </button>
        </div>
      </div>

      {/* ===== Separator ===== */}
      <div className="w-full h-px bg-zinc-200/80 dark:bg-white/8" />

      {/* ===== Preset Palettes ===== */}
      <div className="flex flex-col gap-1.5">
        {/* Palette Tabs */}
        <div className="flex items-center gap-1">
          {(
            Object.keys(PRESET_PALETTES) as (keyof typeof PRESET_PALETTES)[]
          ).map((name) => (
            <button
              key={name}
              onClick={() => setActivePalette(name)}
              className={`px-2 py-0.5 rounded text-[9px] font-semibold transition-all
                ${
                  activePalette === name
                    ? "text-zinc-700 dark:text-zinc-200 bg-zinc-200/60 dark:bg-white/10"
                    : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                }`}
            >
              {name}
            </button>
          ))}
        </div>

        {/* Palette Grid */}
        <div className="flex gap-1 px-0.5">
          {PRESET_PALETTES[activePalette].map((c) => {
            const isActive = color.toLowerCase() === c.toLowerCase();
            return (
              <button
                key={c}
                onClick={() => handlePresetClick(c)}
                className="group relative flex-1 aspect-square flex items-center justify-center"
                title={c}
              >
                <div
                  className={`w-full h-full rounded-md transition-all ring-1 ring-inset ring-black/8 dark:ring-white/10
                    ${
                      isActive
                        ? "ring-2 !ring-indigo-500 scale-110 shadow-md z-10"
                        : "group-hover:scale-110 group-hover:shadow-md group-hover:z-10 group-active:scale-95"
                    }`}
                  style={{ backgroundColor: c }}
                />
              </button>
            );
          })}
        </div>
      </div>

      {/* ===== Recent Colors ===== */}
      {showRecents && recentColors.length > 0 && (
        <>
          <div className="w-full h-px bg-zinc-200/80 dark:bg-white/8" />
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-semibold text-zinc-400 uppercase tracking-wider">
                Recent
              </span>
              <button
                onClick={() => {
                  localStorage.removeItem(RECENT_COLORS_KEY);
                  setRecentColors([]);
                }}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                title="Clear recent colors"
              >
                <RotateCcw size={9} />
              </button>
            </div>
            <div className="flex gap-1 px-0.5 flex-wrap">
              {recentColors.map((c, i) => (
                <button
                  key={`${c}-${i}`}
                  onClick={() => handlePresetClick(c)}
                  className="group"
                  title={c}
                >
                  <div
                    className="w-5 h-5 rounded-md ring-1 ring-inset ring-black/8 dark:ring-white/10 transition-all group-hover:scale-110 group-hover:shadow-sm group-active:scale-95"
                    style={{ backgroundColor: c }}
                  />
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ===== Color Harmony ===== */}
      {showHarmony && (
        <>
          <div className="w-full h-px bg-zinc-200/80 dark:bg-white/8" />
          <div className="flex flex-col gap-1.5">
            <button
              onClick={() => setShowHarmonyPanel(!showHarmonyPanel)}
              className="flex items-center gap-1 text-[9px] font-semibold text-zinc-400 uppercase tracking-wider hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
            >
              <span>Harmony</span>
              <svg
                className={`w-2.5 h-2.5 transition-transform ${showHarmonyPanel ? "rotate-180" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={3}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            {showHarmonyPanel && (
              <div className="flex flex-col gap-2 animate-in fade-in slide-in-from-top-1 duration-200">
                {harmonyColors.map((group) => (
                  <div key={group.label} className="flex items-center gap-2">
                    <span className="text-[8px] font-medium text-zinc-400 w-16 shrink-0 truncate">
                      {group.label}
                    </span>
                    <div className="flex gap-0.5 flex-1">
                      {group.colors.map((c, i) => (
                        <button
                          key={`${group.label}-${i}`}
                          onClick={() => handlePresetClick(c)}
                          className="group flex-1"
                          title={c}
                        >
                          <div
                            className="w-full h-4 rounded-sm ring-1 ring-inset ring-black/8 dark:ring-white/10 transition-all group-hover:scale-y-125 group-active:scale-95"
                            style={{ backgroundColor: c }}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
