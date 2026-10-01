import React from "react";
import { Check, Copy } from "lucide-react";
import { CheckerBg } from "./CheckerBg";
import { PRESET_PALETTES } from "../constants";

interface CompactPickerProps {
  areaRef: React.RefObject<HTMLDivElement | null>;
  hueRef: React.RefObject<HTMLDivElement | null>;
  alphaRef: React.RefObject<HTMLDivElement | null>;
  hsv: { h: number; s: number; v: number };
  hueColor: string;
  colorHex: string;
  showAlpha: boolean;
  alpha: number;
  hexInput: string;
  copied: boolean;
  onAreaDown: (e: React.MouseEvent | React.TouchEvent) => void;
  onHueDown: (e: React.MouseEvent | React.TouchEvent) => void;
  onAlphaDown: (e: React.MouseEvent | React.TouchEvent) => void;
  onHexInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onCopy: () => void;
  onCommitColor: (c: string) => void;
  setHexInput: (val: string) => void;
  onPresetClick: (c: string) => void;
}

export function CompactPicker({
  areaRef,
  hueRef,
  alphaRef,
  hsv,
  hueColor,
  colorHex,
  showAlpha,
  alpha,
  hexInput,
  copied,
  onAreaDown,
  onHueDown,
  onAlphaDown,
  onHexInput,
  onCopy,
  onCommitColor,
  setHexInput,
  onPresetClick,
}: CompactPickerProps) {
  return (
    <div className="flex flex-col gap-2 w-full select-none">
      {/* SV Area (smaller) */}
      <div
        ref={areaRef}
        onMouseDown={onAreaDown}
        onTouchStart={onAreaDown}
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
        onMouseDown={onHueDown}
        onTouchStart={onHueDown}
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
          onMouseDown={onAlphaDown}
          onTouchStart={onAlphaDown}
          className="w-full h-2.5 rounded-full relative cursor-ew-resize ring-1 ring-black/8 dark:ring-white/10 overflow-hidden"
        >
          <CheckerBg className="rounded-full" />
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background: `linear-gradient(to right, transparent 0%, ${colorHex} 100%)`,
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

      {/* Compact Inputs: HEX + Copy */}
      <div className="flex items-center gap-1.5">
        <div className="flex-1 flex items-center bg-zinc-50 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-md px-1.5 h-6 focus-within:border-indigo-500/50 transition-all">
          <span className="text-[9px] font-bold text-zinc-400 select-none mr-1 uppercase">
            HEX:
          </span>
          <input
            type="text"
            value={hexInput.replace(/^#/, "")}
            onChange={onHexInput}
            onFocus={(e) => e.target.select()}
            onBlur={() => {
              setHexInput(colorHex.toUpperCase());
              onCommitColor(colorHex);
            }}
            spellCheck={false}
            className="w-full bg-transparent text-[10px] font-mono font-bold text-zinc-700 dark:text-zinc-300 outline-none uppercase placeholder:text-zinc-400"
            placeholder="000000"
          />
        </div>
        <button
          onClick={onCopy}
          title="Copy color"
          className="flex items-center justify-center w-6 h-6 rounded-md bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-all shrink-0"
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
          const isActive = colorHex.toLowerCase() === c.toLowerCase();
          return (
            <button
              key={c}
              onClick={() => onPresetClick(c)}
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
