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

import React, { useState } from "react";
import { usePluginSelfConfig } from "@opengpex/editor/core/context";
import { Key, Link, Plus, Trash2, CheckCircle2, AlertCircle, Eye, EyeOff } from "lucide-react";
import { AIBridgeConfig, AIProvider, validateBaseUrl } from "../protocols";

export function AIBridgeSettings() {
  const [config, setConfig] = usePluginSelfConfig<AIBridgeConfig>();
  const [urlWarnings, setUrlWarnings] = useState<Record<string, string | null>>({});
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});

  const toggleKeyVisibility = (providerId: string) => {
    setVisibleKeys((prev) => ({ ...prev, [providerId]: !prev[providerId] }));
  };

  const updateProvider = (id: string, patch: Partial<AIProvider>) => {
    const nextProviders = config.providers.map((p) =>
      p.id === id ? { ...p, ...patch } : p,
    );
    setConfig({ providers: nextProviders });
  };

  const handleBaseUrlChange = (providerId: string, rawUrl: string) => {
    const result = validateBaseUrl(rawUrl);

    if (result.warning && result.cleaned) {
      // Auto-correct the URL and show warning
      setUrlWarnings((prev) => ({ ...prev, [providerId]: result.warning! }));
      updateProvider(providerId, { baseUrl: result.cleaned });
    } else if (result.warning) {
      // Invalid URL, still update for user to see, show warning
      setUrlWarnings((prev) => ({ ...prev, [providerId]: result.warning! }));
      updateProvider(providerId, { baseUrl: rawUrl });
    } else {
      // Valid URL
      setUrlWarnings((prev) => ({ ...prev, [providerId]: null }));
      updateProvider(providerId, { baseUrl: result.cleaned || rawUrl });
    }
  };

  const addProvider = () => {
    const newId = `custom-${Date.now()}`;
    const newProvider: AIProvider = {
      id: newId,
      name: "Custom Provider",
      baseUrl: "",
      apiKey: "",
    };
    // Adds only, does not automatically switch active provider
    setConfig({
      providers: [...config.providers, newProvider],
    });
  };

  const removeProvider = (id: string) => {
    const nextProviders = config.providers.filter((p) => p.id !== id);
    let nextActiveId = config.activeProviderId;
    if (nextActiveId === id && nextProviders.length > 0) {
      nextActiveId = nextProviders[0].id;
    }
    setConfig({ providers: nextProviders, activeProviderId: nextActiveId });
    // Clean up warning
    setUrlWarnings((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between pl-1">
          <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1.5">
            <Key size={11} /> Universal AI Endpoints
          </h5>
          <button
            onClick={addProvider}
            className="flex items-center gap-1 text-[9px] font-bold text-amber-500 hover transition-colors uppercase tracking-wider"
          >
            <Plus size={10} /> Add
          </button>
        </div>

        <div className="flex flex-col gap-3 max-h-[350px] overflow-y-auto pr-1">
          {config.providers.map((provider) => {
            const isActive = config.activeProviderId === provider.id;
            const warning = urlWarnings[provider.id];
            return (
              <div
                key={provider.id}
                className={`flex flex-col gap-3 rounded-xl p-3 border transition-all ${
                  isActive
                    ? "bg-[var(--bg-stage)] border-amber-500/50"
                    : "bg-[var(--bg-stage)] border-[var(--border-subtle)] "
                }`}
              >
                {/* Header: Name and Active status */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-1">
                    <button
                      onClick={() =>
                        setConfig({ activeProviderId: provider.id })
                      }
                      className={`p-1 rounded-full transition-colors ${isActive ? "text-amber-500" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}
                      title={isActive ? "Active Provider" : "Set as Active"}
                    >
                      <CheckCircle2
                        size={14}
                        className={isActive ? "opacity-100" : "opacity-50"}
                      />
                    </button>
                    <input
                      type="text"
                      value={provider.name}
                      onChange={(e) =>
                        updateProvider(provider.id, { name: e.target.value })
                      }
                      className="bg-transparent border-none text-[11px] font-bold text-[var(--text-main)] focus:outline-none w-32 focus:ring-1 focus:ring-amber-500/50 rounded px-1 -ml-1"
                    />
                  </div>
                  {config.providers.length > 1 && (
                    <button
                      onClick={() => removeProvider(provider.id)}
                      className="text-[var(--text-muted)] hover:text-rose-500 transition-colors p-1"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>

                {/* Inputs */}
                <div className="flex flex-col gap-2.5">
                  <div className="flex flex-col gap-1">
                    <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-wider pl-0.5 flex items-center gap-1">
                      <Link size={9} /> Base URL
                    </span>
                    <input
                      type="text"
                      value={provider.baseUrl ?? ''}
                      onChange={(e) =>
                        handleBaseUrlChange(provider.id, e.target.value)
                      }
                      onBlur={(e) =>
                        handleBaseUrlChange(provider.id, e.target.value)
                      }
                      placeholder="https://api.openai.com"
                      className={`w-full bg-[var(--bg-panel)] border rounded-lg px-2 py-1.5 text-[10px] text-[var(--text-main)] focus:outline-none transition-all ${
                        warning
                          ? "border-amber-500/50 focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
                          : "border-[var(--border-subtle)] focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
                      }`}
                    />
                    {warning && (
                      <div className="flex items-start gap-1 mt-0.5 px-0.5">
                        <AlertCircle size={9} className="text-amber-500 mt-0.5 shrink-0" />
                        <span className="text-[8px] font-bold text-amber-500 leading-tight">
                          {warning}
                        </span>
                      </div>
                    )}
                    <span className="text-[8px] text-[var(--text-muted)] pl-0.5 italic opacity-60">
                      Enter base URL only. Paths like /v1/images/generations are added automatically.
                    </span>
                  </div>

                  <div className="flex flex-col gap-1">
                    <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-wider pl-0.5 flex items-center gap-1">
                      <Key size={9} /> API Key
                    </span>
                    <div className="relative">
                      <input
                        type={visibleKeys[provider.id] ? "text" : "password"}
                        value={provider.apiKey}
                        onChange={(e) =>
                          updateProvider(provider.id, { apiKey: e.target.value })
                        }
                        placeholder="sk-..."
                        className="w-full bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 pr-8 text-[10px] text-[var(--text-main)] focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all placeholder:text-[var(--text-muted)]"
                      />
                      <button
                        type="button"
                        onClick={() => toggleKeyVisibility(provider.id)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors focus:outline-none"
                        title={visibleKeys[provider.id] ? "Hide API Key" : "Show API Key"}
                      >
                        {visibleKeys[provider.id] ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="px-1 text-[8px] text-[var(--text-muted)] font-bold leading-relaxed uppercase tracking-tight italic opacity-60">
        Your API keys are stored securely in your browser&apos;s local storage
        and are never sent to our servers. The plugin will automatically append the correct API path (/v1/images/generations, /v1/images/edits, etc.) based on the selected mode.
      </p>
    </div>
  );
}
