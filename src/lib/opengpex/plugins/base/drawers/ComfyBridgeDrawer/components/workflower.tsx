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

'use client';

import React, { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Layers, Frame, FileJson, Trash, Dices } from 'lucide-react';
import StatusBanner from '@opengpex/editor/widgets/StatusBanner';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import ComfyNumberInput from '@opengpex/editor/widgets/ComfyNumberInput';
import FunctionTabs from '@opengpex/editor/widgets/FunctionTabs';
import Tooltip from '@opengpex/editor/widgets/Tooltip';
import type { ExposedParam, TextConfig, NumberConfig, PromptConfig, ComboConfig, UserWorkflow, InputSource } from '../protocols';

// ─── Object Info Types ─────────────────────────────────────────────────────────

/** Raw /object_info entry for a single node input */
// type ObjectInfoInputDef = [string | string[], Record<string, unknown>?];

// interface ObjectInfoNode {
//   input?: {
//     required?: Record<string, ObjectInfoInputDef>;
//     optional?: Record<string, ObjectInfoInputDef>;
//   };
// }

// ─── Workflow Selector ─────────────────────────────────────────────────────────

export interface WorkflowSelectorProps {
  workflows: UserWorkflow[];
  activeWorkflow: UserWorkflow | null;
  paramValues: Record<string, unknown>;
  randomSeedPaths: string[];
  /** Whether a frame currently exists (img2img workflows need this) */
  hasFrame: boolean;
  onSelectWorkflow: (wfId: string | null) => void;
  onParamChange: (path: string, value: unknown) => void;
  onToggleRandomSeed: (path: string, isRandom: boolean) => void;
}

export function WorkflowSelector({ workflows, activeWorkflow, paramValues, randomSeedPaths, hasFrame, onSelectWorkflow, onParamChange, onToggleRandomSeed }: WorkflowSelectorProps) {
  // Build dropdown options — disable img2img workflows when no frame exists
  const options = workflows.map(wf => ({
    value: wf.id,
    label: `${wf.name}`,
    description: wf.mode,
    disabled: wf.mode === 'img2img' && !hasFrame,
  }));

  const handleSelect = (value: string) => {
    onSelectWorkflow(value);
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Full-width workflow dropdown */}
      <ActionDropdown
        options={options}
        onSelect={handleSelect}
        trigger={(isOpen) => (
          <div className="flex items-center justify-between w-full px-2.5 py-1.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)] cursor-pointer hover:border-emerald-500/30 transition-colors">
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <FileJson size={10} className="text-[var(--text-muted)] shrink-0" />
              <span className="text-[10px] font-bold text-[var(--text-main)] truncate">
                {activeWorkflow?.name || 'Select workflow…'}
              </span>
              {activeWorkflow && (
                <span className={`text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full border shrink-0 ${
                  activeWorkflow.mode === 'img2img'
                    ? 'text-cyan-600 border-cyan-500/30 bg-cyan-500/10'
                    : 'text-amber-600 border-amber-500/30 bg-amber-500/10'
                }`}>
                  {activeWorkflow.mode}
                </span>
              )}
            </div>
            <ChevronDown
              size={10}
              className={`text-[var(--text-muted)] transition-transform duration-200 shrink-0 ${isOpen ? 'rotate-180' : ''}`}
            />
          </div>
        )}
      />

      {/* Exposed params — flat layout, sorted: positive prompt → negative prompt → others */}
      {activeWorkflow && activeWorkflow.exposedParams.length > 0 && (
        <SortedParams
          params={activeWorkflow.exposedParams}
          paramValues={paramValues}
          randomSeedPaths={randomSeedPaths}
          onParamChange={onParamChange}
          onToggleRandomSeed={onToggleRandomSeed}
        />
      )}
    </div>
  );
}

// ─── Sorted Params ─────────────────────────────────────────────────────────────

/**
 * Renders params in sorted order: positive prompt first, negative prompt second, then others.
 */
function SortedParams({ params, paramValues, randomSeedPaths, onParamChange, onToggleRandomSeed }: { params: ExposedParam[]; paramValues: Record<string, unknown>; randomSeedPaths: string[]; onParamChange: (path: string, val: unknown) => void; onToggleRandomSeed: (path: string, isRandom: boolean) => void }) {
  const sorted = useMemo(() => {
    const positivePrompts: ExposedParam[] = [];
    const negativePrompts: ExposedParam[] = [];
    const others: ExposedParam[] = [];

    for (const p of params) {
      if (p.type === 'prompt') {
        const cfg = p.config as PromptConfig;
        if (cfg.sentiment === 'negative') {
          negativePrompts.push(p);
        } else {
          positivePrompts.push(p);
        }
      } else {
        others.push(p);
      }
    }

    return [...positivePrompts, ...negativePrompts, ...others];
  }, [params]);

  return (
    <div className="flex flex-col gap-2">
      {sorted.map(param => {
        const paramPath = `${param.nodeId}.${param.paramName}`;
        return (
          <ExposedParamControl
            key={paramPath}
            param={param}
            value={paramValues[paramPath]}
            isRandomSeed={randomSeedPaths.includes(paramPath)}
            onChange={(val) => onParamChange(paramPath, val)}
            onToggleRandom={(isRandom) => onToggleRandomSeed(paramPath, isRandom)}
          />
        );
      })}
    </div>
  );
}

