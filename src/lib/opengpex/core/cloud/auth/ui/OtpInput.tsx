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

import React, { useRef, useEffect, useState } from "react";

interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  accentColor: string;
  disabled?: boolean;
}

export function OtpInput({ value, onChange, accentColor, disabled }: OtpInputProps) {
  const inputsRef = useRef<HTMLInputElement[]>([]);
  const length = 6;

  // Split the value string into 6 characters
  const values = value.padEnd(length, " ").slice(0, length).split("");

  // Auto-focus first input on mount
  useEffect(() => {
    if (inputsRef.current[0]) {
      inputsRef.current[0].focus();
    }
  }, []);

  const handleChange = (val: string, index: number) => {
    const sanitizedVal = val.replace(/[^0-9a-zA-Z]/g, "").slice(-1);
    
    const newValues = [...values];
    newValues[index] = sanitizedVal || " ";
    const newValueStr = newValues.join("").trimEnd();
    
    onChange(newValueStr);

    // Move to next input if character entered
    if (sanitizedVal && index < length - 1) {
      inputsRef.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key === "Backspace") {
      if (!value[index] && index > 0) {
        const newValues = [...values];
        newValues[index - 1] = " ";
        onChange(newValues.join("").trimEnd());
        inputsRef.current[index - 1]?.focus();
      } else {
        const newValues = [...values];
        newValues[index] = " ";
        onChange(newValues.join("").trimEnd());
      }
      e.preventDefault();
    } else if (e.key === "ArrowLeft" && index > 0) {
      inputsRef.current[index - 1]?.focus();
      e.preventDefault();
    } else if (e.key === "ArrowRight" && index < length - 1) {
      inputsRef.current[index + 1]?.focus();
      e.preventDefault();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (disabled) return;

    const pastedData = e.clipboardData.getData("text").trim();
    const sanitizedData = pastedData.replace(/[^0-9a-zA-Z]/g, "").slice(0, length);
    
    if (sanitizedData) {
      onChange(sanitizedData);
      const nextFocusIndex = Math.min(sanitizedData.length, length - 1);
      inputsRef.current[nextFocusIndex]?.focus();
    }
  };

  return (
    <div style={{ display: "flex", justifyContent: "center", gap: "0.5rem", margin: "1.5rem 0" }}>
      {Array.from({ length }).map((_, index) => {
        return (
          <OtpInputElement
            key={index}
            index={index}
            inputsRef={inputsRef}
            val={values[index]}
            disabled={disabled}
            accentColor={accentColor}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
        );
      })}
    </div>
  );
}

interface OtpInputElementProps {
  index: number;
  inputsRef: React.MutableRefObject<HTMLInputElement[]>;
  val: string;
  disabled?: boolean;
  accentColor: string;
  onChange: (val: string, index: number) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>, index: number) => void;
  onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => void;
}

function OtpInputElement({
  index,
  inputsRef,
  val,
  disabled,
  accentColor,
  onChange,
  onKeyDown,
  onPaste,
}: OtpInputElementProps) {
  const [focused, setFocused] = useState(false);

  return (
    <input
      ref={(el) => {
        if (el) inputsRef.current[index] = el;
      }}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={1}
      value={val === " " ? "" : val}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value, index)}
      onKeyDown={(e) => onKeyDown(e, index)}
      onPaste={onPaste}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      autoComplete="one-time-code"
      aria-label={`Digit ${index + 1}`}
      placeholder="-"
      style={{
        width: "42px",
        height: "48px",
        textAlign: "center",
        fontSize: "1.25rem",
        fontWeight: 700,
        borderRadius: "0.5rem",
        border: focused ? `2px solid ${accentColor}` : "1px solid var(--border-subtle, #333)",
        background: "var(--bg-stage, #111)",
        color: "inherit",
        caretColor: "transparent",
        outline: "none",
        boxSizing: "border-box",
        transition: "border-color 150ms ease, box-shadow 150ms ease",
        boxShadow: focused ? `0 0 0 2px ${accentColor}33` : "none",
      }}
    />
  );
}
