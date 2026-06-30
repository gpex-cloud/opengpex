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
import { API_AUTH_LOGIN, API_AUTH_VERIFY_OTP, API_AUTH_RESEND, API_AUTH_SESSION } from "../../protocol";
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

// ─── OAuth Error Messages ───

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  service_unavailable: "Authentication service is temporarily unavailable. Please try again later.",
  google_token_exchange_failed: "Failed to authenticate with Google. Please try again.",
  github_token_exchange_failed: "Failed to authenticate with GitHub. Please try again.",
  google_session_failed: "Failed to create login session. Please try again.",
  github_session_failed: "Failed to create login session. Please try again.",
  user_banned: "Your account has been suspended. Please contact support.",
  auth_callback_failed: "Authentication failed. Please try again.",
};

function formatOAuthError(msg: string): string {
  return OAUTH_ERROR_MESSAGES[msg] || msg.replace(/_/g, " ");
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

  const submittingRef = useRef(false);

  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setInterval(() => setResendCountdown((p) => p - 1), 1000);
    return () => clearInterval(timer);
  }, [resendCountdown]);

  if (!isOpen) return null;

  const accent = branding?.accentColor || "#00F2FE";
  const gradient = branding?.accentGradient || "linear-gradient(to right, #00F2FE, #4FACFE)";

  const goToLogin = () => { setMode("login"); setOtp(""); setErrorMsg(""); };

  // ─── OTP Submit ───
  const handleOtpSubmit = async (e?: React.FormEvent, tokenToVerify?: string) => {
    e?.preventDefault();
    const token = tokenToVerify || otp;
    if (token.length !== 6 || submittingRef.current) return;
    submittingRef.current = true;
    setErrorMsg(""); setLoading(true);

    try {
      const res = await fetch(`${apiBaseUrl}${API_AUTH_VERIFY_OTP}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), token, type: "email" }),
      });
      const data = await res.json() as { user?: AuthUser; accessToken?: string; refreshToken?: string; error?: string };
      if (!res.ok) throw new Error(data.error || "Verification failed");
      if (data.user) {
        resetRateLimit();
        onSuccess(data.user, { accessToken: data.accessToken, refreshToken: data.refreshToken });
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to verify code");
    } finally {
      setLoading(false); submittingRef.current = false;
    }
  };

  // ─── Resend OTP ───
  const handleResendOtp = async () => {
    if (resendCountdown > 0) return;
    setErrorMsg(""); setLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}${API_AUTH_RESEND}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error || "Failed to resend code");
      setResendCountdown(60);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to resend code");
    } finally { setLoading(false); }
  };

  // ─── Rate Limit Helpers ───
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
    setRateLimitState(newCount >= RATE_LIMIT_MAX
      ? { failCount: newCount, lockUntil: Date.now() + RATE_LIMIT_COOLDOWN_MS }
      : { failCount: newCount, lockUntil: 0 });
  };

  const resetRateLimit = () => setRateLimitState({ failCount: 0, lockUntil: 0 });

  // ─── Login Submit (Passwordless OTP) ───
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current || !checkRateLimit()) return;
    submittingRef.current = true;
    setErrorMsg(""); setLoading(true);

    try {
      const res = await fetch(`${apiBaseUrl}${API_AUTH_LOGIN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const data = await res.json() as { status?: string; error?: string };
      if (!res.ok) throw new Error(data.error || "Request failed");
      if (data.status === "email_verification_required") {
        setOtp(""); setResendCountdown(60); setMode("verify-otp");
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "An error occurred");
      recordFailure();
    } finally { setLoading(false); submittingRef.current = false; }
  };

  // ─── OAuth (Popup) ───
  const handleOAuth = async (provider: string) => {
    setErrorMsg(""); setLoading(true); setOauthPending(true);
    try {
      const tokens = await popupOAuth({ apiBaseUrl, provider });
      const res = await fetch(`${apiBaseUrl}${API_AUTH_SESSION}`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { user?: AuthUser };
        if (data.user) { onSuccess(data.user, tokens); return; }
      }
      onSuccess({ id: "", email: "" } as AuthUser, tokens);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "OAuth failed";
      if (msg !== "Login cancelled by user") setErrorMsg(formatOAuthError(msg));
    } finally { setLoading(false); setOauthPending(false); }
  };

  // ─── Render ───
  return (
    <div className="fixed inset-0 z-[6000] flex items-center justify-center p-4 bg-black/60 backdrop-blur-lg">
      <div
        className="relative w-full max-w-[400px] bg-[var(--bg-panel,#1a1a2e)] border border-[var(--border-subtle,#333)] rounded-2xl p-8 text-[var(--text-main,#eee)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* OAuth pending overlay */}
        {oauthPending && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-[rgba(26,26,46,0.95)] rounded-2xl">
            <div className="w-9 h-9 border-3 border-[var(--border-subtle,#333)] border-t-[var(--accent,#00F2FE)] rounded-full animate-spin" style={{ borderTopColor: accent }} />
            <p className="text-[0.85rem] font-semibold text-center">Please complete sign-in in the popup window</p>
            <p className="text-[0.7rem] text-[var(--text-muted,#888)] text-center">Waiting for authentication...</p>
          </div>
        )}

        {/* Top accent line */}
        <div className="absolute top-0 left-0 right-0 h-0.5 rounded-t-2xl" style={{ background: gradient }} />

        {/* Close button */}
        <button
          onClick={onClose}
          disabled={oauthPending}
          className="absolute top-4 right-4 bg-transparent border-none text-[var(--text-muted,#888)] text-xl cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
        >✕</button>

        {/* ─── Mode: Login ─── */}
        {mode === "login" && (
          <>
            <div className="text-center mb-6">
              {branding?.logo && (
                <img src={branding.logo} alt={branding.logoAlt || "Logo"} className="w-12 h-12 mx-auto mb-5 rounded-xl" />
              )}
              <h2 className="text-xl font-bold m-0">{branding?.title || "Sign In / Up"}</h2>
              <p className="text-xs text-[var(--text-muted,#888)] mt-2 leading-relaxed">
                {branding?.subtitle || "Sign in or create your account — it's free."}
              </p>
            </div>

            {/* OAuth providers */}
            {oauthProviders && oauthProviders.length > 0 && (
              <>
                <div className="flex gap-2 mb-4">
                  {oauthProviders.map((provider) => (
                    <OAuthButton key={provider} provider={provider} onClick={() => handleOAuth(provider)} disabled={loading} />
                  ))}
                </div>
                <div className="flex items-center my-3 gap-3">
                  <div className="flex-1 h-px bg-[var(--border-subtle,#333)]" />
                  <span className="text-[0.65rem] text-[var(--text-muted,#888)] font-bold uppercase">or</span>
                  <div className="flex-1 h-px bg-[var(--border-subtle,#333)]" />
                </div>
              </>
            )}

            {/* Email form */}
            <form onSubmit={handleSubmit}>
              <div className="mb-4">
                <label className="block text-[0.7rem] font-bold uppercase tracking-wider mb-1.5 text-[var(--text-muted,#888)]">Email</label>
                <StyledInput type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" accentColor={accent} />
              </div>
              {errorMsg && <AlertBanner message={errorMsg} />}
              <SubmitButton loading={loading} gradient={gradient} label={branding?.buttonText || "Continue"} disabled={lockCountdown > 0} />
            </form>

            <p className="text-[0.65rem] text-[var(--text-muted,#666)] mt-3 text-center italic">
              We&apos;ll send you a verification code — no password needed.
            </p>

            {/* Legal disclaimer */}
            {(branding?.termsUrl || branding?.privacyUrl) && (
              <div className="mt-5 text-center text-[0.6rem] text-[var(--text-muted,#666)] leading-relaxed">
                <p className="m-0">
                  By continuing, you agree to our{" "}
                  {branding.termsUrl && <a href={branding.termsUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--text-muted,#999)] underline underline-offset-2">Terms of Service</a>}
                  {branding.termsUrl && branding.privacyUrl && " and "}
                  {branding.privacyUrl && <a href={branding.privacyUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--text-muted,#999)] underline underline-offset-2">Privacy Policy</a>}
                  .
                </p>
              </div>
            )}
          </>
        )}

        {/* ─── Mode: Verify OTP ─── */}
        {mode === "verify-otp" && (
          <div className="py-2">
            <div className="text-center mb-6">
              <div className="text-4xl mb-4">✉️</div>
              <h2 className="text-xl font-bold mb-3">Check Your Email</h2>
              <p className="text-sm text-[var(--text-muted,#aaa)] leading-relaxed mb-2">
                We&apos;ve sent a 6-digit verification code to:
              </p>
              <p className="text-sm font-semibold text-[var(--text-main,#eee)] mb-2">{email}</p>
            </div>

            <form onSubmit={handleOtpSubmit}>
              <OtpInput
                value={otp}
                onChange={(val) => { setOtp(val); if (val.length === 6) handleOtpSubmit(undefined, val); }}
                accentColor={accent}
                disabled={loading}
              />
              {errorMsg && <AlertBanner message={errorMsg} />}
              <SubmitButton loading={loading} gradient={gradient} label="Verify Code" disabled={otp.length !== 6} />
            </form>

            <div className="text-center mt-6 text-xs text-[var(--text-muted,#888)]">
              Didn&apos;t receive the code?{" "}
              {resendCountdown > 0
                ? <span>Resend in {resendCountdown}s</span>
                : <TextLink onClick={handleResendOtp} style={{ color: accent, fontWeight: 600 }}>Resend Code</TextLink>
              }
            </div>

            <div className="text-center mt-4">
              <TextLink onClick={goToLogin}>← Back to login</TextLink>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
