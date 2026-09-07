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

import React, { useMemo } from "react";
import {
  Plus, Trash2, CheckCircle2, Bot, AlertCircle,
} from "lucide-react";
import Switch from "@opengpex/editor/widgets/Switch";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import type {
  AIBridgeConfig, AIEndpoint, AIModelInfo, AgentDef, AgentBehaviorPreset,
} from "../protocols";

interface AgentSettingsProps {
  config: AIBridgeConfig;
  setConfig: (patch: Partial<AIBridgeConfig>) => void;
}

/** Filter models suitable for Agent chat (exclude pure image-only). */
function agentModels(models: AIModelInfo[] | undefined): AIModelInfo[] {
  if (!models?.length) return [];
  return models.filter((m) => m.modality !== "image");
}

/** Endpoints that have an API key configured. */
function usableEndpoints(endpoints: AIEndpoint[]): AIEndpoint[] {
  return endpoints.filter((e) => e.apiKey);
}

export function AgentSettings({ config, setConfig }: AgentSettingsProps) {
  const agents: AgentDef[] = config.agents || [];
  const cachedModels = config.cachedModels || {};
  const validEndpoints = useMemo(() => usableEndpoints(config.endpoints || []), [config.endpoints]);

  const enableAgents = config.enableAgents ?? true;

  const updateAgent = (id: string, patch: Partial<AgentDef>) => {
    setConfig({
      agents: agents.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    });
  };

  const addAgent = () => {
    const defaultEp = validEndpoints[0];
    const newId = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const models = defaultEp ? agentModels(cachedModels[defaultEp.id]) : [];
    const newAgent: AgentDef = {
      id: newId, name: "New Agent",
      endpointId: defaultEp?.id || "", model: models[0]?.id || "",
    };
    setConfig({
      agents: [...agents, newAgent],
      ...(config.activeAgentId == null ? { activeAgentId: newId } : {}),
    });
  };

  const removeAgent = (id: string) => {
    const next = agents.filter((a) => a.id !== id);
    let nextActiveId = config.activeAgentId;
    if (nextActiveId === id) nextActiveId = next.length > 0 ? next[0].id : null;
    setConfig({ agents: next, activeAgentId: nextActiveId });
  };

  const activateAgent = (id: string) => {
    setConfig({ activeAgentId: id });
  };

  const changeEndpoint = (agentId: string, endpointId: string) => {
    const models = agentModels(cachedModels[endpointId]);
    updateAgent(agentId, { endpointId, model: models[0]?.id || "" });
  };

  const endpointOptions = validEndpoints.map((ep) => ({
    label: ep.name, value: ep.id,
  }));

  const modelOptionsFor = (endpointId: string) =>
    agentModels(cachedModels[endpointId]).map((m) => ({
      label: `${m.id}${m.modality ? ` (${m.modality})` : ""}`, value: m.id,
    }));

  return (
    <div className="flex flex-col gap-6">
      {/* Enable Agents Toggle */}
      <button
        onClick={() => setConfig({ enableAgents: !enableAgents })}
        className="flex items-center justify-between w-full p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] group"
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${enableAgents ? "bg-amber-500/10 text-amber-500" : "bg-[var(--bg-stage)] text-[var(--text-muted)]"}`}
          >
            <Bot size={14} />
          </div>
          <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
            Enable Agents
          </span>
        </div>
        <Switch
          checked={enableAgents}
          onChange={(v: boolean) => setConfig({ enableAgents: v })}
          activeColor="bg-amber-500"
        />
      </button>

      <div className={`flex flex-col gap-6 transition-opacity ${enableAgents ? "" : "opacity-40 pointer-events-none select-none"}`}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between pl-1">
          <h5 className="text-[10.5px] font-black text-[var(--text-muted)] uppercase tracking-widest flex items-center gap-1.5">
            <Bot size={14} /> Agents
          </h5>
          <button onClick={addAgent} className="flex items-center gap-1 text-[10.5px] font-bold text-amber-500 hover:text-amber-400 transition-colors uppercase tracking-wider cursor-pointer">
            <Plus size={10} /> Add
          </button>
        </div>

        <div className="flex flex-col gap-2">
          {agents.map((agent) => {
            const isActive = config.activeAgentId === agent.id;
            const ep = (config.endpoints || []).find((e) => e.id === agent.endpointId);
            const epLabel = ep?.name || "No endpoint";
            const modelOpts = modelOptionsFor(agent.endpointId);
            return (
              <AgentCard
                key={agent.id}
                agent={agent}
                isActive={isActive}
                epLabel={epLabel}
                endpointOptions={endpointOptions}
                modelOptions={modelOpts}
                noEndpoints={validEndpoints.length === 0}
                onActivate={activateAgent}
                onRemove={removeAgent}
                onNameChange={(name) => updateAgent(agent.id, { name })}
                onEndpointChange={(v) => changeEndpoint(agent.id, v)}
                onModelChange={(v) => updateAgent(agent.id, { model: v })}
                onBehaviorChange={(v) => updateAgent(agent.id, { behaviorPreset: v })}
              />
            );
          })}
        </div>
      </div>

      <p className="px-1 flex items-start gap-1.5 text-[10.5px] text-[var(--text-muted)] font-bold leading-relaxed uppercase tracking-tight italic opacity-60">
        <AlertCircle size={12} className="shrink-0 mt-[1px]" />
        <span>
          Agents use your configured endpoints. Each agent pairs an endpoint with a
          chat-capable model. The active agent (✓) is used in the conversation panel.
        </span>
      </p>
      </div>
    </div>
  );
}

// ─── AgentCard — inline-editable, no Save/Cancel ─────────────────────────────

function AgentCard({ agent, isActive, epLabel, endpointOptions, modelOptions, noEndpoints,
  onActivate, onRemove, onNameChange, onEndpointChange, onModelChange, onBehaviorChange,
}: {
  agent: AgentDef; isActive: boolean; epLabel: string;
  endpointOptions: Array<{ label: string; value: string }>;
  modelOptions: Array<{ label: string; value: string }>;
  noEndpoints: boolean;
  onActivate: (id: string) => void; onRemove: (id: string) => void;
  onNameChange: (name: string) => void;
  onEndpointChange: (endpointId: string) => void;
  onModelChange: (model: string) => void;
  onBehaviorChange: (preset: AgentBehaviorPreset) => void;
}) {
  const BEHAVIOR_OPTIONS: { id: AgentBehaviorPreset; label: string }[] = [
    { id: 'auto', label: 'Auto' },
    { id: 'concise', label: 'Concise' },
    { id: 'detailed', label: 'Detailed' },
  ];
  return (
    <div className={`flex flex-col gap-2.5 p-2.5 rounded-xl border bg-[var(--bg-stage)] transition-all ${
      isActive ? "border-amber-500/50" : "border-[var(--border-subtle)]"
    }`}>
      {/* Header: activate + editable name + delete */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <button
            onClick={() => onActivate(agent.id)}
            className={`p-1 rounded-full transition-colors ${
              isActive ? "text-amber-500" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
            }`}
            title={isActive ? "Active agent" : "Set as active"}
          >
            <CheckCircle2 size={14} className={isActive ? "opacity-100" : "opacity-50"} />
          </button>
          <input
            type="text"
            value={agent.name}
            onChange={(e) => onNameChange(e.target.value)}
            className="flex-1 bg-transparent border-none text-[12px] font-bold text-[var(--text-main)] focus:outline-none truncate min-w-0 placeholder:text-[var(--text-muted)]"
            placeholder="Agent name"
          />
        </div>
        <button
          onClick={() => onRemove(agent.id)}
          className="p-1 rounded-md text-[var(--text-muted)] hover:text-rose-400 transition-colors"
          title="Delete agent"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* Fields */}
      <div className="flex flex-col gap-2.5 pl-1">
        {/* Endpoint */}
        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-bold text-[var(--text-muted)] uppercase tracking-wider pl-0.5">
            Endpoint
          </span>
          {noEndpoints ? (
            <div className="flex items-start gap-1 px-0.5">
              <AlertCircle size={9} className="text-amber-500 mt-0.5 shrink-0" />
              <span className="text-[9.5px] font-bold text-amber-500 leading-tight">
                No endpoints with API keys. Configure one in the Endpoints tab first.
              </span>
            </div>
          ) : (
            <ActionDropdown
              options={endpointOptions}
              onSelect={onEndpointChange}
              trigger={
                <span className="flex items-center w-full px-2 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[11.5px] text-[var(--text-main)] cursor-pointer hover:border-[var(--text-muted)] transition-colors truncate">
                  {epLabel}
                </span>
              }
              matchTriggerWidth
            />
          )}
        </div>

        {/* Model */}
        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-bold text-[var(--text-muted)] uppercase tracking-wider pl-0.5">
            Model
          </span>
          {!agent.endpointId ? (
            <span className="text-[10px] text-[var(--text-muted)] italic pl-0.5">
              Select an endpoint first
            </span>
          ) : modelOptions.length === 0 ? (
            <div className="flex items-start gap-1 px-0.5">
              <AlertCircle size={9} className="text-[var(--text-muted)] mt-0.5 shrink-0" />
              <span className="text-[9.5px] text-[var(--text-muted)] leading-tight italic">
                No chat models — Fetch Models in the Endpoints tab first.
              </span>
            </div>
          ) : (
            <ActionDropdown
              options={modelOptions}
              onSelect={onModelChange}
              trigger={
                <span className="flex items-center w-full px-2 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[11.5px] text-[var(--text-main)] cursor-pointer hover:border-[var(--text-muted)] transition-colors truncate">
                  {agent.model || "Select model…"}
                </span>
              }
              matchTriggerWidth
              maxVisibleItems={8}
            />
          )}
        </div>

        {/* Behavior Preset */}
        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-bold text-[var(--text-muted)] uppercase tracking-wider pl-0.5">
            Behavior
          </span>
          <div className="flex bg-[var(--bg-panel)] rounded-lg p-0.5 gap-0.5">
            {BEHAVIOR_OPTIONS.map((opt) => {
              const active = (agent.behaviorPreset || 'auto') === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => onBehaviorChange(opt.id)}
                  className={`flex-1 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all ${
                    active
                      ? "bg-amber-500/15 text-amber-500"
                      : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
