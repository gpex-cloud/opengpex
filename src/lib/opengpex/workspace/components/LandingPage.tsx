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

"use client";

import { useMemo } from "react";
import PluginSlot from "./PluginSlot";

/**
 * Color palette for randomized orbs — soft, creative tones.
 * Each orb picks ONE color from this palette.
 */
const ORB_PALETTE = [
  "#818cf8", // indigo-400
  "#a78bfa", // violet-400
  "#c084fc", // purple-400
  "#f9a8d4", // pink-300
  "#67e8f9", // cyan-300
  "#7dd3fc", // sky-300
  "#6ee7b7", // emerald-300
  "#fcd34d", // amber-300
  "#fca5a5", // red-300
  "#c4b5fd", // violet-300
];

/** Generate N randomized orbs. Runs once per mount — zero runtime cost after. */
function generateOrbs(count: number) {
  const orbs = [];
  const usedColors = new Set<number>();

  for (let i = 0; i < count; i++) {
    // Pick a unique color index
    let colorIdx: number;
    do {
      colorIdx = Math.floor(Math.random() * ORB_PALETTE.length);
    } while (usedColors.has(colorIdx) && usedColors.size < ORB_PALETTE.length);
    usedColors.add(colorIdx);

    const size = 12 + Math.random() * 25; // 12% - 37%
    const top = 8 + Math.random() * 65; // 8% - 73%
    const left = 5 + Math.random() * 75; // 5% - 80%
    const duration = 14 + Math.random() * 14; // 14s - 28s
    const delay = Math.random() * 8; // 0s - 8s
    const opacity = 0.04 + Math.random() * 0.07; // 0.04 - 0.11
    const opacityDark = opacity * 1.6; // slightly brighter in dark mode

    orbs.push({
      color: ORB_PALETTE[colorIdx],
      size: `${size}%`,
      top: `${top}%`,
      left: `${left}%`,
      duration: `${duration.toFixed(1)}s`,
      delay: `${delay.toFixed(1)}s`,
      opacity,
      opacityDark,
      reverse: Math.random() > 0.5,
    });
  }
  return orbs;
}

/**
 * LandingPage: Photoshop-inspired creative start screen.
 * Two-column centered layout: left = actions, right = screenshot with smooth edge fading.
 * All decorative elements use radial/linear gradient masks — no hard edges.
 *
 * Performance: orb generation is O(n) one-shot on mount via useMemo.
 * All animations are pure CSS (GPU compositor layer — transform + opacity only).
 * No requestAnimationFrame or JS animation loop.
 */
