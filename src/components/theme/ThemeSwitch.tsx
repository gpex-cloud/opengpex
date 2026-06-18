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

// src/components/theme/ThemeSwitch.tsx
/* eslint-disable react-hooks/set-state-in-effect */
import { useTheme } from "@opengpex/components/theme/ThemeContext";
import { useState, useEffect } from "react";
import { Sun, Moon, Monitor } from "lucide-react";

interface ThemeSwitchProps {
  /** Custom class name can be passed to style the container */
  className?: string;
  /** Control button size: 'default' for original size, 'compact' for compact small size */
  size?: "default" | "compact";
}

export default function ThemeSwitch({
  className = "",
  size = "default",
}: ThemeSwitchProps) {
  // Add isDark to destructuring
  const { theme, isDark, switchTheme } = useTheme();
  const [mounted, setMounted] = useState<boolean>(false);

  // Avoid hydration errors
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  // Directly set theme function
  const setSpecificTheme = (selectedTheme: "light" | "dark" | "system") => {
    // Update theme value in Context
    switchTheme(selectedTheme);
  };

  // Determine button styles based on size parameter
  const buttonSizeStyles = {
    default: "p-2 min-h-[36px] min-w-[36px]",
    compact: "p-1 min-h-[28px] min-w-[28px]",
  };
  const buttonSizeStyle = buttonSizeStyles[size];

  // SqrButton style mapping
  const getButtonStyle = (buttonTheme: "light" | "dark" | "system") => {
    // Base style: simulate SqrButton rounded class
    const baseStyle = `rounded-full flex items-center justify-center ${buttonSizeStyle} transition-colors`;

    // Active state
    const isActive = theme === buttonTheme;

    // Variant style: simulate SqrButton variant class
    let variantStyle = "";
    if (isActive) {
      if (buttonTheme === "light") {
        variantStyle =
          "bg-zinc-200 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200";
      } else if (buttonTheme === "dark") {
        variantStyle =
          "bg-zinc-100 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200";
      } else {
        // system
        variantStyle = isDark
          ? "bg-zinc-100 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200"
          : "bg-zinc-200 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200";
      }
    } else {
      // Ghost style used for inactive state
      variantStyle =
        "bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200";
    }

    return `${baseStyle} ${variantStyle}`;
  };

  return (
    <div
      className={`flex relative bg-zinc-100/70 dark:bg-zinc-800/70 rounded-full p-0 ${className}`}
    >
      {/* Rounded buttons */}
      <div className="flex space-x-1">
        <button
          type="button"
          className={getButtonStyle("light")}
          onClick={() => setSpecificTheme("light")}
          title="Light Mode"
        >
          <Sun
            className={[
              "w-4",
              "h-4",
              theme === "light" ? "text-indigo-500" : "",
            ].join(" ")}
          />
        </button>

        <button
          type="button"
          className={getButtonStyle("dark")}
          onClick={() => setSpecificTheme("dark")}
          title="Dark Mode"
        >
          <Moon
            className={[
              "w-4",
              "h-4",
              theme === "light" ? "text-indigo-500" : "",
            ].join(" ")}
          />
        </button>

        <button
          type="button"
          className={getButtonStyle("system")}
          onClick={() => setSpecificTheme("system")}
          title="Follow System"
        >
          <Monitor
            className={[
              "w-4",
              "h-4",
              theme === "system" ? "text-indigo-500" : "",
            ].join(" ")}
          />
        </button>
      </div>
    </div>
  );
}
