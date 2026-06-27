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

// src/app/layout.tsx
import { type Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@opengpex/components/theme/ThemeContext";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  preload: false,
});

export const metadata: Metadata = {
  title: "OpenGPEX.app",
  description: "Professional-grade web-based image editor.",
  openGraph: {
    title: "OpenGPEX.app",
    description: "Professional-grade web-based image editor.",
    images: [{ url: "https://opengpex.app/og-image.png" }],
  },
  robots: {
    index: true,
    follow: true,
  },
};

function getInitialThemeState() {
  return {
    theme: "system" as const,
    isDark: false,
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { theme, isDark } = getInitialThemeState();

  return (
    <html lang="en" suppressHydrationWarning={true}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
                (function() {
                  try {
                    var theme = localStorage.getItem('theme');
                    var isDarkMode = false;
                    if (theme === 'dark') {
                      isDarkMode = true;
                    } else if (theme === 'light') {
                      isDarkMode = false;
                    } else {
                      // 'system' or not set
                      isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
                    }
                    if (isDarkMode) {
                      document.documentElement.classList.add('dark');
                    } else {
                      document.documentElement.classList.remove('dark');
                    }
                  } catch (e) {
                    // Silent fail
                  }
                })();
              `,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-white dark:bg-zinc-900`}
        suppressHydrationWarning={true}
      >
        <ThemeProvider initialTheme={theme} initialIsDark={isDark}>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
