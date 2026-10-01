import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import ChannelInput from "@opengpex/editor/widgets/ChannelInput";

interface NumericInputsProps {
  currentRgb: { r: number; g: number; b: number };
  currentHsl: { h: number; s: number; l: number };
  colorHex: string;
  onRgbChange: (channel: "r" | "g" | "b", val: string) => void;
  onHslChange: (channel: "h" | "s" | "l", val: string) => void;
  onCommitColor: (c: string) => void;
}

export function NumericInputs({
  currentRgb,
  currentHsl,
  colorHex,
  onRgbChange,
  onHslChange,
  onCommitColor,
}: NumericInputsProps) {
  const [copiedRgb, setCopiedRgb] = useState(false);
  const [copiedHsl, setCopiedHsl] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      {/* Row 1: RGB + Copy */}
      <div className="flex items-center gap-1.5">
        <ChannelInput
          readOnly={false}
          onChannelChange={(ch, val) => onRgbChange(ch as "r" | "g" | "b", val)}
          onCommit={() => onCommitColor(colorHex)}
          channels={(["r", "g", "b"] as const).map((ch) => ({
            key: ch,
            label: `${ch.toUpperCase()}:`,
            value: currentRgb[ch],
          }))}
        />
        <button
          onClick={() => {
            navigator.clipboard.writeText(
              `rgb(${currentRgb.r}, ${currentRgb.g}, ${currentRgb.b})`,
            );
            setCopiedRgb(true);
            setTimeout(() => setCopiedRgb(false), 1500);
          }}
          className="flex items-center justify-center w-6 h-6 rounded-md bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20 transition-all shrink-0"
          title="Copy rgb()"
        >
          {copiedRgb ? (
            <Check size={9} className="text-emerald-500" />
          ) : (
            <Copy size={9} />
          )}
        </button>
      </div>

      {/* Row 2: HSL + Copy */}
      <div className="flex items-center gap-1.5">
        <ChannelInput
          readOnly={false}
          onChannelChange={(ch, val) => onHslChange(ch as "h" | "s" | "l", val)}
          onCommit={() => onCommitColor(colorHex)}
          channels={[
            { key: "h", label: "H:", value: currentHsl.h, suffix: "°" },
            { key: "s", label: "S:", value: currentHsl.s, suffix: "%" },
            { key: "l", label: "L:", value: currentHsl.l, suffix: "%" },
          ]}
        />
        <button
          onClick={() => {
            navigator.clipboard.writeText(
              `hsl(${currentHsl.h}, ${currentHsl.s}%, ${currentHsl.l}%)`,
            );
            setCopiedHsl(true);
            setTimeout(() => setCopiedHsl(false), 1500);
          }}
          className="flex items-center justify-center w-6 h-6 rounded-md bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:border-zinc-300 dark:hover:border-white/20 transition-all shrink-0"
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
  );
}
