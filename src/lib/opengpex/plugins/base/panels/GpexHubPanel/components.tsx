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

import React, { useState, useMemo } from "react";
import {
  Store,
  Power,
  PowerOff,
  Package,
  PanelRight,
  Layers,
  Tv,
  Grid,
  Cpu,
  ShieldCheck,
  User,
  Upload,
  Trash2,
} from "lucide-react";
import { PopupPanel } from "@opengpex/editor/widgets/PopupPanel";
import FunctionButton from "@opengpex/editor/widgets/FunctionButton";
import FancyConfirm from "@opengpex/editor/widgets/FancyConfirm";
import TabSwitcher from "@opengpex/editor/widgets/TabSwitcher";
import { useGpexHubConfig } from "./hooks";
import {
  useEditorServices,
  usePluginList,
} from "@opengpex/editor/core/context";
import {
  EditorPlugin,
  BuiltPlugin,
  PluginManifest,
} from "@opengpex/editor/core/types";
import { PLUGINS as USER_PLUGINS } from "@opengpex/editor/plugins/registry-user";
import { IS_CLOUD_MODE } from "@opengpex/editor/core/helpers/config";

interface ExtendedPlugin extends BuiltPlugin {
  id: string;
  sourceType: "base" | "community" | "user";
  isSelfUploaded: boolean;
  _folderName?: string;
  _variant: "static" | "dynamic";
}

export const GpexHubTrigger = React.memo(function GpexHubTrigger() {
  const { toggle, isOpen } = useGpexHubConfig();
  return (
    <div id="trigger-gpexhub">
      <FunctionButton
        onClick={toggle}
        active={isOpen}
        title="GPEX-Hub"
        tooltipPosition="right"
        {...({ "data-panel-toggle": "gpexhub" } as Record<string, string>)}
      >
        <Store
          size={18}
          className={`transition-transform duration-500 ${isOpen ? "scale-110 text-indigo-500" : ""}`}
        />
      </FunctionButton>
    </div>
  );
});

export const GpexHubPanel = React.memo(function GpexHubPanel() {
  const { toggle, isOpen, activeTab, setActiveTab, panelPosition } =
    useGpexHubConfig();

  return (
    <PopupPanel
      isVisible={isOpen}
      onClose={toggle}
      size="lg"
      title="GPEX-Hub"
      subTitle="Extension & Plugin Registry"
      icon={<Store size={18} />}
      anchor="trigger-gpexhub"
      position={panelPosition}
      closeOnOutsideClick={false}
      // 👈 Removed legacy size and rounded corners like w-[800px] h-[700px] p-5, directly inheriting new panel's 1120x720 premium container
      // If still wishing to strictly limit width to 800px, uncomment the next line:
      // className="w-[800px]"
    >
      {/* Fine-tuning inner content area:
        1. Removed redundant rounded-xl and border on outer layer (since new container wraps beautifully)
        2. Removed fixed min-height min-h-[550px], letting content area automatically fill flex-1 of the large HUD container
      */}
      <div className="flex flex-col h-full overflow-hidden">
        {/* Tab navigation switch */}
        <TabSwitcher
          tabs={[
            { id: "explore", label: "Exploring" },
            { id: "installed", label: "Installed" },
          ]}
          activeTab={activeTab}
          onTabChange={(id) => setActiveTab(id as "explore" | "installed")}
        />

        {/* Core content rendering view: perfectly fills large HUD blank area */}
        <div className="flex-1 overflow-hidden relative mt-4">
          {activeTab === "explore" && <ExploreTab />}
          {activeTab === "installed" && <InstalledTab />}
        </div>
      </div>
    </PopupPanel>
  );
});

function ExploreTab() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-panel)]/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 max-w-sm text-center px-8">
        <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 dark:bg-indigo-500/15 flex items-center justify-center border border-indigo-500/20">
          <Store size={28} className="text-indigo-500 animate-pulse" />
        </div>
        <div>
          <h3 className="text-base font-black text-[var(--text-main)] mb-1.5 tracking-tight">
            Coming Soon
          </h3>
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            The GPEX Plugin Marketplace is under development.
            <br />
            Verified community plugins will be available for one-click install
            here.
          </p>
        </div>
        <div className="flex items-center gap-2 mt-2 px-4 py-2 rounded-lg bg-amber-500/10 dark:bg-amber-500/8 border border-amber-500/20">
          <span className="text-amber-600 dark:text-amber-400 text-[10px] font-bold uppercase tracking-wider">
            ⚠️ For now, use the &quot;Installed&quot; tab to upload .zip plugins
            manually
          </span>
        </div>
      </div>
    </div>
  );
}

