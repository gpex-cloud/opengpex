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

import React, { useState, useEffect, useRef } from "react";
import type { AuthUser, Branding } from "../types";
import { popupOAuth } from "../oauth-popup";
import { OtpInput } from "./OtpInput";
import { AlertBanner } from "./AlertBanner";
import { StyledInput, SubmitButton, OAuthButton, TextLink } from "./components";

// ─── Types ───

type LoginMode = "login" | "verify-otp";

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (user: AuthUser, tokens?: { accessToken?: string; refreshToken?: string }) => void;
  apiBaseUrl: string;
  branding?: Branding;
  oauthProviders?: string[];
}

// ─── Rate Limiting ───

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const RATE_LIMIT_STORAGE_KEY = "gpex_auth_rate";

function getRateLimitState(): { failCount: number; lockUntil: number } {
  try {
    const raw = sessionStorage.getItem(RATE_LIMIT_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { failCount: 0, lockUntil: 0 };
}

function setRateLimitState(state: { failCount: number; lockUntil: number }) {
  try { sessionStorage.setItem(RATE_LIMIT_STORAGE_KEY, JSON.stringify(state)); } catch {}
}

// ─── Main Component ───

export function LoginModal({ isOpen, onClose, onSuccess, apiBaseUrl, branding, oauthProviders }: LoginModalProps) {
  const [mode, setMode] = useState<LoginMode>("login");
  const [email, setEmail] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [oauthPending, setOauthPending] = useState(false);
  const [lockCountdown, setLockCountdown] = useState(0);
  const [otp, setOtp] = useState("");
  const [resendCountdown, setResendCountdown] = useState(0);

  // Ref guard: prevents duplicate async submissions (e.g. React StrictMode double-mount edge cases)
  const submittingRef = useRef(false);

  // Countdown timer for OTP resending
  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setInterval(() => {
      setResendCountdown((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCountdown]);

  if (!isOpen) return null;

  const accent = branding?.accentColor || "#00F2FE";
  const gradient = branding?.accentGradient || `linear-gradient(to right, #00F2FE, #4FACFE)`;

  const goToLogin = () => {
    setMode("login");
    setOtp("");
    setErrorMsg("");
  };

  // Helper: detect same-origin for credentials policy
  const isSameOrigin = (() => {
    if (!apiBaseUrl || !apiBaseUrl.startsWith("http")) return true;
    try { return new URL(apiBaseUrl).origin === window.location.origin; }
    catch { return true; }
  })();

  // ─── OTP handlers ───
  const handleOtpSubmit = async (e?: React.FormEvent, tokenToVerify?: string) => {
    e?.preventDefault();
    const token = tokenToVerify || otp;
    if (token.length !== 6) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setErrorMsg("");
    setLoading(true);

    try {
      const res = await fetch(`${apiBaseUrl}/api/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: isSameOrigin ? "include" : "omit",
        body: JSON.stringify({ email: email.trim().toLowerCase(), token, type: "email" }),
      });

      const data = await res.json() as {
        user?: AuthUser;
        accessToken?: string;
        refreshToken?: string;
        error?: string;
      };

      if (!res.ok) {
        throw new Error(data.error || "Verification failed");
      }

      if (data.user) {
        resetRateLimit();
        onSuccess(data.user, {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
        });
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to verify code");
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  };

  const handleResendOtp = async () => {
    if (resendCountdown > 0) return;
    setErrorMsg("");
    setLoading(true);

    try {
      const res = await fetch(`${apiBaseUrl}/api/auth/resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: isSameOrigin ? "include" : "omit",
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      const data = await res.json() as { error?: string };

      if (!res.ok) {
        throw new Error(data.error || "Failed to resend code");
      } else {
        setResendCountdown(60);
        setErrorMsg("");
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to resend code");
    } finally {
      setLoading(false);
    }
  };

  // ─── Rate limit helpers ───
  const checkRateLimit = (): boolean => {
    const state = getRateLimitState();
    if (state.lockUntil > Date.now()) {
      const remaining = Math.ceil((state.lockUntil - Date.now()) / 1000);
      setLockCountdown(remaining);
      setErrorMsg(`Too many attempts. Please wait ${remaining}s.`);
      const timer = setInterval(() => {
        const r = Math.ceil((state.lockUntil - Date.now()) / 1000);
        if (r <= 0) { clearInterval(timer); setLockCountdown(0); setErrorMsg(""); }
        else { setLockCountdown(r); setErrorMsg(`Too many attempts. Please wait ${r}s.`); }
      }, 1000);
      return false;
    }
    setLockCountdown(0);
    return true;
  };

  const recordFailure = () => {
    const state = getRateLimitState();
    const newCount = state.failCount + 1;
    if (newCount >= RATE_LIMIT_MAX) {
      setRateLimitState({ failCount: newCount, lockUntil: Date.now() + RATE_LIMIT_COOLDOWN_MS });
    } else {
      setRateLimitState({ failCount: newCount, lockUntil: 0 });
    }
  };

  const resetRateLimit = () => {
    setRateLimitState({ failCount: 0, lockUntil: 0 });
  };

  // ─── Login submit handler (Passwordless OTP via API) ───
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    if (!checkRateLimit()) return;
    submittingRef.current = true;
    setErrorMsg("");
    setLoading(true);

    try {
      const res = await fetch(`${apiBaseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: isSameOrigin ? "include" : "omit",
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      const data = await res.json() as {
        status?: string;
        error?: string;
      };

      if (!res.ok) {
        throw new Error(data.error || "Request failed");
      }

      // Handle email verification required (expected response)
      if (data.status === "email_verification_required") {
        setOtp("");
        setResendCountdown(60);
        setMode("verify-otp");
        return;
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "An error occurred");
      recordFailure();
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  };

  // ─── OAuth handler (Popup) ───
  const handleOAuth = async (provider: string) => {
    setErrorMsg("");
    setLoading(true);
    setOauthPending(true);

    try {
      const tokens = await popupOAuth({ apiBaseUrl, provider });

      // Fetch user info with the new token
      const res = await fetch(`${apiBaseUrl}/api/auth/session`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });

      if (res.ok) {
        const data = (await res.json()) as { user?: AuthUser };
        if (data.user) {
          onSuccess(data.user, tokens);
          return;
        }
      }

      // Token valid but session fetch failed — still pass tokens
      onSuccess({ id: "", email: "" } as AuthUser, tokens);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "OAuth failed";
      // Don't show error for user-initiated cancellation
      if (msg !== "Login cancelled by user") {
        setErrorMsg(msg);
      }
    } finally {
      setLoading(false);
      setOauthPending(false);
    }
  };

  // ─── Render ───

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)" }}
    >
      <div
        style={{ position: "relative", width: "100%", maxWidth: "400px", background: "var(--bg-panel, #1a1a2e)", border: "1px solid var(--border-subtle, #333)", borderRadius: "1rem", padding: "2rem", color: "var(--text-main, #eee)", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* OAuth pending overlay — blocks all interaction while popup is open */}
        {oauthPending && (
          <div style={{
            position: "absolute", inset: 0, zIndex: 10,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1rem",
            background: "rgba(26, 26, 46, 0.95)", borderRadius: "1rem",
          }}>
            {/* Animated spinner */}
            <div style={{
              width: "36px", height: "36px", border: "3px solid var(--border-subtle, #333)",
              borderTopColor: accent, borderRadius: "50%",
              animation: "gpex-spin 0.8s linear infinite",
            }} />
            <p style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-main, #eee)", margin: 0, textAlign: "center" }}>
              Please complete sign-in in the popup window
            </p>
            <p style={{ fontSize: "0.7rem", color: "var(--text-muted, #888)", margin: 0, textAlign: "center" }}>
              Waiting for authentication...
            </p>
            <style>{`@keyframes gpex-spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {/* Top accent line */}
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "2px", background: gradient, borderRadius: "1rem 1rem 0 0" }} />

        {/* Close button */}
        <button
          onClick={onClose}
          disabled={oauthPending}
          style={{ position: "absolute", top: "1rem", right: "1rem", background: "none", border: "none", color: "var(--text-muted, #888)", cursor: oauthPending ? "not-allowed" : "pointer", fontSize: "1.2rem", opacity: oauthPending ? 0.3 : 1 }}
        >✕</button>

        {/* ─── Mode: Login ─── */}
        {mode === "login" && (
          <>
            {/* Header */}
            <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
              {branding?.logo && (
                <img src={branding.logo} alt={branding.logoAlt || "Logo"} style={{ width: "48px", height: "48px", margin: "0 auto 1.25rem", borderRadius: "0.75rem" }} />
              )}
              <h2 style={{ fontSize: "1.25rem", fontWeight: 700, margin: 0 }}>{branding?.title || "Sign In / Up"}</h2>
              <p style={{ fontSize: "0.75rem", color: "var(--text-muted, #888)", marginTop: "0.5rem", lineHeight: 1.5 }}>
                {branding?.subtitle || "Sign in or create your account — it's free."}
              </p>
            </div>

            {/* OAuth providers (top position) */}
            {oauthProviders && oauthProviders.length > 0 && (
              <>
                <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
                  {oauthProviders.map((provider) => (
                    <OAuthButton
                      key={provider}
                      provider={provider}
                      onClick={() => handleOAuth(provider)}
                      disabled={loading}
                    />
                  ))}
                </div>

                <div style={{ display: "flex", alignItems: "center", margin: "0.75rem 0", gap: "0.75rem" }}>
                  <div style={{ flex: 1, height: "1px", background: "var(--border-subtle, #333)" }} />
                  <span style={{ fontSize: "0.65rem", color: "var(--text-muted, #888)", fontWeight: 700, textTransform: "uppercase" }}>or</span>
                  <div style={{ flex: 1, height: "1px", background: "var(--border-subtle, #333)" }} />
                </div>
              </>
            )}

            {/* Email-only form */}
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.4rem", color: "var(--text-muted, #888)" }}>Email</label>
                <StyledInput
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  accentColor={accent}
                />
              </div>

              {errorMsg && <AlertBanner message={errorMsg} />}

              <SubmitButton loading={loading} gradient={gradient} label={branding?.buttonText || "Continue"} disabled={lockCountdown > 0} />
            </form>

            <p style={{ fontSize: "0.65rem", color: "var(--text-muted, #666)", marginTop: "0.75rem", textAlign: "center", fontStyle: "italic" }}>
              We&apos;ll send you a verification code — no password needed.
            </p>

            {/* Footer — Legal disclaimer */}
            {(branding?.termsUrl || branding?.privacyUrl) && (
              <div style={{ marginTop: "1.25rem", textAlign: "center", fontSize: "0.6rem", color: "var(--text-muted, #666)", lineHeight: 1.6 }}>
                <p style={{ margin: 0 }}>
                  By continuing, you agree to our{" "}
                  {branding.termsUrl && (
                    <a href={branding.termsUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-muted, #999)", textDecoration: "underline", textUnderlineOffset: "2px" }}>Terms of Service</a>
                  )}
                  {branding.termsUrl && branding.privacyUrl && " and "}
                  {branding.privacyUrl && (
                    <a href={branding.privacyUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-muted, #999)", textDecoration: "underline", textUnderlineOffset: "2px" }}>Privacy Policy</a>
                  )}
                  .
                </p>
              </div>
            )}
          </>
        )}

        {/* ─── Mode: Verify OTP ─── */}
        {mode === "verify-otp" && (
          <div style={{ padding: "0.5rem 0" }}>
            <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
              <div style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>✉️</div>
              <h2 style={{ fontSize: "1.25rem", fontWeight: 700, margin: "0 0 0.75rem" }}>Check Your Email</h2>
              <p style={{ fontSize: "0.8rem", color: "var(--text-muted, #aaa)", lineHeight: 1.6, margin: "0 0 0.5rem" }}>
                We&apos;ve sent a 6-digit verification code to:
              </p>
              <p style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-main, #eee)", margin: "0 0 0.5rem" }}>
                {email}
              </p>
            </div>

            <form onSubmit={handleOtpSubmit}>
              <OtpInput
                value={otp}
                onChange={(val) => {
                  setOtp(val);
                  if (val.length === 6) {
                    handleOtpSubmit(undefined, val);
                  }
                }}
                accentColor={accent}
                disabled={loading}
              />

              {errorMsg && <AlertBanner message={errorMsg} />}

              <SubmitButton
                loading={loading}
                gradient={gradient}
                label="Verify Code"
                disabled={otp.length !== 6}
              />
            </form>

            <div style={{ textAlign: "center", marginTop: "1.5rem", fontSize: "0.75rem", color: "var(--text-muted, #888)" }}>
              Didn&apos;t receive the code?{" "}
              {resendCountdown > 0 ? (
                <span>Resend in {resendCountdown}s</span>
              ) : (
                <TextLink onClick={handleResendOtp} style={{ color: accent, fontWeight: 600 }}>
                  Resend Code
                </TextLink>
              )}
            </div>

            <div style={{ textAlign: "center", marginTop: "1rem" }}>
              <TextLink onClick={goToLogin}>← Back to login</TextLink>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
