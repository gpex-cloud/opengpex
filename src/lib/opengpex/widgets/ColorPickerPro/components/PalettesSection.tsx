import React from "react";
import { RotateCcw } from "lucide-react";
import { PRESET_PALETTES } from "../constants";

interface PalettesSectionProps {
  colorHex: string;
  activePalette: keyof typeof PRESET_PALETTES;
  setActivePalette: (name: keyof typeof PRESET_PALETTES) => void;
  showRecents: boolean;
  recentColors: string[];
  onClearRecents: () => void;
  showHarmony: boolean;
  showHarmonyPanel: boolean;
  setShowHarmonyPanel: React.Dispatch<React.SetStateAction<boolean>>;
  harmonyColors: { label: string; colors: string[] }[];
  onSelectColor: (c: string) => void;
}

export function PalettesSection({
  colorHex,
  activePalette,
  setActivePalette,
  showRecents,
  recentColors,
  onClearRecents,
  showHarmony,
  showHarmonyPanel,
  setShowHarmonyPanel,
  harmonyColors,
  onSelectColor,
}: PalettesSectionProps) {
  return (
    <>
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
            const isActive = colorHex.toLowerCase() === c.toLowerCase();
            return (
              <button
                key={c}
                onClick={() => onSelectColor(c)}
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
                onClick={onClearRecents}
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
                  onClick={() => onSelectColor(c)}
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
                          onClick={() => onSelectColor(c)}
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
    </>
  );
}
