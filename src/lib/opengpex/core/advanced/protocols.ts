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

/**
 * Internal System Command IDs
 * The core engine and built-in services communicate via these IDs.
 * These commands are marked as Protected, preventing third-party plug-ins from intercepting them.
 */

// 1. Viewport & Transform
export const ADV_VIEWPORT_ROTATE = 'adv.viewport.rotate';
export const ADV_VIEWPORT_ROTATE_LEFT = 'adv.viewport.rotate_left';
export const ADV_VIEWPORT_ROTATE_RIGHT = 'adv.viewport.rotate_right';
export const ADV_VIEWPORT_FLIP = 'adv.viewport.flip';
export const ADV_VIEWPORT_FLIP_H = 'adv.viewport.flip_h';
export const ADV_VIEWPORT_FLIP_V = 'adv.viewport.flip_v';
export const ADV_VIEWPORT_FIT = 'adv.viewport.fit';
export const ADV_VIEWPORT_ACTUAL = 'adv.viewport.actual_size';
export const ADV_VIEWPORT_ZOOM = 'adv.viewport.zoom';
export const ADV_VIEWPORT_RESET = 'adv.viewport.reset_transform';


// 2. Frame & Creation Management (Frame/Creation)
export const ADV_FRAME_BRANCH = 'adv.frame.branch';
export const ADV_FRAME_RESIZE_CANVAS = 'adv.frame.resize_canvas';
export const ADV_FRAME_REVERT = 'adv.frame.revert';
export const ADV_FRAME_RESAMPLE = 'adv.frame.resample';
export const ADV_FRAME_REMOVE = 'adv.frame.remove';
export const ADV_FRAME_TRUNK = 'adv.frame.trunk';
export const ADV_FRAME_EXPORT = 'adv.frame.export';
export const ADV_FRAME_IMPORT = 'adv.frame.import';

// 3. Asset Management
export const ADV_ASSET_REGISTER = 'adv.system.asset.register';
export const ADV_ASSET_SYNC = 'adv.system.asset.sync';

// 3. Layer Management
export const ADV_LAYER_TOGGLE_ALL = 'adv.layer.toggle_all';
export const ADV_LAYER_TOGGLE_OTHERS = 'adv.layer.toggle_others';
export const ADV_LAYER_PEEL_EXCHANGE = 'adv.layer.peel.exchange';
export const ADV_LAYER_MERGE_HOST = 'adv.layer.merge.host';
export const ADV_LAYER_MERGE_DOWN = 'cmd.layer_panel.merge.down';
export const ADV_LAYER_MERGE_VISIBLE = 'cmd.layer_panel.merge.visible';
export const ADV_LAYER_MERGE_RASTERIZE = 'cmd.layer_panel.merge.rasterize';

// 4. Clip & Selection Operations
export const ADV_LAYER_CLIP_CUT = 'adv.layer.clip.cut';
export const ADV_LAYER_CLIP_COPY = 'adv.layer.clip.copy';
export const ADV_LAYER_CLIP_PASTE = 'adv.layer.clip.paste';
export const ADV_LAYER_CLIP_DRILL = 'adv.layer.clip.drill';
export const ADV_LAYER_CMDJ_COPY = 'adv.layer.cmdj.copy';
export const ADV_LAYER_CMDJ_CUT = 'adv.layer.cmdj.cut';
export const ADV_LAYER_MASK_TOGGLE = 'adv.layer.mask.toggle';
export const ADV_LAYER_MASK_INVERT = 'adv.layer.mask.invert';
export const ADV_LAYER_MASK_REMOVE = 'adv.layer.mask.remove';
export const ADV_LAYER_MASK_CLEAR = 'adv.layer.mask.clear_all';

// 4b. Bitmap Mask Operations
export const ADV_LAYER_BITMAP_MASK_ADD = 'adv.layer.bitmapMask.add';
export const ADV_LAYER_BITMAP_MASK_UPDATE = 'adv.layer.bitmapMask.update';
export const ADV_LAYER_BITMAP_MASK_REMOVE = 'adv.layer.bitmapMask.remove';
export const ADV_LAYER_BITMAP_MASK_TOGGLE = 'adv.layer.bitmapMask.toggle';
export const ADV_LAYER_BITMAP_MASK_CLEAR = 'adv.layer.bitmapMask.clear_all';

// 5. Runtime & System Probing
export const ADV_SYSTEM_PROBE_ENGINES = 'adv.system.probe_engines';

// 6. Irregular Selection (lasso / wand / AI matting → polygon → bitmap mask)
//
// Note (Pre-PR-6-2): there is intentionally NO `set` / `clear` adv command
// here. Producers (lasso / wand handlers, AI matting pipelines) write the
// frame's `irregularCropBox` directly via `actions.setIrregularCropBox`,
// matching the rect/ellipse pattern of writing `imageCropBox` /
// `canvasCropBox` directly. The only adv command in this group is
// `toLayerMask`, which is an irreducible 3-step transaction (project +
// bake + addBitmapMask + clear) that needs the executeCommand atom.
export const ADV_IRREGULAR_TO_LAYER_MASK = 'adv.irregular.toLayerMask';

// 7. System Signals
// Used to synchronize temporary flags across plug-ins in the global state
export const SIGNAL_SYS_ASSET_CONVERTING = 'sys.asset.converting';
export const SIGNAL_SYS_CANVAS_DIRTY = 'sys.canvas.dirty';
