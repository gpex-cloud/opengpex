/**
 * ColorGradingDrawer/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue } from '@opengpex/editor/core/types';
import type { GradingTool, CurveChannel, LevelsPatch, ChannelMixPatch, ChannelMixPresetId, AdjustmentsPatch } from './protocols';

/** Type map for usePluginCommands<ColorGradingDrawerCommandsMap>() */
export interface ColorGradingDrawerCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  setGradingToolCmd: CommandInstance<{ tool: GradingTool }>;
  resetAllGradingCmd: CommandInstance;
  resetActivePanelCmd: CommandInstance;
  beginCurvesEditCmd: CommandInstance;
  updateChannelCurveCmd: CommandInstance<{ channel: CurveChannel; points: CurvePoints }>;
  addCurvePointCmd: CommandInstance<{ channel: CurveChannel; x: number; y: number }>;
  removeCurvePointCmd: CommandInstance<{ channel: CurveChannel; index: number }>;
  beginLevelsEditCmd: CommandInstance;
  updateLevelsCmd: CommandInstance<{ patch: LevelsPatch }>;
  autoLevelsCmd: CommandInstance<{ inputBlack: number; inputWhite: number }>;
  beginChannelMixEditCmd: CommandInstance;
  updateChannelMixCmd: CommandInstance<{ patch: ChannelMixPatch }>;
  applyChannelMixPresetCmd: CommandInstance<{ presetId: ChannelMixPresetId }>;
  beginAdjustmentsEditCmd: CommandInstance;
  updateAdjustmentsCmd: CommandInstance<{ patch: AdjustmentsPatch }>;
}

/** Type map for usePluginSignals<ColorGradingDrawerSignalsMap>() */
export interface ColorGradingDrawerSignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  activeGradingToolSignal: {
    value: unknown;
    set: (val: unknown) => void;
  };
}
