import React from "react";

interface SvAreaProps {
  areaRef: React.RefObject<HTMLDivElement | null>;
  hueColor: string;
  s: number;
  v: number;
  heightClass?: string;
  cursorSizeClass?: string;
  onMouseDown: (e: React.MouseEvent | React.TouchEvent) => void;
}

export function SvArea({
  areaRef,
  hueColor,
  s,
  v,
  heightClass = "h-[140px]",
  cursorSizeClass = "w-4 h-4",
  onMouseDown,
}: SvAreaProps) {
  return (
    <div
      ref={areaRef}
      onMouseDown={onMouseDown}
      onTouchStart={onMouseDown}
      className={`w-full ${heightClass} rounded-xl relative overflow-hidden cursor-crosshair ring-1 ring-black/8 dark:ring-white/10`}
      style={{ backgroundColor: hueColor }}
    >
      <div className="absolute inset-0 bg-gradient-to-r from-white to-transparent pointer-events-none" />
      <div className="absolute inset-0 bg-gradient-to-t from-black to-transparent pointer-events-none" />
      {/* Cursor indicator */}
      <div
        className={`absolute ${cursorSizeClass} pointer-events-none`}
        style={{
          left: `${s * 100}%`,
          top: `${(1 - v) * 100}%`,
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
  );
}
