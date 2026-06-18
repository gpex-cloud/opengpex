/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

"use client";

import React from "react";

/**
 * Modern error/warning alert with left accent border and icon.
 */
export function AlertBanner({ message, children }: { message: string; children?: React.ReactNode }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      gap: "0.6rem",
      padding: "0.7rem 0.85rem",
      borderRadius: "0.6rem",
      border: "1px solid rgba(239,68,68,0.15)",
      borderLeft: "3px solid #ef4444",
      background: "rgba(239,68,68,0.06)",
      marginBottom: "1rem",
      backdropFilter: "blur(4px)",
    }}>
      {/* Warning icon */}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: "1px" }}>
        <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM7.25 5a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-1.5 0V5Zm.75 6.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" fill="#ef4444" fillOpacity="0.85" />
      </svg>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: "0.78rem", color: "#f87171", lineHeight: 1.5, fontWeight: 500 }}>
          {message}
        </p>
        {children}
      </div>
    </div>
  );
}
