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

import {
  useEditorState,
  useEditorServices,
} from "@opengpex/editor/core/context";
import FancyConfirm from "@opengpex/editor/widgets/FancyConfirm";
import FancyChoice from "@opengpex/editor/widgets/FancyChoice";
import type { ChoiceOption } from "@opengpex/editor/widgets/FancyChoice";
import EditorHUD from "@opengpex/editor/widgets/EditorHUD";
import BranchFlyEffect from "@opengpex/editor/widgets/BranchFlyEffect";
import { AlertCircle, CheckCircle2, Info, Layers, PlusSquare, type LucideIcon } from "lucide-react";
import { EDITOR_Z_INDEX } from "@opengpex/editor/core/helpers/config";
import { useMemo } from "react";

/** Icon lookup: maps string names stored in state to LucideIcon components */
const ICON_MAP: Record<string, LucideIcon> = {
  Layers,
  PlusSquare,
};

export const GlobalUI = () => {
  const { state } = useEditorState();
  const { actions } = useEditorServices();
  const hud = state.interaction.hud;
  const confirm = state.confirm;
  const choice = state.choice;

  /** Map serialized choice options to ChoiceOption[] with real icon components */
  const choiceOptions: ChoiceOption[] = useMemo(() => {
    if (!choice?.options) return [];
    return choice.options.map((opt) => ({
      ...opt,
      icon: opt.icon ? ICON_MAP[opt.icon] : undefined,
    }));
  }, [choice?.options]);

  return (
    <>
      {/* 1. HUD feedback system */}
      <div
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
        style={{ zIndex: EDITOR_Z_INDEX.UI.POPOVER + 50 }}
      >
        <EditorHUD
          isVisible={!!hud}
          icon={
            hud?.type === "success" ? (
              <CheckCircle2 size={16} />
            ) : hud?.type === "error" ? (
              <AlertCircle size={16} />
            ) : (
              <Info size={16} />
            )
          }
          title={hud?.message || ""}
          subtitle={
            hud?.type === "success"
              ? "Operation Success"
              : hud?.type === "error"
                ? "System Error"
                : "Editor Notice"
          }
        />
      </div>

      {/* 2. Confirmation dialog */}
      <FancyConfirm
        isVisible={!!confirm?.isVisible}
        title={confirm?.title || ""}
        message={confirm?.message || ""}
        type={confirm?.type}
        variant={confirm?.variant}
        onConfirm={() => actions.confirm(true)}
        onCancel={() => actions.confirm(false)}
      />

      {/* 3. Multi-choice dialog */}
      <FancyChoice
        isVisible={!!choice?.isVisible}
        title={choice?.title || ""}
        options={choiceOptions}
        onSelect={(id) => actions.resolveChoice(id)}
        onCancel={() => actions.resolveChoice(null)}
      />

      {/* 4. Branch animation */}
      <BranchFlyEffect />

      {/* 4. Portal root node */}
      <div
        id="editor-portal-root"
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: EDITOR_Z_INDEX.UI.POPOVER + 100 }}
      />
    </>
  );
};