// ─── Collapsible Prompt ────────────────────────────────────────────────────────

function CollapsiblePrompt({ param, value, onChange }: { param: ExposedParam; value: unknown; onChange: (val: unknown) => void }) {
  const cfg = param.config as PromptConfig;
  const strVal = typeof value === 'string' ? value : cfg.default;
  const isNeg = cfg.sentiment === 'negative';
  // Negative prompts default collapsed, positive default expanded
  const [collapsed, setCollapsed] = useState(isNeg);

  const label = param.nodeTitle || (isNeg ? 'Negative Prompt' : 'Positive Prompt');
  const preview = strVal.length > 60 ? strVal.slice(0, 60) + '…' : strVal;

  return (
    <div className="flex flex-col bg-[var(--bg-stage)] rounded-xl border border-[var(--border-subtle)] focus-within:border-emerald-500/50 transition-colors">
      {/* Clickable header */}
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-1.5 px-2.5 py-2 w-full text-left"
      >
        {collapsed ? <ChevronRight size={10} className="text-[var(--text-muted)] shrink-0" /> : <ChevronDown size={10} className="text-[var(--text-muted)] shrink-0" />}
        <span className={`text-[8px] font-black uppercase tracking-tight ${isNeg ? 'text-rose-500/80' : 'text-emerald-500/80'}`}>
          {label}
        </span>
        {collapsed && strVal.length > 0 && (
          <span className="text-[9px] text-[var(--text-muted)] truncate flex-1 ml-1 opacity-60">
            {preview}
          </span>
        )}
        {!collapsed && strVal.length > 0 && (
          <span className="ml-auto shrink-0" onClick={(e) => { e.stopPropagation(); onChange(''); }}>
            <Trash size={10} className="text-[var(--text-muted)] hover:text-rose-500 transition-colors" />
          </span>
        )}
      </button>
      {/* Textarea (shown when expanded) */}
      {!collapsed && (
        <div className="px-2 pb-2">
          <textarea
            value={strVal}
            onChange={(e) => onChange(e.target.value)}
            placeholder={cfg.placeholder || 'Describe what you want...'}
            className={`w-full bg-transparent border-none text-[11px] text-[var(--text-main)] resize-none focus:outline-none placeholder:text-[var(--text-muted)] leading-relaxed px-1 ${isNeg ? 'h-[136px]' : 'h-48'}`}
          />
        </div>
      )}
    </div>
  );
}

// ─── Exposed Parameter Control ─────────────────────────────────────────────────

/** Helper: detect if a param represents a seed value */
function isSeedParam(param: ExposedParam): boolean {
  if (param.type !== 'number') return false;
  const inputName = param.paramName.toLowerCase();
  return inputName === 'seed' || inputName.includes('seed');
}

