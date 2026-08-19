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
import {
  ChevronRight,
  ChevronDown,
  FileCode,
  Monitor,
  Layers,
  Check,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  HardDrive,
} from "lucide-react";
import * as Prot from "../protocols";
import { formatBytes } from "./shared";

interface FrameSectionHUDProps {
  frames: Prot.FrameMetric[];
  handleSelectFrame: (frameId: string) => void;
  handleSelectLayer: (frameId: string, layerId: string) => void;
}

/**
 * FrameSection for HUD (compact) mode
 */
export function FrameSectionHUD({ frames, handleSelectFrame, handleSelectLayer }: FrameSectionHUDProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 pl-1 opacity-50">
        <HardDrive size={10} />
        <span className="text-[9px] font-black uppercase tracking-widest">
          Active Workspace
        </span>
      </div>

      {frames.map((frame) => (
        <div
          key={frame.id}
          className="bg-[var(--bg-stage)] rounded-xl border border-[var(--border-subtle)] dark:border-white/[0.08] overflow-hidden"
        >
          {/* Frame Header */}
          <div className="bg-[var(--bg-stage)] px-3 py-1.5 border-b border-[var(--border-subtle)] dark:border-b-white/[0.06] flex items-center justify-between">
            <div
              className="flex items-center gap-1.5 min-w-0 cursor-pointer"
              onClick={() => handleSelectFrame(frame.id)}
            >
              <span className="text-[8px] font-black text-indigo-600 uppercase px-1 rounded bg-indigo-500/10 ">
                Frame
              </span>
              <span className="text-[9px] font-bold text-[var(--text-main)] truncate">
                {frame.name}
              </span>
            </div>
            <span className="text-[8px] font-mono opacity-40">
              #{frame.id.slice(0, 4)}
            </span>
          </div>

          {/* Layers in this frame */}
          <div className="p-2 space-y-1">
            {frame.thumbnail && (
              <div className="flex items-center justify-between text-[9px] p-1 rounded hover transition-colors">
                <span className="text-[var(--text-muted)] flex items-center gap-1">
                  🖼️ Thumbnail
                </span>
                <span className="font-mono opacity-65">
                  {formatBytes(frame.thumbnail.size)}
                </span>
              </div>
            )}
            {frame.layers.map((layer) =>
              layer.asset ? (
                <div
                  key={layer.id}
                  className="flex items-center justify-between text-[9px] p-1 rounded hover cursor-pointer transition-colors"
                  onClick={() => handleSelectLayer(frame.id, layer.id)}
                  title="Click to select layer"
                >
                  <span className="text-[var(--text-main)] truncate max-w-[140px] flex items-center gap-1">
                    📁 {layer.name}
                  </span>
                  <span className="font-mono text-indigo-650 ">
                    {formatBytes(layer.asset.size)}
                  </span>
                </div>
              ) : null,
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

interface FrameTreeNodesProps {
  frames: Prot.FrameMetric[];
  expandedNodes: Record<string, boolean>;
  selectedNodeId: string | null;
  toggleNode: (key: string) => void;
  handleSelectFrame: (frameId: string) => void;
  handleSelectLayer: (frameId: string, layerId: string) => void;
  setSelectedNode: (node: { type: "frame" | "layer" | "asset" | "history"; id: string; data: unknown } | null) => void;
  setHoveredAsset: (asset: Prot.AssetMetric | null) => void;
}

/**
 * Frame tree nodes for expanded dashboard mode
 */
export function FrameTreeNodes({
  frames,
  expandedNodes,
  selectedNodeId,
  toggleNode,
  handleSelectFrame,
  handleSelectLayer,
  setSelectedNode,
  setHoveredAsset,
}: FrameTreeNodesProps) {
  return (
    <>
      {frames.map((frame) => {
        const frameKey = `frame:${frame.id}`;
        const isFrameExpanded = expandedNodes[frameKey] === true;

        return (
          <div key={frame.id} className="flex flex-col">
            <div
              onClick={() => toggleNode(frameKey)}
              className={`flex items-center justify-between py-1 px-2 rounded-lg hover cursor-pointer transition-colors ${selectedNodeId === frame.id ? "bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20 text-indigo-650 " : "text-[var(--text-muted)]"}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {isFrameExpanded ? (
                  <ChevronDown size={11} className="text-[var(--text-muted)]" />
                ) : (
                  <ChevronRight size={11} className="text-[var(--text-muted)]" />
                )}
                <Monitor size={11} className="text-emerald-500 " />
                <span className="font-bold truncate">{frame.name}</span>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-[8px] font-normal text-[var(--text-muted)] ">
                  {frame.canvas.w}x{frame.canvas.h}px
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectFrame(frame.id);
                    setSelectedNode({ type: "frame", id: frame.id, data: frame });
                  }}
                  className="p-0.5 rounded bg-[var(--bg-stage)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-stage)] "
                  title="Activate frame in workspace"
                >
                  <Check size={8} />
                </button>
              </div>
            </div>

            {/* Expanded Frame items */}
            {isFrameExpanded && (
              <div className="pl-4 border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] ml-3 mt-0.5 space-y-1">
                {/* Frame Thumbnail Item */}
                {frame.thumbnail && (
                  <div
                    onClick={() =>
                      setSelectedNode({ type: "asset", id: frame.thumbnail!.id, data: frame.thumbnail })
                    }
                    onMouseEnter={() => setHoveredAsset(frame.thumbnail || null)}
                    onMouseLeave={() => setHoveredAsset(null)}
                    className="flex items-center justify-between py-0.5 px-2 rounded hover cursor-pointer text-[var(--text-muted)] "
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FileCode size={10} className="text-[var(--text-muted)] " />
                      <span className="truncate">thumbnail.raw</span>
                    </div>
                    <span className="text-[8px] opacity-60">
                      {formatBytes(frame.thumbnail.size)}
                    </span>
                  </div>
                )}

                {/* Frame Layers collection */}
                <div className="flex flex-col">
                  <div
                    onClick={() => toggleNode(`${frameKey}:layers`)}
                    className="flex items-center gap-1.5 py-0.5 px-2 text-[var(--text-muted)] cursor-pointer"
                  >
                    {expandedNodes[`${frameKey}:layers`] !== false ? (
                      <ChevronDown size={10} />
                    ) : (
                      <ChevronRight size={10} />
                    )}
                    <Layers size={10} />
                    <span>layers ({frame.layers.length})</span>
                  </div>

                  {expandedNodes[`${frameKey}:layers`] !== false && (
                    <div className="pl-3 border-l border-[var(--border-subtle)] dark:border-l-white/[0.06] ml-3.5 space-y-0.5">
                      {frame.layers.map((layer) => (
                        <div
                          key={layer.id}
                          onClick={() =>
                            setSelectedNode({ type: "layer", id: layer.id, data: { ...layer, frameId: frame.id } })
                          }
                          className={`flex items-center justify-between py-0.5 px-2 rounded hover cursor-pointer transition-colors ${selectedNodeId === layer.id ? "bg-indigo-500/10 text-indigo-500 font-bold" : "text-[var(--text-muted)]"}`}
                          onMouseEnter={() => layer.asset && setHoveredAsset(layer.asset)}
                          onMouseLeave={() => setHoveredAsset(null)}
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[var(--text-muted)] ">•</span>
                            <span className="truncate">{layer.name}</span>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <div className="flex items-center gap-1">
                              {layer.visible ? (
                                <Eye size={9} className="text-[var(--text-muted)] " />
                              ) : (
                                <EyeOff size={9} className="text-rose-500" />
                              )}
                              {layer.locked ? (
                                <Lock size={9} className="text-[var(--text-muted)] " />
                              ) : (
                                <Unlock size={9} className="text-[var(--text-muted)] " />
                              )}
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSelectLayer(frame.id, layer.id);
                                setSelectedNode({ type: "layer", id: layer.id, data: { ...layer, frameId: frame.id } });
                              }}
                              className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-stage)] "
                              title="Select layer on canvas"
                            >
                              <Check size={8} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
