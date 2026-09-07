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

import React, { useState, useRef } from "react";
import { usePluginSelfConfig } from "@opengpex/editor/core/context";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import { Key, Link, Plus, Trash2, CheckCircle2, AlertCircle, Eye, EyeOff, Boxes, ChevronDown, Bot } from "lucide-react";
import {
  AIBridgeConfig,
  AIEndpoint,
  PROVIDER_REGISTRY,
  DEFAULT_PROVIDER_KEY,
  getProvider,
  validateBaseUrl,
} from "../protocols";
import { AgentSettings } from "./AgentSettings";

// ─── Agent-tab navigation flag ──────────────────────────────────────────────
// Mutable module-level flag: external callers set it to true via
// requestAgentsTab(), and the component consumes it on the next render.
// Avoids event-timing issues since this contribution stays mounted.
let _pendingAgentsTab = false;
export function requestAgentsTab() { _pendingAgentsTab = true; }
function consumeAgentsTab() { const v = _pendingAgentsTab; _pendingAgentsTab = false; return v; }

/**
 * AIBridgeSettings — endpoint asset management.
 *
 * An endpoint is one access point the user has: a base URL, a key, and the
 * provider whose API rules it follows. The provider is chosen from a dropdown
 * and fully determines runtime behaviour, so there is nothing else to configure
 * and nothing is auto-detected.
 */
