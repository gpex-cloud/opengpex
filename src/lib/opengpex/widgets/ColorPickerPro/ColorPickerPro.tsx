import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { Copy, Check } from "lucide-react";
import {
  hsvToRgb,
  rgbToHsv,
  rgbToHsl,
  hslToRgb,
  rgbToHex,
  hexToRgb,
  type ColorValue,
  colorFromHsv,
  convertColorGamut,
  fromHex,
  toCssColor4,
} from "@opengpex/editor/core/engine/color";
import type { GamutId } from "@opengpex/editor/core/types/primitives";

import type { ColorPickerProProps } from "./types";
import {
  PRESET_PALETTES,
  getRecentColors,
  addRecentColor,
  getHarmonyColors,
} from "./constants";
import { SvArea } from "./components/SvArea";
import { Sliders } from "./components/Sliders";
import { NumericInputs } from "./components/NumericInputs";
import { ProGamutSection } from "./components/ProGamutSection";
import { PalettesSection } from "./components/PalettesSection";
import { CompactPicker } from "./components/CompactPicker";

export function ColorPickerPro({
  color,
  onChange,
  onCommit,
  value,
  onValueChange,
  onValueCommit,
  enablePro = false,
  frameGamut = "srgb",
  autoExpandPro = false,
  showAlpha = false,
  alpha = 1,
  onAlphaChange,
  showHarmony = true,
  showRecents = true,
  variant = "full",
  headerRight,
}: ColorPickerProProps) {
  // ── Structured vs legacy string mode ──
  const structured = value !== undefined;
  const activeValue: ColorValue = value ?? fromHex(color || "#000000");
  const activeAlpha = structured ? activeValue.alpha : alpha;

  // Pro / wide-gamut disclosure
  const proAvailable = enablePro && structured && variant === "full";
  const shouldAutoExpand = autoExpandPro && proAvailable;
  const [proMode, setProMode] = useState(() => shouldAutoExpand);
  // Auto-expand only ever turns Pro ON — never collapses a panel the
  // user, or an earlier auto-expand, already opened. Adjusted during render
  // (React's "adjusting state on prop change" pattern) rather than in a
  // useEffect, so it reacts to `frameGamut`/bitDepth changes (e.g. a frame
  // switch) without an extra setState-in-effect render pass.
  const [lastAutoExpand, setLastAutoExpand] = useState(shouldAutoExpand);
  if (shouldAutoExpand !== lastAutoExpand) {
    setLastAutoExpand(shouldAutoExpand);
    if (shouldAutoExpand) setProMode(true);
  }
  const isPro = proAvailable && proMode;

  // Inspecting (switching frame / opening panel) never mutates: panel gamut = current frame gamut
  // (the `frameGamut` prop), never `value.space`, never user-switchable.
  // Display is a pure derived view; `pendingColor` itself never moves here.
  const viewGamut: GamutId = isPro ? frameGamut : "srgb";
  const displayValue: ColorValue = structured
    ? convertColorGamut(activeValue, viewGamut)
    : activeValue;
  const colorHex = displayValue.hex;

  const [hsv, setHsv] = useState({ h: 0, s: 0, v: 1 });
  const [hexInput, setHexInput] = useState(colorHex);
  const [copied, setCopied] = useState(false);
  const [originalColor] = useState(colorHex);
  const [recentColors, setRecentColors] = useState<string[]>(getRecentColors);
  const [showHarmonyPanel, setShowHarmonyPanel] = useState(false);
  const [activePalette, setActivePalette] =
    useState<keyof typeof PRESET_PALETTES>("Vibrant");

  const hsvRef = useRef({ h: 0, s: 0, v: 1 });
  const areaRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const alphaRef = useRef<HTMLDivElement>(null);
  const hexInputRef = useRef<HTMLInputElement>(null);

  const isCompact = variant === "compact";

  // ── Emit adapters ──
  const emitChange = useCallback(
    (v: ColorValue) => {
      onValueChange?.(v);
      onChange?.(v.hex);
    },
    [onValueChange, onChange],
  );

  const emitCommit = useCallback(
    (v: ColorValue) => {
      onValueCommit?.(v);
      onCommit?.(v.hex);
    },
    [onValueCommit, onCommit],
  );

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

  // Sync internal HSV from the DISPLAY value (§5.4: the view, never the raw
  // working-space storage) — so the SV/Hue cursor position matches what the
  // panel actually shows in Simple (sRGB) or Pro (frameGamut) mode.
  const c = displayValue.coords;
  const syncKey = `${displayValue.space}:${c.r},${c.g},${c.b}`;
  useEffect(() => {
    const newHsv = rgbToHsv(c.r * 255, c.g * 255, c.b * 255);
    setHsv((prev) => {
      const nextHsv = {
        h: newHsv.s === 0 ? prev.h : newHsv.h,
        s: newHsv.s,
        v: newHsv.v,
      };
      hsvRef.current = nextHsv;
      return nextHsv;
    });
    setHexInput(colorHex.toUpperCase());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey]);

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

      const cv = colorFromHsv(next.h, next.s, next.v, viewGamut, activeAlpha);
      emitChange(cv);
      setHexInput(cv.hex.toUpperCase());
    },
    [emitChange, viewGamut, activeAlpha],
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

  // ---- Hue Slider Interaction ----
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

      const cv = colorFromHsv(next.h, next.s, next.v, viewGamut, activeAlpha);
      emitChange(cv);
      setHexInput(cv.hex.toUpperCase());
    },
    [emitChange, viewGamut, activeAlpha],
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

  // ---- Alpha Slider Interaction ----
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
    const raw = e.target.value.toUpperCase();
    const clean = raw.replace(/^#/, "").slice(0, 6);
    setHexInput("#" + clean);
    if (/^[0-9A-F]{6}$/i.test(clean)) {
      emitChange(fromHex("#" + clean, activeAlpha));
    }
  };

  const handleRgbChange = (channel: "r" | "g" | "b", val: string) => {
    let num = parseInt(val, 10);
    if (isNaN(num)) return;
    num = Math.max(0, Math.min(255, num));
    const rgb = hexToRgb(colorHex) || { r: 0, g: 0, b: 0 };
    rgb[channel] = num;
    emitChange(fromHex(rgbToHex(rgb.r, rgb.g, rgb.b), activeAlpha));
  };

  const handleHslChange = (channel: "h" | "s" | "l", val: string) => {
    let num = parseInt(val, 10);
    if (isNaN(num)) return;
    const currentRgb = hexToRgb(colorHex) || { r: 0, g: 0, b: 0 };
    const currentHsl = rgbToHsl(currentRgb.r, currentRgb.g, currentRgb.b);
    if (channel === "h") num = Math.max(0, Math.min(360, num));
    else num = Math.max(0, Math.min(100, num));
    currentHsl[channel] = num;
    const rgb = hslToRgb(currentHsl.h, currentHsl.s, currentHsl.l);
    emitChange(fromHex(rgbToHex(rgb.r, rgb.g, rgb.b), activeAlpha));
  };

  // ---- Actions ----
  const handleCopy = () => {
    navigator.clipboard.writeText(colorHex.toUpperCase());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleCommitColor = (cStr: string) => {
    addRecentColor(cStr);
    setRecentColors(getRecentColors());
    emitCommit(fromHex(cStr, activeAlpha));
  };

  const handlePresetClick = (cStr: string) => {
    emitChange(fromHex(cStr, activeAlpha));
    setHexInput(cStr.toUpperCase());
    handleCommitColor(cStr);
  };

  const handleResetToOriginal = () => {
    emitChange(fromHex(originalColor, activeAlpha));
    setHexInput(originalColor.toUpperCase());
  };

  // ---- Computed Values ----
  const currentRgb = hexToRgb(colorHex) || { r: 0, g: 0, b: 0 };
  const currentHsl = rgbToHsl(currentRgb.r, currentRgb.g, currentRgb.b);
  const hueColor = rgbToHex(
    hsvToRgb(hsv.h, 1, 1).r,
    hsvToRgb(hsv.h, 1, 1).g,
    hsvToRgb(hsv.h, 1, 1).b,
  );

  const harmonyColors = useMemo(() => {
    return getHarmonyColors(hsv.h, hsv.s, hsv.v);
  }, [hsv.h, hsv.s, hsv.v]);

  const previewCss =
    structured && viewGamut !== "srgb"
      ? toCssColor4(displayValue)
      : colorHex;
  const cssReadout = toCssColor4(displayValue);

  // ============================================================
  // COMPACT VARIANT
  // ============================================================
  if (isCompact) {
    return (
      <CompactPicker
        areaRef={areaRef}
        hueRef={hueRef}
        alphaRef={alphaRef}
        hsv={hsv}
        hueColor={hueColor}
        colorHex={colorHex}
        showAlpha={showAlpha}
        alpha={alpha}
        hexInput={hexInput}
        copied={copied}
        onAreaDown={handleAreaDown}
        onHueDown={handleHueDown}
        onAlphaDown={handleAlphaDown}
        onHexInput={handleHexInput}
        onCopy={handleCopy}
        onCommitColor={handleCommitColor}
        setHexInput={setHexInput}
        onPresetClick={handlePresetClick}
      />
    );
  }

  // ============================================================
  // FULL VARIANT
  // ============================================================
  return (
    <div className="flex flex-col gap-2.5 w-[264px] select-none">
      {/* ===== Header Row: HEX (+ Alpha) + Copy + headerRight (Pin) ===== */}
      <div className="flex items-center gap-1.5 w-full">
        <div className="flex-1 flex items-center bg-zinc-50 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-lg px-2 h-7 focus-within:border-indigo-500/50 focus-within:ring-1 focus-within:ring-indigo-500/20 transition-all">
          <span className="text-[9px] font-bold text-zinc-400 select-none mr-1 uppercase">
            HEX:
          </span>
          <input
            ref={hexInputRef}
            type="text"
            value={hexInput.replace(/^#/, "")}
            onChange={handleHexInput}
            onFocus={(e) => e.target.select()}
            onBlur={() => {
              setHexInput(colorHex.toUpperCase());
              handleCommitColor(colorHex);
            }}
            spellCheck={false}
            className="w-full bg-transparent text-[11px] font-mono font-bold text-zinc-700 dark:text-zinc-300 outline-none uppercase placeholder:text-zinc-400"
            placeholder="000000"
          />
        </div>

        {showAlpha && (
          <div className="w-13 flex items-center bg-zinc-50 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-lg px-1.5 h-7 focus-within:border-indigo-500/50 focus-within:ring-1 focus-within:ring-indigo-500/20 transition-all">
            <span className="text-[9px] font-bold text-zinc-400 select-none mr-0.5">
              A:
            </span>
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
              className="w-full bg-transparent text-[10px] font-mono font-bold tabular-nums text-center text-zinc-600 dark:text-zinc-400 outline-none"
            />
            <span className="text-[8px] font-bold text-zinc-400 select-none">
              %
            </span>
          </div>
        )}

        <button
          onClick={handleCopy}
          className="flex items-center justify-center w-7 h-7 rounded-lg bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20 transition-all shrink-0"
          title="Copy hex color"
        >
          {copied ? (
            <Check size={11} className="text-emerald-500" />
          ) : (
            <Copy size={11} />
          )}
        </button>

        {headerRight && (
          <div className="flex items-center shrink-0">{headerRight}</div>
        )}
      </div>

      {/* ===== Saturation/Value Area ===== */}
      <SvArea
        areaRef={areaRef}
        hueColor={hueColor}
        s={hsv.s}
        v={hsv.v}
        heightClass="h-[140px]"
        cursorSizeClass="w-4 h-4"
        onMouseDown={handleAreaDown}
      />

      {/* ===== Sliders Section ===== */}
      <Sliders
        hueRef={hueRef}
        alphaRef={alphaRef}
        hsv={hsv}
        colorHex={colorHex}
        previewCss={previewCss}
        cssReadout={cssReadout}
        originalColor={originalColor}
        showAlpha={showAlpha}
        alpha={alpha}
        onHueDown={handleHueDown}
        onAlphaDown={handleAlphaDown}
        onResetToOriginal={handleResetToOriginal}
      />

      {/* ===== Separator ===== */}
      <div className="w-full h-px bg-zinc-200/80 dark:bg-white/8" />

      {/* ===== RGB & HSL Rows (with inline labels) ===== */}
      <NumericInputs
        currentRgb={currentRgb}
        currentHsl={currentHsl}
        colorHex={colorHex}
        onRgbChange={handleRgbChange}
        onHslChange={handleHslChange}
        onCommitColor={handleCommitColor}
      />

      {/* ===== Pro · Wide Gamut ===== */}
      {proAvailable && (
        <ProGamutSection
          proMode={proMode}
          onToggleProMode={() => setProMode((v) => !v)}
          gamut={viewGamut}
          coords={c}
          alpha={activeAlpha}
          cssReadout={cssReadout}
        />
      )}

      {/* ===== Palettes, Recents & Harmony ===== */}
      <PalettesSection
        colorHex={colorHex}
        activePalette={activePalette}
        setActivePalette={setActivePalette}
        showRecents={showRecents}
        recentColors={recentColors}
        onClearRecents={() => {
          localStorage.removeItem("gpex-recent-colors");
          setRecentColors([]);
        }}
        showHarmony={showHarmony}
        showHarmonyPanel={showHarmonyPanel}
        setShowHarmonyPanel={setShowHarmonyPanel}
        harmonyColors={harmonyColors}
        onSelectColor={handlePresetClick}
      />
    </div>
  );
}