function ExposedParamControl({ param, value, isRandomSeed, onChange, onToggleRandom }: { param: ExposedParam; value: unknown; isRandomSeed: boolean; onChange: (val: unknown) => void; onToggleRandom: (isRandom: boolean) => void }) {
  const displayLabel = param.paramName;

  // Prompt textarea (AIBridgeDrawer style) with collapsible chevron
  if (param.type === 'prompt') {
    return <CollapsiblePrompt param={param} value={value} onChange={onChange} />;
  }

  // Number input (ComfyNumberInput with +/- buttons)
  if (param.type === 'number') {
    const cfg = param.config as NumberConfig;
    const numVal = typeof value === 'number' ? value : cfg.default;
    const isSeed = isSeedParam(param);

    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1">
          <div className="flex-1">
            <ComfyNumberInput
              label={displayLabel}
              value={numVal}
              onChange={(v: number) => onChange(v)}
              decimals={cfg.decimals}
            />
          </div>
          {isSeed && (
            <Tooltip align="end" content={isRandomSeed ? 'Random seed (click to fix)' : 'Fixed seed (click to randomize)'} position="bottom">
              <button
                onClick={() => onToggleRandom(!isRandomSeed)}
                className={`flex items-center justify-center w-[26px] h-[26px] rounded-lg border transition-all focus:outline-none shrink-0 ${
                  isRandomSeed
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                    : 'bg-[var(--bg-stage)] border-[var(--border-subtle)] text-[var(--text-muted)] hover:border-emerald-500/30 hover:text-emerald-500'
                }`}
              >
                <Dices size={10} />
              </button>
            </Tooltip>
          )}
        </div>
        {isSeed && isRandomSeed && (
          <span className="text-[8px] font-bold text-emerald-600 dark:text-emerald-400 pl-1">
            New random seed on each run
          </span>
        )}
      </div>
    );
  }

  // Combo dropdown (select with options, fallback to text when options empty)
  if (param.type === 'combo') {
    const cfg = param.config as ComboConfig;
    const strVal = typeof value === 'string' ? value : cfg.default;

    // Fallback to text input when options not yet synced
    if (cfg.options.length === 0) {
      return (
        <div className="flex items-center gap-1.5 w-full">
          <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-14 shrink-0 truncate" title={`${param.nodeClass}.${param.paramName}`}>
            {displayLabel}
          </span>
          <input
            type="text"
            value={strVal}
            onChange={(e) => onChange(e.target.value)}
            placeholder={`Enter ${param.paramName}`}
            className="flex-1 h-[26px] bg-[var(--bg-stage)] border border-[var(--border-subtle)] rounded-lg px-2 text-[10px] font-black text-[var(--text-main)] tabular-nums focus:outline-none focus:border-emerald-500/50"
          />
        </div>
      );
    }

    const comboOptions = cfg.options.map(opt => ({
      value: opt,
      label: opt,
      checked: opt === strVal,
    }));

    return (
      <div className="flex items-center gap-1.5 w-full">
        <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-14 shrink-0 truncate" title={`${param.nodeClass}.${param.paramName}`}>
          {displayLabel}
        </span>
        <div className="flex-1 min-w-0 overflow-hidden">
          <ActionDropdown
            className="w-full"
            options={comboOptions}
            onSelect={(val) => onChange(val)}
            matchTriggerWidth
            maxVisibleItems={15}
            trigger={(isOpen) => (
              <div className="flex items-center justify-between w-full h-[26px] bg-[var(--bg-stage)] border border-[var(--border-subtle)] rounded-lg px-2 cursor-pointer hover:border-emerald-500/30 transition-colors">
                <span className="text-[10px] font-black text-[var(--text-main)] truncate flex-1 min-w-0">
                  {strVal}
                </span>
                <ChevronDown
                  size={10}
                  className={`text-[var(--text-muted)] transition-transform duration-200 shrink-0 ml-1 ${isOpen ? 'rotate-180' : ''}`}
                />
              </div>
            )}
          />
        </div>
      </div>
    );
  }

  // Text input (full-width)
  if (param.type === 'text') {
    const cfg = param.config as TextConfig;
    const strVal = typeof value === 'string' ? value : cfg.default;

    if (cfg.multiline) {
      return (
        <div className="flex flex-col bg-[var(--bg-stage)] p-2 rounded-xl border border-[var(--border-subtle)] focus-within:border-emerald-500/50 transition-colors">
          <span className="text-[8px] font-black text-[var(--text-muted)] uppercase tracking-tight mb-1.5 px-1">
            {displayLabel}
          </span>
          <textarea
            value={strVal}
            onChange={(e) => onChange(e.target.value)}
            placeholder={cfg.placeholder || ''}
            className="w-full h-24 bg-transparent border-none text-[11px] text-[var(--text-main)] resize-none focus:outline-none placeholder:text-[var(--text-muted)] leading-relaxed px-1"
          />
        </div>
      );
    }

    return (
      <div className="flex items-center gap-1.5 w-full">
        <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-14 shrink-0 truncate" title={`${param.nodeClass}.${param.paramName}`}>
          {displayLabel}
        </span>
        <input
          type="text"
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          placeholder={cfg.placeholder || ''}
          className="flex-1 h-[26px] bg-[var(--bg-stage)] border border-[var(--border-subtle)] rounded-lg px-2 text-[10px] font-black text-[var(--text-main)] tabular-nums focus:outline-none focus:border-emerald-500/50"
        />
      </div>
    );
  }

  return null;
}

// ─── Input Source Selector ─────────────────────────────────────────────────────

export interface InputSourceSelectorProps {
  inputSource: InputSource;
  hasActiveLayer: boolean;
  disabled?: boolean;
  onChangeSource: (src: InputSource) => void;
}

/**
 * Segmented toggle for choosing img2img input: Active Layer vs Merged Frame.
 * Uses FunctionTabs size="sm" for compact styling consistent with the design system.
 * Shows a status banner below indicating readiness.
 */
export function InputSourceSelector({ inputSource, hasActiveLayer, disabled, onChangeSource }: InputSourceSelectorProps) {
  const options = [
    { value: 'active-layer' as InputSource, label: 'Layer', icon: <Layers size={10} /> },
    { value: 'merged-frame' as InputSource, label: 'Frame', icon: <Frame size={10} /> },
  ];

  // Status logic
  const isReady = inputSource === 'merged-frame' || hasActiveLayer;
  const statusTitle = inputSource === 'merged-frame'
    ? 'Using merged frame as input'
    : hasActiveLayer
      ? 'Using active layer as input'
      : 'Select an image layer first';

  return (
    <div className="flex flex-col gap-1.5">
      <FunctionTabs
        options={options}
        value={inputSource}
        onChange={onChangeSource}
        disabled={disabled}
        size="sm"
      />

      {/* Status banner */}
      <StatusBanner
        variant={isReady ? 'emerald' : 'amber'}
        icon={inputSource === 'merged-frame' ? <Frame size={14} /> : <Layers size={14} />}
        title={statusTitle}
      />
    </div>
  );
}
