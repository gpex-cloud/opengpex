import React from "react";
import { CheckerBg } from "./CheckerBg";

interface SlidersProps {
  hueRef: React.RefObject<HTMLDivElement | null>;
  alphaRef?: React.RefObject<HTMLDivElement | null>;
  hsv: { h: number; s: number; v: number };
  colorHex: string;
  previewCss: string;
  cssReadout: string;
  originalColor: string;
  showAlpha: boolean;
  alpha: number;
  onHueDown: (e: React.MouseEvent | React.TouchEvent) => void;
  onAlphaDown?: (e: React.MouseEvent | React.TouchEvent) => void;
  onResetToOriginal: () => void;
}

export function Sliders({
  hueRef,
  alphaRef,
  hsv,
  colorHex,
  previewCss,
  cssReadout,
  originalColor,
  showAlpha,
  alpha,
  onHueDown,
  onAlphaDown,
  onResetToOriginal,
}: SlidersProps) {
  return (
    <div className="flex gap-2 items-center">
      {/* Color Preview (Old vs New) */}
      <div className="flex flex-col gap-0 shrink-0">
        <div
          className="w-7 h-3.5 rounded-t-md ring-1 ring-inset ring-black/10 dark:ring-white/10"
          style={{ backgroundColor: previewCss }}
          title={`Current: ${cssReadout}`}
        />
        <div
          className="w-7 h-3.5 rounded-b-md ring-1 ring-inset ring-black/10 dark:ring-white/10 cursor-pointer hover:ring-2 hover:ring-amber-400/50 transition-all"
          style={{ backgroundColor: originalColor }}
          title={`Original: ${originalColor} — Click to reset`}
          onClick={onResetToOriginal}
        />
      </div>

      {/* Hue + Alpha Sliders */}
      <div className="flex-1 flex flex-col gap-2">
        {/* Hue */}
        <div
          ref={hueRef}
          onMouseDown={onHueDown}
          onTouchStart={onHueDown}
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
              boxShadow: "0 1px 3px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.1)",
            }}
          />
        </div>

        {/* Alpha */}
        {showAlpha && alphaRef && onAlphaDown && (
          <div
            ref={alphaRef}
            onMouseDown={onAlphaDown}
            onTouchStart={onAlphaDown}
            className="w-full h-3 rounded-full relative cursor-ew-resize ring-1 ring-black/8 dark:ring-white/10 overflow-hidden"
          >
            <CheckerBg className="rounded-full" />
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background: `linear-gradient(to right, transparent 0%, ${colorHex} 100%)`,
              }}
            />
            <div
              className="absolute w-[14px] h-[14px] rounded-full border-2 border-white pointer-events-none"
              style={{
                left: `${alpha * 100}%`,
                top: "50%",
                transform: "translate(-50%, -50%)",
                boxShadow: "0 1px 3px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.1)",
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