export const LandingPage = () => {
  // Generate randomized orbs once per component mount
  const orbs = useMemo(() => generateOrbs(6), []);

  return (
  <div className="absolute inset-0 flex items-center justify-center select-none overflow-hidden">
    {/* ─── Edge Vignette: ensures ALL decorations fade before hitting container edges ─── */}
    <div
      className="absolute inset-0 pointer-events-none z-[1]"
      style={{
        boxShadow: "inset 0 0 80px 40px var(--bg-stage)",
      }}
    />

    {/* ─── Randomized Background Orbs (regenerated each mount) ─── */}
    {orbs.map((orb, i) => (
      <div
        key={i}
        className="absolute rounded-full pointer-events-none"
        style={{
          top: orb.top,
          left: orb.left,
          width: orb.size,
          height: orb.size,
          opacity: orb.opacity,
          background: `radial-gradient(circle, ${orb.color} 0%, transparent 55%)`,
          animation: `drift ${orb.duration} ease-in-out ${orb.delay} infinite ${orb.reverse ? "reverse" : "normal"}`,
        }}
      />
    ))}

    {/* ─── Decorative Mesh Grid (subtle creative texture) ─── */}
    <div
      className="absolute inset-[10%] opacity-[0.02] dark:opacity-[0.04]"
      style={{
        backgroundImage: `
          linear-gradient(rgba(99,102,241,0.3) 1px, transparent 1px),
          linear-gradient(90deg, rgba(99,102,241,0.3) 1px, transparent 1px)
        `,
        backgroundSize: "60px 60px",
        maskImage:
          "radial-gradient(ellipse 80% 80% at 50% 50%, black 10%, transparent 60%)",
        WebkitMaskImage:
          "radial-gradient(ellipse 80% 80% at 50% 50%, black 10%, transparent 60%)",
      }}
    />

    {/* ─── Centered Two-Column Layout ─── */}
    <div className="relative z-10 flex flex-col lg:flex-row items-center justify-center gap-8 lg:gap-12 w-full max-w-5xl px-8">
      {/* Left: Content (Plugin Slot) */}
      <div className="flex-shrink-0 w-full lg:w-auto lg:max-w-md">
        <PluginSlot name="LANDING_PAGE">
          {/* Fallback if no plugin contribution */}
          <div className="text-center lg:text-left space-y-4">
            <h2 className="text-2xl font-black text-[var(--text-main)] tracking-tighter leading-none">
              Welcome to OpenGPEX
            </h2>
            <p className="text-xs text-[var(--text-muted)]">
              Open or drag an image to begin editing
            </p>
          </div>
        </PluginSlot>
      </div>

      {/* Right: Hero image with blend mode + float animation */}
      <div className="hidden lg:block flex-1 max-w-[400px] relative animate-[fadeInScale_1s_ease-out_0.3s_both]">
        {/* Ambient glow behind (syncs with image) */}
        <div
          className="absolute inset-[-20%] -z-10 animate-[breathe_6s_ease-in-out_infinite]"
          style={{
            background:
              "radial-gradient(ellipse 50% 45% at 50% 50%, #a78bfa 0%, transparent 65%)",
            opacity: 0.15,
            filter: "blur(40px)",
          }}
        />

        {/* The image: mix-blend-mode screen makes black → transparent */}
        {/* <img
          src="/screenshot.webp"
          alt=""
          className="w-full aspect-[3/4] object-cover animate-[float_8s_ease-in-out_infinite]"
          draggable={false}
          style={{
            mixBlendMode: "screen",
            maskImage:
              "radial-gradient(ellipse 75% 72% at 50% 45%, black 50%, transparent 95%)",
            WebkitMaskImage:
              "radial-gradient(ellipse 75% 72% at 50% 45%, black 50%, transparent 95%)",
            filter: "contrast(1.1) brightness(1.05)",
          }}
          onError={(e) => {
            const img = e.target as HTMLImageElement;
            if (img.src.endsWith(".webp")) {
              img.src = "/screenshot.png";
            } else {
              (img.parentElement as HTMLElement).style.display = "none";
            }
          }}
        /> */}
      </div>
    </div>

    {/* ─── Fluid blob accents (single-color, soft) ─── */}
    <div
      className="absolute top-[12%] right-[12%] w-[160px] h-[160px] opacity-[0.06] dark:opacity-[0.10] animate-[morph_15s_ease-in-out_infinite] pointer-events-none hidden lg:block"
      style={{
        background: "#c4b5fd",
        borderRadius: "30% 70% 70% 30% / 30% 30% 70% 70%",
        filter: "blur(45px)",
      }}
    />
    <div
      className="absolute bottom-[20%] right-[20%] w-[100px] h-[100px] opacity-[0.05] dark:opacity-[0.08] animate-[morph_12s_ease-in-out_infinite_reverse] pointer-events-none hidden lg:block"
      style={{
        background: "#7dd3fc",
        borderRadius: "60% 40% 30% 70% / 60% 30% 70% 40%",
        filter: "blur(35px)",
      }}
    />

    {/* ─── CSS Keyframes (injected once) ─── */}
    <style>{`
      @keyframes drift {
        0%, 100% { transform: translate(0, 0) scale(1); }
        33% { transform: translate(15px, -20px) scale(1.05); }
        66% { transform: translate(-10px, 15px) scale(0.95); }
      }
      @keyframes morph {
        0%, 100% { border-radius: 30% 70% 70% 30% / 30% 30% 70% 70%; transform: rotate(0deg) scale(1); }
        25% { border-radius: 58% 42% 35% 65% / 62% 48% 52% 38%; transform: rotate(5deg) scale(1.05); }
        50% { border-radius: 50% 50% 60% 40% / 45% 55% 45% 55%; transform: rotate(-3deg) scale(0.98); }
        75% { border-radius: 40% 60% 45% 55% / 55% 35% 65% 45%; transform: rotate(3deg) scale(1.02); }
      }
      @keyframes float {
        0%, 100% { transform: translateY(0px); }
        50% { transform: translateY(-12px); }
      }
      @keyframes breathe {
        0%, 100% { transform: scale(1); opacity: 0.15; }
        50% { transform: scale(1.08); opacity: 0.22; }
      }
      @keyframes fadeInScale {
        from { opacity: 0; transform: scale(0.92); }
        to { opacity: 1; transform: scale(1); }
      }
    `}</style>
  </div>
  );
};
