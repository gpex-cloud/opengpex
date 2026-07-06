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

export const PLUGIN_ID = 'drawers.animation';
export const PLUGIN_AUTHOR = 'opengpex';

/* Command IDs */
export const CMD_EXPORT_ANIMATION = 'cmd.export_animation';
export const CMD_PLAY = 'cmd.play';
export const CMD_PAUSE = 'cmd.pause';
export const CMD_STOP = 'cmd.stop';
export const CMD_GOTO_FRAME = 'cmd.goto_frame';

/* Signal IDs */
export const SIGNAL_IS_PLAYING = 'signal.is_playing';
export const SIGNAL_CURRENT_FRAME = 'signal.current_frame';

/* Cross-plugin reference UIDs (exported for external consumers) */
export const ANIMATION_CMD_EXPORT = `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_EXPORT_ANIMATION}`;

/* Animation format types */
export type AnimationFormat = 'gif' | 'apng';

/* Plugin self-config interface */
export interface AnimationConfig {
    format: AnimationFormat;
    loop: boolean;              // true = loop playback, false = play once and stop
    frameRateOverride: number;  // 0 = use original per-frame delay
}