export function AIBridgeSettings() {
  const [config, setConfig] = usePluginSelfConfig<AIBridgeConfig>();
  const [activeTab, setActiveTab] = useState<'endpoints' | 'agents'>('endpoints');

  // If an external caller requested the Agents tab (e.g. AgentChatPanel's
  // settings button), consume the flag and switch. Read during render is safe
  // because consumeAgentsTab() is a one-shot read-and-clear with no side effects
  // beyond the subsequent setState.
  if (consumeAgentsTab() && activeTab !== 'agents') {
    setActiveTab('agents');
  }

  const [urlWarnings, setUrlWarnings] = useState<Record<string, string | null>>({});
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  // Just-added endpoint: scrolls its card into view
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const endpoints: AIEndpoint[] = config.endpoints || [];

  const updateEndpoint = (id: string, patch: Partial<AIEndpoint>) => {
    setConfig({
      endpoints: endpoints.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    });
  };

  const handleBaseUrlChange = (id: string, rawUrl: string) => {
    const result = validateBaseUrl(rawUrl);
    if (result.warning && result.cleaned) {
      setUrlWarnings((prev) => ({ ...prev, [id]: result.warning! }));
      updateEndpoint(id, { baseUrl: result.cleaned });
    } else if (result.warning) {
      setUrlWarnings((prev) => ({ ...prev, [id]: result.warning! }));
      updateEndpoint(id, { baseUrl: rawUrl });
    } else {
      setUrlWarnings((prev) => ({ ...prev, [id]: null }));
      updateEndpoint(id, { baseUrl: result.cleaned || rawUrl });
    }
  };

  /** Adds an endpoint for the given provider, pre-filling its default base URL. */
  const addEndpoint = (providerKey: string) => {
    const provider = getProvider(providerKey);
    if (!provider) return;
    const newId = `${provider.key}-${crypto.randomUUID().slice(0, 8)}`;
    const newEndpoint: AIEndpoint = {
      id: newId,
      name: provider.displayName,
      baseUrl: provider.defaultBaseUrl,
      apiKey: "",
      provider: provider.key,
      modelByKind: {},
    };
    // Adds only — does not switch the active endpoint, since a keyless endpoint
    // would immediately show "API Key Missing" in the drawer.
    setConfig({ endpoints: [...endpoints, newEndpoint] });
    requestAnimationFrame(() => {
      cardRefs.current[newId]?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  /** Switching provider re-points the endpoint at a different API dialect.
   *  The base URL is only replaced when it still holds the old default. */
  const changeProvider = (id: string, providerKey: string) => {
    const endpoint = endpoints.find((e) => e.id === id);
    const nextProvider = getProvider(providerKey);
    if (!endpoint || !nextProvider) return;
    const prevProvider = getProvider(endpoint.provider);
    const urlIsUntouched =
      !endpoint.baseUrl || endpoint.baseUrl === prevProvider?.defaultBaseUrl;

    updateEndpoint(id, {
      provider: nextProvider.key,
      ...(urlIsUntouched ? { baseUrl: nextProvider.defaultBaseUrl } : {}),
    });
  };

  const removeEndpoint = (id: string) => {
    const next = endpoints.filter((e) => e.id !== id);
    let nextActiveId = config.activeEndpointId;
    if (nextActiveId === id && next.length > 0) nextActiveId = next[0].id;

    // ─── Cascade: clean up agents referencing this endpoint ──
    const agents = (config.agents || []);
    const cleanedAgents = agents.filter((a) => a.endpointId !== id);
    let nextActiveAgentId = config.activeAgentId ?? null;
    if (nextActiveAgentId && !cleanedAgents.find((a) => a.id === nextActiveAgentId)) {
      nextActiveAgentId = cleanedAgents.length > 0 ? cleanedAgents[0].id : null;
    }

    setConfig({
      endpoints: next,
      activeEndpointId: nextActiveId,
      agents: cleanedAgents,
      activeAgentId: nextActiveAgentId,
    });
    setUrlWarnings((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
  };

  // Dropdown options are label-only: ActionDropdown's `description` slot is a
  // short right-aligned hint, so long prose would fight the label for space.
  // The full explanation is shown full-width under the card's provider field.
  const providerOptions = PROVIDER_REGISTRY.map((p) => ({
    label: p.displayName,
    value: p.key,
  }));


  return (
    <div className="flex flex-col gap-4">
      {/* ─── Segment Control (Pill Toggle) ────────────────────── */}
      <div className="flex gap-0.5 p-0.5 rounded-lg bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
        {([
          { value: 'endpoints' as const, label: 'Endpoints', icon: <Key size={12} /> },
          { value: 'agents' as const, label: 'Agents', icon: <Bot size={12} /> },
        ]).map((tab) => {
          const isActive = activeTab === tab.value;
          const count = tab.value === 'agents' ? (config.agents || []).length : 0;
          return (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={`flex-1 relative flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all duration-150 ${
                isActive
                  ? 'bg-[var(--bg-panel)] text-[var(--text-main)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {tab.icon}
              {tab.label}
              {tab.value === 'agents' && count > 0 && (
                <span className="text-[8px] opacity-60">({count})</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ═══ Endpoints Tab ═══ */}
      {activeTab === 'endpoints' && (
        <EndpointsPanel
          config={config}
          setConfig={setConfig}
          endpoints={endpoints}
          urlWarnings={urlWarnings}
          visibleKeys={visibleKeys}
          setVisibleKeys={setVisibleKeys}
          cardRefs={cardRefs}
          updateEndpoint={updateEndpoint}
          handleBaseUrlChange={handleBaseUrlChange}
          addEndpoint={addEndpoint}
          changeProvider={changeProvider}
          removeEndpoint={removeEndpoint}
          providerOptions={providerOptions}
        />
      )}

      {/* ═══ Agents Tab ═══ */}
      {activeTab === 'agents' && (
        <AgentSettings config={config} setConfig={setConfig} />
      )}
    </div>
  );
}

// ─── Endpoints Panel (extracted for tab) ────────────────────────────────────────

function EndpointsPanel({
  config, setConfig, endpoints, urlWarnings,
  visibleKeys, setVisibleKeys, cardRefs,
  updateEndpoint, handleBaseUrlChange, addEndpoint, changeProvider,
  removeEndpoint, providerOptions,
}: {
  config: AIBridgeConfig;
  setConfig: (patch: Partial<AIBridgeConfig>) => void;
  endpoints: AIEndpoint[];
  urlWarnings: Record<string, string | null>;
  visibleKeys: Record<string, boolean>;
  setVisibleKeys: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  cardRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  updateEndpoint: (id: string, patch: Partial<AIEndpoint>) => void;
  handleBaseUrlChange: (id: string, rawUrl: string) => void;
  addEndpoint: (providerKey: string) => void;
  changeProvider: (id: string, providerKey: string) => void;
  removeEndpoint: (id: string) => void;
  providerOptions: Array<{ label: string; value: string }>;
}) {
  const toggleKeyVisibility = (id: string) => {
    setVisibleKeys((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between pl-1">
          <h5 className="text-[10.5px] font-black text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1.5">
            <Key size={11} /> AI Endpoints
          </h5>
          <ActionDropdown
            options={providerOptions}
            onSelect={addEndpoint}
            align="right"
            trigger={
              <span className="flex items-center gap-1 text-[10.5px] font-bold text-amber-500 hover:text-amber-400 transition-colors uppercase tracking-wider cursor-pointer">
                <Plus size={10} /> Add
              </span>
            }
          />
        </div>

        <div className="flex flex-col gap-2">
          {endpoints.map((endpoint) => {
            const isActive = config.activeEndpointId === endpoint.id;
            const warning = urlWarnings[endpoint.id];
            const provider = getProvider(endpoint.provider);
            const providerLabel = provider?.displayName
              ?? `Unknown (${endpoint.provider || DEFAULT_PROVIDER_KEY})`;

            return (
              <div
                key={endpoint.id}
                ref={(el) => { cardRefs.current[endpoint.id] = el; }}
                className={`flex flex-col gap-2.5 p-2.5 rounded-xl border bg-[var(--bg-stage)] transition-all ${
                  isActive ? "border-amber-500/50" : "border-[var(--border-subtle)]"
                }`}
              >
                {/* Header: activate + editable name + delete */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    <button
                      onClick={() => setConfig({ activeEndpointId: endpoint.id })}
                      className={`p-1 rounded-full transition-colors ${
                        isActive
                          ? "text-amber-500"
                          : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                      }`}
                      title={isActive ? "Active endpoint" : "Set as active"}
                    >
                      <CheckCircle2 size={14} className={isActive ? "opacity-100" : "opacity-50"} />
                    </button>
                    <input
                      type="text"
                      value={endpoint.name}
                      onChange={(e) => updateEndpoint(endpoint.id, { name: e.target.value })}
                      className="bg-transparent border-none text-[12px] font-bold text-[var(--text-main)] focus:outline-none flex-1 min-w-0 focus:ring-1 focus:ring-amber-500/50 rounded px-1 -ml-1"
                    />
                  </div>
                  {endpoints.length > 1 && (
                    <button
                      onClick={() => removeEndpoint(endpoint.id)}
                      className="text-[var(--text-muted)] hover:text-rose-500 transition-colors p-1"
                      title="Remove endpoint"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>

                <div className="flex flex-col gap-2.5">
                  {/* Provider selection — decides how requests are built */}
                  <div className="flex flex-col gap-1">
                    <span className="text-[10.5px] font-bold text-[var(--text-muted)] uppercase tracking-wider pl-0.5 flex items-center gap-1">
                      <Boxes size={9} /> Provider
                    </span>
                    <ActionDropdown
                      className="w-full block [&>div]:w-full"
                      matchTriggerWidth
                      options={providerOptions.map((o) => ({
                        ...o,
                        checked: o.value === endpoint.provider,
                      }))}
                      onSelect={(key) => changeProvider(endpoint.id, key)}
                      align="left"
                      trigger={(isOpen) => (
                        <button className="w-full flex items-center justify-between gap-1 bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 text-[11.5px] font-bold text-[var(--text-main)] hover:border-amber-500/40 transition-colors focus:outline-none">
                          <span className="truncate">{providerLabel}</span>
                          <ChevronDown
                            size={11}
                            className={`text-[var(--text-muted)] transition-transform shrink-0 ${isOpen ? "rotate-180" : ""}`}
                          />
                        </button>
                      )}
                    />
                    <span className="text-[10.5px] text-[var(--text-muted)] pl-0.5 italic opacity-60 leading-snug">
                      {provider?.description
                        ?? "This endpoint references an unknown provider — pick one from the list."}
                    </span>
                  </div>

                  {/* Base URL */}
                  <div className="flex flex-col gap-1">
                    <span className="text-[10.5px] font-bold text-[var(--text-muted)] uppercase tracking-wider pl-0.5 flex items-center gap-1">
                      <Link size={9} /> Base URL
                    </span>
                    <input
                      type="text"
                      value={endpoint.baseUrl ?? ""}
                      onChange={(e) => handleBaseUrlChange(endpoint.id, e.target.value)}
                      onBlur={(e) => handleBaseUrlChange(endpoint.id, e.target.value)}
                      placeholder={provider?.defaultBaseUrl || "http://localhost:8080"}
                      className={`w-full bg-[var(--bg-panel)] border rounded-lg px-2 py-1.5 text-[11.5px] text-[var(--text-main)] focus:outline-none transition-all ${
                        warning
                          ? "border-amber-500/50 focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
                          : "border-[var(--border-subtle)] focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
                      }`}
                    />
                    {warning && (
                      <div className="flex items-start gap-1 mt-0.5 px-0.5">
                        <AlertCircle size={9} className="text-amber-500 mt-0.5 shrink-0" />
                        <span className="text-[9.5px] font-bold text-amber-500 leading-tight">
                          {warning}
                        </span>
                      </div>
                    )}
                    <span className="text-[10.5px] text-[var(--text-muted)] pl-0.5 italic opacity-60">
                      Enter the base URL only. Paths like /v1/images/generations are added automatically.
                    </span>
                  </div>

                  {/* API Key */}
                  <div className="flex flex-col gap-1">
                    <span className="text-[10.5px] font-bold text-[var(--text-muted)] uppercase tracking-wider pl-0.5 flex items-center gap-1">
                      <Key size={9} /> API Key
                    </span>
                    <div className="relative">
                      <input
                        type={visibleKeys[endpoint.id] ? "text" : "password"}
                        value={endpoint.apiKey}
                        onChange={(e) => updateEndpoint(endpoint.id, { apiKey: e.target.value })}
                        placeholder="sk-..."
                        className="w-full bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 pr-8 text-[11.5px] text-[var(--text-main)] focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all placeholder:text-[var(--text-muted)]"
                      />
                      <button
                        type="button"
                        onClick={() => toggleKeyVisibility(endpoint.id)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors focus:outline-none"
                        title={visibleKeys[endpoint.id] ? "Hide API Key" : "Show API Key"}
                      >
                        {visibleKeys[endpoint.id] ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="px-1 flex items-start gap-1.5 text-[10.5px] text-[var(--text-muted)] font-bold leading-relaxed uppercase tracking-tight italic opacity-60">
        <AlertCircle size={12} className="shrink-0 mt-[1px]" />
        <span>
          Your API keys are stored in your browser&apos;s local storage and are never
          sent to our servers. Add an endpoint, pick the provider that matches your
          service, paste your key, then fetch models.
        </span>
      </p>
    </div>
  );
}
