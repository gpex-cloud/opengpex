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

import React, { useState } from "react";
import { GoogleIcon, GitHubIcon } from "./icons";

// ─── StyledInput ───
export function StyledInput({ accentColor, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { accentColor: string }) {
  const [focused, setFocused] = useState(false);

  const style: React.CSSProperties = {
    width: "100%",
    padding: "0.6rem 0.8rem",
    borderRadius: "0.5rem",
    border: focused ? `1px solid ${accentColor}` : "1px solid var(--border-light, #333)",
    background: "var(--bg-stage, #111)",
    color: "inherit",
    fontSize: "0.875rem",
    outline: "none",
    boxSizing: "border-box",
    transition: "border-color 150ms ease, box-shadow 150ms ease",
    boxShadow: focused ? `0 0 0 2px ${accentColor}33` : "none",
  };

  return (
    <input
      {...props}
      style={style}
      onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
    />
  );
}

// ─── SubmitButton ───
export function SubmitButton({ loading, gradient, label, disabled }: { loading: boolean; gradient: string; label: string; disabled?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const isDisabled = loading || disabled;

  const style: React.CSSProperties = {
    width: "100%",
    height: "40px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "0.5rem",
    border: "none",
    background: gradient,
    color: "#000",
    fontWeight: 700,
    fontSize: "0.875rem",
    cursor: isDisabled ? "not-allowed" : "pointer",
    opacity: isDisabled ? 0.6 : 1,
    transition: "all 150ms ease",
    transform: pressed ? "scale(0.97)" : hovered ? "scale(1.01)" : "scale(1)",
    filter: hovered && !isDisabled ? "brightness(1.1)" : "none",
    outline: "none",
  };

  return (
    <button
      type="submit"
      disabled={isDisabled}
      style={style}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
    >
      {loading ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid currentColor", borderTopColor: "transparent", borderRadius: "50%", animation: "gpex-btn-spin 0.6s linear infinite" }} />
          <style>{`@keyframes gpex-btn-spin { to { transform: rotate(360deg); } }`}</style>
        </span>
      ) : label}
    </button>
  );
}

// ─── OAuthButton ───
export function OAuthButton({ provider, onClick, disabled, loading }: { provider: string; onClick: () => void; disabled: boolean; loading?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const baseStyle: React.CSSProperties = {
    flex: 1,
    height: "40px",
    border: hovered
      ? "1px solid var(--text-muted, #888)"
      : "1px solid var(--border-light, #333)",
    borderRadius: "0.5rem",
    background: hovered
      ? "color-mix(in srgb, var(--text-main, #1f2937) 8%, transparent)"
      : "transparent",
    color: "inherit",
    fontWeight: 600,
    fontSize: "0.875rem",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
    transition: "all 150ms ease",
    transform: pressed ? "scale(0.97)" : "scale(1)",
    opacity: disabled ? 0.5 : 1,
    outline: "none",
  };

  const label = provider.charAt(0).toUpperCase() + provider.slice(1);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={baseStyle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
    >
      {loading ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid currentColor", borderTopColor: "transparent", borderRadius: "50%", animation: "gpex-spin 0.6s linear infinite" }} />
          <style>{`@keyframes gpex-spin { to { transform: rotate(360deg); } }`}</style>
          Redirecting...
        </span>
      ) : (
        <>
          {provider === "google" && <GoogleIcon />}
          {provider === "github" && <GitHubIcon />}
          {label}
        </>
      )}
    </button>
  );
}

// ─── TextLink ───
export function TextLink({ onClick, children, style: extraStyle }: { onClick: () => void; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "none",
        border: "none",
        color: "var(--text-muted, #888)",
        fontSize: "0.75rem",
        cursor: "pointer",
        textDecoration: "underline",
        textUnderlineOffset: "2px",
        padding: 0,
        ...extraStyle,
      }}
    >
      {children}
    </button>
  );
}