function InstalledTab() {
  const { plugins } = useEditorServices();
  const pluginList = usePluginList();
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string>("all");

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<ExtendedPlugin | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Tracks which user plugins are explicitly ENABLED (allowlist approach).
  // User plugins default to disabled unless present in this map with value `true`.
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>(() => {
    if (typeof localStorage !== "undefined") {
      try {
        const stored = localStorage.getItem("gpex_enabled_user_plugins");
        if (stored) return JSON.parse(stored);
      } catch {}
    }
    return {};
  });

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const staticUserUids = useMemo(() => {
    const getPluginUid = (
      manifest: Partial<PluginManifest> | undefined,
      folderName: string,
    ): string => {
      const rawAuthor = manifest?.author || "anonymous";
      const author = rawAuthor.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
      const manifestId = manifest?.id || folderName;
      return `${author}.${manifestId}`;
    };
    return new Set(
      (USER_PLUGINS as EditorPlugin[]).map((p) =>
        getPluginUid(
          p.manifest,
          (p as { _folderName?: string })._folderName || "",
        ),
      ),
    );
  }, []);

  const allInstalledPlugins: ExtendedPlugin[] = useMemo(() => {
    return pluginList.map((p) => {
      const isUser = p.sourceType === "user";
      const isDynamic = isUser && !staticUserUids.has(p.uid);
      return {
        ...p,
        id: p.uid,
        sourceType: (p.sourceType || "base") as "base" | "community" | "user",
        isSelfUploaded: isUser,
        _variant: isDynamic ? "dynamic" : "static",
      };
    });
  }, [pluginList, staticUserUids]);

  const uploadPluginFile = async (file: File) => {
    if (!file || !file.name.endsWith(".zip")) {
      alert("Please upload a .zip plugin file.");
      return;
    }

    setUploading(true);
    try {
      const buffer = await file.arrayBuffer();
      const res = await fetch("/api/plugins/upload", {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: buffer,
      });
      const data = (await res.json()) as {
        success: boolean;
        conflictingStaticUid?: string;
        error?: string;
      };
      if (data.success) {
        if (data.conflictingStaticUid) {
          try {
            const stored = localStorage.getItem("gpex_enabled_user_plugins");
            const map = stored ? JSON.parse(stored) : {};
            map[data.conflictingStaticUid] = false;
            localStorage.setItem(
              "gpex_enabled_user_plugins",
              JSON.stringify(map),
            );
          } catch {}
        }
        window.location.reload();
      } else {
        alert("Upload failed: " + data.error);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      alert("Upload error: " + errMsg);
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file) {
      await uploadPluginFile(file);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await uploadPluginFile(file);
    }
  };

  const handleDragDropClick = () => {
    fileInputRef.current?.click();
  };

  const togglePlugin = (pluginId: string, currentlyEnabled: boolean) => {
    const newMap = { ...enabledMap, [pluginId]: !currentlyEnabled };
    setEnabledMap(newMap);
    localStorage.setItem("gpex_enabled_user_plugins", JSON.stringify(newMap));
    window.location.reload();
  };

  // Filter plugins based on the active filter state
  const filteredPlugins = allInstalledPlugins.filter((p) => {
    const category = p.manifest?.category?.toLowerCase() || "";
    if (activeFilter === "all") return true;
    if (activeFilter === "drawers") return category === "drawers";
    if (activeFilter === "panels") return category === "panels";
    if (activeFilter === "overlays") return category === "overlays";
    if (activeFilter === "options") return category === "options";
    if (activeFilter === "backstage") return category === "backstage";
    if (activeFilter === "preinstalled")
      return p.sourceType === "base" || p.sourceType === "community";
    if (activeFilter === "user") return p.sourceType === "user";
    return true;
  });

  // Handle confirmed delete
  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    const folderId = deleteTarget._folderName || deleteTarget.id;
    const uid = deleteTarget.id;
    setDeleteTarget(null);
    try {
      const res = await fetch("/api/plugins/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId: folderId }),
      });
      const data = (await res.json()) as { success: boolean; error?: string };
      if (data.success) {
        // Unregister from the plugin list in memory
        plugins.unregisterPlugin(uid);

        // Also clean up enable state
        const newMap = { ...enabledMap };
        delete newMap[uid];
        setEnabledMap(newMap);
        localStorage.setItem(
          "gpex_enabled_user_plugins",
          JSON.stringify(newMap),
        );
      } else {
        setDeleteError("Delete failed: " + data.error);
      }
    } catch (err) {
      setDeleteError(
        "Delete error: " + (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  return (
    <div className="absolute inset-0 flex">
      {/* Hidden File Input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".zip"
        className="hidden"
      />

      {/* Delete Confirmation Dialog */}
      <FancyConfirm
        isVisible={!!deleteTarget}
        title="Delete Plugin"
        message={`Permanently delete "${deleteTarget?._folderName || deleteTarget?.id}" from disk? This action cannot be undone.`}
        type="danger"
        variant="square"
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Error/Warning Dialog (single-button alert mode) */}
      <FancyConfirm
        isVisible={!!deleteError}
        title="Warning"
        message={deleteError || ""}
        type="warning"
        variant="square"
        mode="alert"
        confirmText="OK"
        onConfirm={() => setDeleteError(null)}
        onCancel={() => setDeleteError(null)}
      />

      {/* Left Sidebar: Unified Categories, Sources & Upload Action */}
      <div className="w-52 shrink-0 border-r border-zinc-200 dark:border-zinc-800 p-4 flex flex-col justify-between h-full bg-[var(--bg-panel)]/10">
        {/* Scrollable Categories List */}
        <div className="flex-1 overflow-y-auto space-y-5 pr-1">
          {/* Section 1: By Type */}
          <div>
            <div className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 mb-2 tracking-wider uppercase">
              Plugin Types
            </div>
            <div className="space-y-1">
              <SidebarButton
                active={activeFilter === "all"}
                onClick={() => setActiveFilter("all")}
                icon={<Package size={13} />}
                label="All Plugins"
                count={allInstalledPlugins.length}
              />
              <SidebarButton
                active={activeFilter === "options"}
                onClick={() => setActiveFilter("options")}
                icon={<Grid size={13} />}
                label="Options"
                count={
                  allInstalledPlugins.filter(
                    (p) => p.manifest?.category === "options",
                  ).length
                }
              />
              <SidebarButton
                active={activeFilter === "drawers"}
                onClick={() => setActiveFilter("drawers")}
                icon={<PanelRight size={13} />}
                label="Drawers"
                count={
                  allInstalledPlugins.filter(
                    (p) => p.manifest?.category === "drawers",
                  ).length
                }
              />
              <SidebarButton
                active={activeFilter === "overlays"}
                onClick={() => setActiveFilter("overlays")}
                icon={<Layers size={13} />}
                label="Overlays"
                count={
                  allInstalledPlugins.filter(
                    (p) => p.manifest?.category === "overlays",
                  ).length
                }
              />
              <SidebarButton
                active={activeFilter === "panels"}
                onClick={() => setActiveFilter("panels")}
                icon={<Tv size={13} />}
                label="Panels"
                count={
                  allInstalledPlugins.filter(
                    (p) => p.manifest?.category === "panels",
                  ).length
                }
              />
              <SidebarButton
                active={activeFilter === "backstage"}
                onClick={() => setActiveFilter("backstage")}
                icon={<Cpu size={13} />}
                label="Backstage"
                count={
                  allInstalledPlugins.filter(
                    (p) => p.manifest?.category === "backstage",
                  ).length
                }
              />
            </div>
          </div>

          {/* Section 2: By Source */}
          <div>
            <div className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 mb-2 tracking-wider uppercase">
              Plugin Sources
            </div>
            <div className="space-y-1">
              <SidebarButton
                active={activeFilter === "preinstalled"}
                onClick={() => setActiveFilter("preinstalled")}
                icon={<ShieldCheck size={13} />}
                label="Pre-installed"
                count={
                  allInstalledPlugins.filter(
                    (p) =>
                      p.sourceType === "base" || p.sourceType === "community",
                  ).length
                }
              />
              <SidebarButton
                active={activeFilter === "user"}
                onClick={() => setActiveFilter("user")}
                icon={<User size={13} />}
                label="User Installed"
                count={
                  allInstalledPlugins.filter((p) => p.sourceType === "user")
                    .length
                }
              />
            </div>
          </div>
        </div>

        {/* Bottom Action: Upload Button */}
        {!IS_CLOUD_MODE && (
          <div className="pt-4 border-t border-zinc-200/50 dark:border-zinc-800/50 shrink-0 pb-1">
            <FunctionButton
              onClick={handleDragDropClick}
              disabled={uploading}
              loading={uploading}
              variant="solid"
              shape="circle"
              active={!isDragging && !uploading}
              title="Click to select file or drag ZIP here to install"
              className={`w-full text-xs transition-all duration-200 flex items-center justify-center gap-1.5 select-none
                ${
                  isDragging
                    ? "border-2 border-dashed border-indigo-500 bg-indigo-500/10 dark:bg-indigo-500/15 text-indigo-500 dark:text-indigo-400 animate-pulse shadow-[0_0_15px_rgba(99,102,241,0.2)]"
                    : "border-transparent"
                }
              `}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => {
                setIsDragging(false);
              }}
              onDrop={handleDrop}
            >
              {!uploading && <Upload size={13} />}
              <span>
                {isDragging
                  ? "Drop ZIP here"
                  : uploading
                    ? "Uploading..."
                    : "Upload Plugin"}
              </span>
            </FunctionButton>
          </div>
        )}
      </div>

      {/* Right List View */}
      <div className="flex-1 p-6 overflow-y-auto flex flex-col gap-2 pb-6">
        {filteredPlugins.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/10">
            <Package
              size={24}
              className="text-zinc-300 dark:text-zinc-700 mb-2 animate-pulse"
            />
            <div className="text-xs font-semibold text-zinc-400 dark:text-zinc-500">
              No plugins found in this category
            </div>
          </div>
        ) : (
          filteredPlugins.map((p) => (
            <PluginListRow
              key={`${p.id}-${p._variant}`}
              p={p}
              togglePlugin={togglePlugin}
              onDelete={(plugin: ExtendedPlugin) => {
                // 🛡️ Must be disabled before deleting
                if (plugin.enabled) {
                  setDeleteError(
                    "Please disable this plugin before deleting it.",
                  );
                  return;
                }
                setDeleteTarget(plugin);
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SidebarButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-1.5 text-xs font-medium transition-all duration-200 cursor-pointer rounded-lg border-none outline-none ${
        active
          ? "bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-bold shadow-sm"
          : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 bg-transparent"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`${active ? "text-indigo-600 dark:text-indigo-400" : "text-zinc-400 dark:text-zinc-500"}`}
        >
          {icon}
        </span>
        <span>{label}</span>
      </div>
      <span
        className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border transition-all ${
          active
            ? "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-500/30"
            : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 border-zinc-200/50 dark:border-zinc-700/50"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function PluginListRow({
  p,
  togglePlugin,
  onDelete,
}: {
  p: ExtendedPlugin;
  togglePlugin: (id: string, enabled: boolean) => void;
  onDelete: (plugin: ExtendedPlugin) => void;
}) {
  const isDynamic = p._variant === "dynamic";
  const isEnabled = p.enabled;

  // Source Type details (only for base/community; user plugins show badges inline)
  let sourceBadge = null;
  if (p.sourceType === "base") {
    sourceBadge = (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 shrink-0">
        Built-in Base
      </span>
    );
  } else if (p.sourceType === "community") {
    sourceBadge = (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-indigo-500/10 text-indigo-500 border border-indigo-500/20 shrink-0">
        Community
      </span>
    );
  }

  // Category label details for visual excellence (matches author badge size exactly)
  let categoryBadge = null;
  if (p.manifest?.category) {
    categoryBadge = (
      <span className="text-[9px] text-zinc-400 dark:text-zinc-500 font-medium bg-zinc-50 dark:bg-zinc-800/80 px-1.5 py-0.5 rounded border border-zinc-200/30 dark:border-zinc-700/30 capitalize shrink-0">
        {p.manifest.category}
      </span>
    );
  }

  return (
    <div
      className={`flex items-center justify-between p-3 rounded-xl border transition-all duration-200 ${
        !isEnabled
          ? "border-red-200/60 bg-red-50/20 dark:border-red-950/20 dark:bg-red-950/5 opacity-60 hover:opacity-80"
          : "border-zinc-200 dark:border-zinc-800/80 bg-zinc-50/30 dark:bg-zinc-900/30 hover:bg-zinc-50/60 dark:hover:bg-zinc-900/60 hover:border-indigo-500/20"
      }`}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1 mr-4">
        {/* Plugin Icon Box */}
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border transition-colors ${
            !isEnabled
              ? "bg-red-100/50 dark:bg-red-950/30 text-red-500 border-red-200/50 dark:border-red-900/20"
              : "bg-white dark:bg-zinc-850 text-indigo-500 border-zinc-200 dark:border-zinc-700/50"
          }`}
        >
          {p.icon || <Package size={14} />}
        </div>

        {/* Name & Description */}
        <div className="min-w-0 flex-1">
          {/* Line 1: Name, Version, Author, Category */}
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <span className="font-bold text-xs text-zinc-900 dark:text-zinc-100 truncate max-w-[180px]">
              {p.manifest?.displayName || p.id}
            </span>
            <span className="text-[9px] font-mono bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-600 dark:text-zinc-400 border border-zinc-200/50 dark:border-zinc-700/50 shrink-0">
              v{p.manifest?.version || "1.0.0"}
            </span>
            {p.manifest?.author && (
              <span className="text-[9px] text-zinc-400 dark:text-zinc-500 font-medium bg-zinc-50 dark:bg-zinc-850 px-1.5 py-0.5 rounded border border-zinc-200/30 dark:border-zinc-700/30 shrink-0">
                by {p.manifest.author}
              </span>
            )}
            {categoryBadge}
            {p.isSelfUploaded && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-yellow-500/10 text-yellow-600 dark:text-yellow-500 border border-yellow-500/30 select-none shrink-0"
                title="This plugin bypasses official cloud verification."
              >
                ⚠️ Unverified
              </span>
            )}
            {p.isSelfUploaded && isDynamic && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/20 shrink-0">
                Dynamic
              </span>
            )}
          </div>
          {/* Line 2: Plugin ID */}
          <div className="text-[9px] font-mono text-zinc-400/60 dark:text-zinc-500/60 truncate mb-0.5 select-none">
            ID:{" "}
            <span className="select-all text-zinc-500 dark:text-zinc-400 hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors duration-150 cursor-text font-semibold">
              {p.id}
            </span>
          </div>
          {/* Line 3: Description */}
          <div className="text-[10px] text-zinc-500 dark:text-zinc-400 truncate">
            {p.manifest?.description || "Built-in system plugin"}
          </div>
        </div>
      </div>

      {/* Badges & Actions */}
      <div className="flex items-center gap-3 shrink-0">
        {sourceBadge}

        {p.isSelfUploaded ? (
          <div className="flex items-center gap-1.5">
            {/* Delete button: only for uploaded dynamic plugins that are disabled */}
            {!isEnabled && isDynamic && (
              <FunctionButton
                onClick={() => onDelete(p)}
                className="px-2 py-1.5 h-auto rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all duration-200 cursor-pointer shadow-sm bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/20 dark:hover:text-red-400 border border-zinc-200 dark:border-zinc-700/50 hover:border-red-300 dark:hover:border-red-900/30"
                title="Delete plugin from disk"
              >
                <Trash2 size={11} />
                Delete
              </FunctionButton>
            )}
            <FunctionButton
              onClick={() => togglePlugin(p.id, isEnabled)}
              active={!isEnabled}
              variant={!isEnabled ? "solid" : "glass"}
              className={`px-2.5 py-1.5 h-auto rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all duration-200 cursor-pointer shadow-sm
                ${
                  !isEnabled
                    ? "bg-indigo-600 hover:bg-indigo-500 text-white"
                    : "bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/20 dark:hover:text-red-400 border border-zinc-200 dark:border-zinc-700/50 hover:border-red-200 dark:hover:border-red-900/30"
                }
              `}
            >
              {!isEnabled ? <Power size={11} /> : <PowerOff size={11} />}
              {!isEnabled ? "Enable" : "Disable"}
            </FunctionButton>
          </div>
        ) : (
          <div className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] text-emerald-500 font-bold">
            <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
            Active
          </div>
        )}
      </div>
    </div>
  );
}
