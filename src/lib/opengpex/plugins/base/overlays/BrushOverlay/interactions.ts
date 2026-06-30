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

import { InteractionHandler, InteractionEvent, Layer, Frame, asLocalRect, asLocalShape, IMatrix3x3 } from '@opengpex/editor/core/types';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { CraftDrawerAPI } from '../../drawers/CraftDrawer/protocols';
import { ColorOptionsAPI } from '../../options/ColorOptions/protocols';
import { BRUSH_OVERLAY_SIGNAL_IS_STROKING, DEFAULT_BRUSH_SIZE, _CMD_BAKE_UID } from './protocols';
import { StrokeSmoother, drawSmoothSegment, Point2D } from './smoothing';
import { stampBrush, stampAlongPath } from './hardness';
import { imageCache } from '@opengpex/editor/core/engine/cache/ImageCache';
import { PixelUtils } from '@opengpex/editor/core/engine/PixelUtils';

/** Shared signal key */
const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;
const IS_STROKING_KEY = BRUSH_OVERLAY_SIGNAL_IS_STROKING;

/** Command UID (from protocols, Single Source of Truth) */
const CMD_BAKE_UID = _CMD_BAKE_UID;

/**
 * Stroke sample point
 */
interface StrokePoint {
  x: number; // Canvas-local coordinate
  y: number;
  pressure: number; // 0~1 (from PointerEvent.pressure)
  timestamp: number;
}

/**
 * StrokeBuffer: Stroke buffer (OffscreenCanvas)
 *
 * Saves all drawing results of the current stroke.
 * Bakes to target layer onEnd (implemented in Step 4).
 */
interface StrokeBufferState {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  points: StrokePoint[];
  lastPoint: StrokePoint | null;
  brushSize: number;
  brushColor: string;
  brushOpacity: number;
  brushHardness: number;
  isEraser: boolean;
  isRestore: boolean;

  // Stamp spacing control
  lastStampX: number;
  lastStampY: number;
  accDistance: number;
  stampSpacing: number;

  // For non-destructive mask editing
  isMaskEdit: boolean;
  targetLayerId?: string;
  maskId?: string;
  maskCanvas?: OffscreenCanvas;
  maskCtx?: OffscreenCanvasRenderingContext2D;
  localMatrixInverse?: IMatrix3x3;
  localBrushSize?: number;
}

let strokeBuffer: StrokeBufferState | null = null;
let strokeVersion = 0; // Incremented on each onMove draw, for StrokePreview dirty state detection
let smoother: StrokeSmoother | null = null; // Catmull-Rom smoother instance
let lastDrawnPoint: Point2D | null = null; // Last drawn endpoint (used to connect starting point of new smooth segment)
let forceNewLayerFlag = false; // Force creation of new Paint Layer when Cmd/Ctrl is pressed

// ─── createBrushStrokeHandler ──────────────────────────────────────────────────

/**
 * BrushStrokeHandler: Brush stroke interaction handler
 *
 * In brush/eraser/restore craft mode, handles pointerdown -> pointermove -> pointerup
 * complete stroke lifecycle.
 */
export const createBrushStrokeHandler = (): InteractionHandler => {
  return {
    id: 'brush-stroke',
    priority: 150, // Same level as TextPlaceHandler, mutual exclusion guaranteed by activeCraft signal

    test: (e) => {
      // Only active in craft mode when activeCraft === 'brush' or 'eraser' or 'restore'
      if (e.state.interaction.interactionMode !== 'craft') return false;
      const craft = e.state.interaction.signals[ACTIVE_CRAFT_KEY];
      if (craft !== 'brush' && craft !== 'eraser' && craft !== 'restore') return false;

      // Exclude right click
      const mouseEvent = e.nativeEvent as MouseEvent;
      if (mouseEvent.button === 2) return false;

      // Exclude UI element click
      const target = mouseEvent.target as HTMLElement;
      if (target.closest('button, a, input, [data-role="ui"], [contenteditable]')) return false;

      // Click within canvas range
      const frame = e.activeFrame;
      return e.geometry.space.isPointInRect(e.point.canvas, {
        x: 0, y: 0, w: frame.canvas.w, h: frame.canvas.h,
      });
    },

    onStart: (e) => {
      const frame = e.activeFrame;
      const craft = e.state.interaction.signals[ACTIVE_CRAFT_KEY] as string;

      const pointerEvent = e.nativeEvent as PointerEvent;
      const isCmdPressed = pointerEvent.metaKey || pointerEvent.ctrlKey;

      const isEraser = craft === 'eraser' && !isCmdPressed;
      const isRestore = craft === 'restore' || (craft === 'eraser' && isCmdPressed);
      const isMaskEdit = craft === 'eraser' || craft === 'restore';

      // Detect Cmd/Ctrl modifier: force creation of new Paint Layer (only meaningful for brush mode)
      forceNewLayerFlag = craft === 'brush' && isCmdPressed;

      // Read brush parameters (from pluginConfig)
      const craftConfig = e.state.pluginConfig[CraftDrawerAPI.configKey] || {};
      const brushSize = (craftConfig.brushSize as number) ?? DEFAULT_BRUSH_SIZE;
      const brushOpacity = (craftConfig.brushOpacity as number) ?? 100;
      const colorConfig = e.state.pluginConfig[ColorOptionsAPI.configKey] || {};
      const brushColor = (colorConfig.pendingColor as string) || '#FFFFFF';
      const brushHardness = (craftConfig.brushHardness as number) ?? 80;

      const canvasW = frame.canvas.w;
      const canvasH = frame.canvas.h;

      if (!isMaskEdit) {
        // ─── Normal Brush Logic ───
        try {
          const offscreen = new OffscreenCanvas(canvasW, canvasH);
          const ctx = offscreen.getContext('2d');
          if (!ctx) {
            console.warn('[BrushOverlay] Failed to get OffscreenCanvas 2D context');
            return;
          }

          // Set brush style
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.lineWidth = brushSize;
          ctx.globalAlpha = brushOpacity / 100;
          ctx.strokeStyle = brushColor;
          ctx.fillStyle = brushColor;

          // Record start point
          const startPoint: StrokePoint = {
            x: e.point.canvas.x,
            y: e.point.canvas.y,
            pressure: (e.nativeEvent as PointerEvent).pressure || 0.5,
            timestamp: Date.now(),
          };

          // Stamp spacing: smaller spacing is smoother, but increases performance cost
          const stampSpacing = Math.max(brushSize * 0.15, 1);

          // Initialize strokeBuffer
          strokeBuffer = {
            canvas: offscreen,
            ctx,
            points: [startPoint],
            lastPoint: startPoint,
            brushSize,
            brushColor,
            brushOpacity,
            brushHardness,
            isEraser: false,
            isRestore: false,
            isMaskEdit: false,
            lastStampX: startPoint.x,
            lastStampY: startPoint.y,
            accDistance: 0,
            stampSpacing,
          };

          // Stamp a circle at the start point
          stampBrush(ctx, startPoint.x, startPoint.y, brushSize, brushHardness, brushColor, brushOpacity / 100);

          // Initialize Catmull-Rom smoother
          smoother = new StrokeSmoother();
          smoother.begin(startPoint);
          lastDrawnPoint = startPoint;

          e.actions.setStateSignal(IS_STROKING_KEY, true);

        } catch (err) {
          console.warn('[BrushOverlay] OffscreenCanvas creation failed:', err);
        }
      } else {
        // ─── Non-destructive Mask Editing Logic ───
        const targetLayerInfo = findEraserTarget(frame);
        if (!targetLayerInfo) {
          console.warn('[BrushOverlay] No valid target layer for mask editing');
          return;
        }
        const targetLayer = targetLayerInfo.layer;

        const activeMask = targetLayer.bitmapMasks?.[0];
        const maskId = activeMask?.id || `mask-${Date.now()}`;
        const localMatrix = e.geometry.transform.getLayerLocalMatrix(targetLayer, frame);
        const localMatrixInverse = localMatrix.inverse();

        const scaleX = Math.sqrt(localMatrix.a * localMatrix.a + localMatrix.b * localMatrix.b) || 1;
        const localBrushSize = brushSize / scaleX;

        const maskW = targetLayer.bounding.w;
        const maskH = targetLayer.bounding.h;

        try {
          const maskCanvas = new OffscreenCanvas(maskW, maskH);
          const maskCtx = maskCanvas.getContext('2d');
          if (!maskCtx) {
            console.warn('[BrushOverlay] Failed to get OffscreenCanvas 2D context for mask');
            return;
          }

          // Initialize mask canvas
          if (!activeMask) {
            maskCtx.fillStyle = '#FFFFFF';
            maskCtx.fillRect(0, 0, maskW, maskH);
          } else if (activeMask.src) {
            const img = imageCache.getOrFetch(activeMask.src);
            if (img) {
              maskCtx.drawImage(img, 0, 0, maskW, maskH);
            } else {
              loadImageBitmap(activeMask.src).then(bitmap => {
                if (strokeBuffer && strokeBuffer.maskId === maskId && strokeBuffer.maskCtx) {
                  strokeBuffer.maskCtx.save();
                  strokeBuffer.maskCtx.globalCompositeOperation = 'destination-over';
                  strokeBuffer.maskCtx.drawImage(bitmap, 0, 0, maskW, maskH);
                  strokeBuffer.maskCtx.restore();
                  bitmap.close();
                  // Retrigger preview
                  e.actions.fast.override(frame.id, targetLayer.id, {
                    bitmapMaskOverride: { maskId, source: maskCanvas }
                  }, 'layer');
                }
              }).catch(err => {
                console.warn('[BrushOverlay] Async mask load failed:', err);
              });
            }
          }

          const startPoint: StrokePoint = {
            x: e.point.canvas.x,
            y: e.point.canvas.y,
            pressure: (e.nativeEvent as PointerEvent).pressure || 0.5,
            timestamp: Date.now(),
          };

          const localStartPoint = localMatrixInverse.apply(startPoint);

          // Record initial strokeBuffer (create placeholder canvas to satisfy non-empty getStrokeBuffer interface return)
          const placeholderCanvas = new OffscreenCanvas(1, 1);
          const placeholderCtx = placeholderCanvas.getContext('2d')!;

          const stampSpacing = Math.max(localBrushSize * 0.15, 1);

          strokeBuffer = {
            canvas: placeholderCanvas,
            ctx: placeholderCtx,
            points: [startPoint],
            lastPoint: startPoint,
            brushSize,
            brushColor,
            brushOpacity,
            brushHardness,
            isEraser,
            isRestore,
            isMaskEdit: true,
            lastStampX: localStartPoint.x,
            lastStampY: localStartPoint.y,
            accDistance: 0,
            stampSpacing,
            targetLayerId: targetLayer.id,
            maskId,
            maskCanvas,
            maskCtx,
            localMatrixInverse,
            localBrushSize,
          };

          // Draw initial circle dot
          maskCtx.save();
          maskCtx.lineCap = 'round';
          maskCtx.lineJoin = 'round';
          maskCtx.lineWidth = localBrushSize;
          maskCtx.globalAlpha = brushOpacity / 100;
          if (isEraser) {
            maskCtx.globalCompositeOperation = 'destination-out';
            maskCtx.fillStyle = '#FFFFFF';
            maskCtx.strokeStyle = '#FFFFFF';
          } else {
            maskCtx.globalCompositeOperation = 'source-over';
            maskCtx.fillStyle = '#FFFFFF';
            maskCtx.strokeStyle = '#FFFFFF';
          }
          maskCtx.beginPath();
          maskCtx.arc(localStartPoint.x, localStartPoint.y, localBrushSize / 2, 0, Math.PI * 2);
          maskCtx.fill();
          maskCtx.restore();

          smoother = new StrokeSmoother();
          smoother.begin(startPoint);
          lastDrawnPoint = startPoint;

          e.actions.setStateSignal(IS_STROKING_KEY, true);

          // Trigger real-time fast-track override
          e.actions.fast.override(frame.id, targetLayer.id, {
            bitmapMaskOverride: { maskId, source: maskCanvas }
          }, 'layer');

        } catch (err) {
          console.warn('[BrushOverlay] OffscreenCanvas creation for mask failed:', err);
        }
      }
    },

    onMove: (e) => {
      if (!strokeBuffer || !smoother) return;
      const { points, lastPoint, isMaskEdit } = strokeBuffer;
      if (!lastPoint) return;

      const newPoint: StrokePoint = {
        x: e.point.canvas.x,
        y: e.point.canvas.y,
        pressure: (e.nativeEvent as PointerEvent).pressure || 0.5,
        timestamp: Date.now(),
      };

      const dx = newPoint.x - lastPoint.x;
      const dy = newPoint.y - lastPoint.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 2) return;

      points.push(newPoint);

      const smoothPoints = smoother.addPoint(newPoint);

      if (!isMaskEdit) {
        const { ctx } = strokeBuffer;
        if (smoothPoints.length > 0 && lastDrawnPoint) {
          // Draw along smooth path using stamp engine (supports Hardness)
          stampAlongPath(ctx, smoothPoints, strokeBuffer);
          lastDrawnPoint = smoothPoints[smoothPoints.length - 1];
        } else if (points.length === 2 && lastDrawnPoint) {
          // First two points do not have smooth data yet, stamp with line
          stampAlongPath(ctx, [newPoint], strokeBuffer);
        }
      } else {
        const { maskCtx, localMatrixInverse, localBrushSize, brushOpacity, maskCanvas, maskId, targetLayerId } = strokeBuffer;
        if (maskCtx && localMatrixInverse && localBrushSize && maskCanvas && maskId && targetLayerId) {
          const localLastPoint = localMatrixInverse.apply(lastDrawnPoint!);
          const localSmoothPoints = smoothPoints.map(p => localMatrixInverse.apply(p));

          const craft = e.state.interaction.signals[ACTIVE_CRAFT_KEY] as string;
          const pointerEvent = e.nativeEvent as PointerEvent;
          const isCmdPressed = pointerEvent.metaKey || pointerEvent.ctrlKey;
          const currentIsRestore = craft === 'restore' || (craft === 'eraser' && isCmdPressed);

          maskCtx.save();
          maskCtx.lineCap = 'round';
          maskCtx.lineJoin = 'round';
          maskCtx.lineWidth = localBrushSize;
          maskCtx.globalAlpha = brushOpacity / 100;
          if (!currentIsRestore) {
            maskCtx.globalCompositeOperation = 'destination-out';
            maskCtx.strokeStyle = '#FFFFFF';
            maskCtx.fillStyle = '#FFFFFF';
          } else {
            maskCtx.globalCompositeOperation = 'source-over';
            maskCtx.strokeStyle = '#FFFFFF';
            maskCtx.fillStyle = '#FFFFFF';
          }

          if (localSmoothPoints.length > 0 && localLastPoint) {
            drawSmoothSegment(maskCtx, localLastPoint, localSmoothPoints);
            lastDrawnPoint = smoothPoints[smoothPoints.length - 1];
          } else if (points.length === 2 && localLastPoint) {
            const localNewPoint = localMatrixInverse.apply(newPoint);
            maskCtx.beginPath();
            maskCtx.moveTo(localLastPoint.x, localLastPoint.y);
            maskCtx.lineTo(localNewPoint.x, localNewPoint.y);
            maskCtx.stroke();
          }
          maskCtx.restore();

          // Trigger real-time fast-track override
          e.actions.fast.override(e.activeFrame.id, targetLayerId, {
            bitmapMaskOverride: { maskId, source: maskCanvas }
          }, 'layer');
        }
      }

      strokeBuffer.lastPoint = newPoint;
      strokeVersion++;
    },

    onEnd: (e) => {
      if (!strokeBuffer) return;

      const frame = e.activeFrame;
      const currentStroke = strokeBuffer;
      const isMaskEdit = currentStroke.isMaskEdit;

      // Complete the trailing segment lagged by smoother
      if (smoother && lastDrawnPoint) {
        const finalSegment = smoother.finish();
        if (finalSegment.length > 0) {
          if (!isMaskEdit && currentStroke.ctx) {
            stampAlongPath(currentStroke.ctx, finalSegment, currentStroke);
          } else if (isMaskEdit && currentStroke.maskCtx && currentStroke.localMatrixInverse && currentStroke.localBrushSize) {
            const localLastPoint = currentStroke.localMatrixInverse.apply(lastDrawnPoint);
            const localFinalSegment = finalSegment.map(p => currentStroke.localMatrixInverse!.apply(p));

            const { maskCtx, localBrushSize, brushOpacity } = currentStroke;
            const craft = e.state.interaction.signals[ACTIVE_CRAFT_KEY] as string;
            const pointerEvent = e.nativeEvent as PointerEvent;
            const isCmdPressed = pointerEvent.metaKey || pointerEvent.ctrlKey;
            const currentIsRestore = craft === 'restore' || (craft === 'eraser' && isCmdPressed);

            maskCtx.save();
            maskCtx.lineCap = 'round';
            maskCtx.lineJoin = 'round';
            maskCtx.lineWidth = localBrushSize;
            maskCtx.globalAlpha = brushOpacity / 100;
            if (!currentIsRestore) {
              maskCtx.globalCompositeOperation = 'destination-out';
              maskCtx.strokeStyle = '#FFFFFF';
              maskCtx.fillStyle = '#FFFFFF';
            } else {
              maskCtx.globalCompositeOperation = 'source-over';
              maskCtx.strokeStyle = '#FFFFFF';
              maskCtx.fillStyle = '#FFFFFF';
            }
            drawSmoothSegment(maskCtx, localLastPoint, localFinalSegment);
            maskCtx.restore();
          }
          strokeVersion++;
        }
      }

      smoother = null;
      lastDrawnPoint = null;

      e.actions.setStateSignal(IS_STROKING_KEY, false);

      if (!isMaskEdit) {
        // --- Normal Paint Brush BAKE Process ---
        return (async () => {
          // let targetLayerIdToCommit: string | null = null;
          try {
            const targetLayerInfo = findOrCreatePaintLayer(e, frame);
            if (!targetLayerInfo) return;
            const targetLayer = targetLayerInfo.layer;
            // targetLayerIdToCommit = targetLayer.id;

            const compositeCanvas = new OffscreenCanvas(frame.canvas.w, frame.canvas.h);
            const compositeCtx = compositeCanvas.getContext('2d');
            if (!compositeCtx) throw new Error('Failed to get composite canvas context');

            if (targetLayer.src && !targetLayerInfo.isNew) {
              try {
                const existingBitmap = await loadImageBitmap(targetLayer.src);
                // If existing layer was cropped (bounding < canvas), draw at correct offset
                const drawX = frame.canvas.w / 2 + targetLayer.cx - targetLayer.bounding.w / 2;
                const drawY = frame.canvas.h / 2 + targetLayer.cy - targetLayer.bounding.h / 2;
                compositeCtx.drawImage(existingBitmap, drawX, drawY);
                existingBitmap.close();
              } catch (loadErr) {
                console.warn('[BrushOverlay] Failed to load existing layer bitmap:', loadErr);
              }
            }

            compositeCtx.globalCompositeOperation = 'source-over';
            compositeCtx.drawImage(currentStroke.canvas, 0, 0);

            // Compute minimal content bounding box via PixelUtils (crop transparent edges)
            const compositeBitmap = await createImageBitmap(compositeCanvas);
            const contentBounds = await PixelUtils.calculateContentBounds(compositeBitmap);
            compositeBitmap.close();

            let finalCanvas: OffscreenCanvas;
            // Add 1px padding to avoid sub-pixel edge clipping artifacts
            const cropX = Math.max(0, contentBounds.x - 1);
            const cropY = Math.max(0, contentBounds.y - 1);
            const cropR = Math.min(frame.canvas.w, contentBounds.x + contentBounds.w + 1);
            const cropB = Math.min(frame.canvas.h, contentBounds.y + contentBounds.h + 1);
            const cropW = cropR - cropX;
            const cropH = cropB - cropY;

            // Only crop if content is smaller than the full canvas
            if (cropW < frame.canvas.w || cropH < frame.canvas.h) {
              finalCanvas = new OffscreenCanvas(cropW, cropH);
              const finalCtx = finalCanvas.getContext('2d')!;
              finalCtx.drawImage(compositeCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
            } else {
              finalCanvas = compositeCanvas;
            }

            const blob = await finalCanvas.convertToBlob({ type: 'image/png' });
            const asset = await e.actions.adv.system.assets.register.execute(blob);

            await new Promise<void>((resolve) => {
              const img = new Image();
              img.crossOrigin = 'anonymous';
              img.onload = () => {
                imageCache.set(asset.url, img);
                resolve();
              };
              img.onerror = () => resolve();
              img.src = asset.url;
            });

            // Calculate cx/cy: convert from canvas-local crop rect center to world center offset
            // Canvas-local center of the crop region:
            const cropCenterLocalX = cropX + cropW / 2;
            const cropCenterLocalY = cropY + cropH / 2;
            // World cx/cy = offset from canvas center (canvas center = local w/2, h/2)
            const newCx = cropCenterLocalX - frame.canvas.w / 2;
            const newCy = cropCenterLocalY - frame.canvas.h / 2;

            const completeLayer: Layer = {
              ...targetLayer,
              assetId: asset.id,
              src: asset.url,
              bounding: { w: cropW, h: cropH },
              visibleShape: asLocalShape({ x: 0, y: 0, w: cropW, h: cropH }),
              cx: newCx,
              cy: newCy,
            };

            e.actions.executeCommand(CMD_BAKE_UID, {
              frameId: frame.id,
              layer: completeLayer,
              isNew: targetLayerInfo.isNew,
            });

          } catch (err) {
            console.error('[BrushOverlay] Bake failed:', err);
          } finally {
            strokeBuffer = null;
          }
        })();
      } else {
        // --- Mask Edit BAKE Process ---
        return (async () => {
          let targetLayerIdToCommit: string | null = null;
          try {
            const targetLayerInfo = findEraserTarget(frame);
            if (!targetLayerInfo) {
              console.warn('[BrushOverlay] No valid target layer for mask bake');
              return;
            }
            const targetLayer = targetLayerInfo.layer;
            targetLayerIdToCommit = targetLayer.id;

            const { maskCanvas, maskId } = currentStroke;
            if (!maskCanvas || !maskId) return;

            const blob = await maskCanvas.convertToBlob({ type: 'image/png' });
            const asset = await e.actions.adv.system.assets.register.execute(blob);

            await new Promise<void>((resolve) => {
              const img = new Image();
              img.crossOrigin = 'anonymous';
              img.onload = () => {
                imageCache.set(asset.url, img);
                resolve();
              };
              img.onerror = () => resolve();
              img.src = asset.url;
            });

            const existingMask = targetLayer.bitmapMasks?.[0];
            if (existingMask) {
              await e.actions.adv.layer.bitmapMask.update.execute({
                frameId: frame.id,
                layerId: targetLayer.id,
                maskId: existingMask.id,
                patch: {
                  src: asset.url,
                  assetId: asset.id
                }
              });
            } else {
              await e.actions.adv.layer.bitmapMask.add.execute({
                frameId: frame.id,
                layerId: targetLayer.id,
                src: asset.url,
                assetId: asset.id,
                bounds: asLocalRect({ x: 0, y: 0, w: targetLayer.bounding.w, h: targetLayer.bounding.h })
              });
            }
          } catch (err) {
            console.error('[BrushOverlay] Mask bake failed:', err);
          } finally {
            strokeBuffer = null;
            if (targetLayerIdToCommit) {
              e.actions.fast.commit(targetLayerIdToCommit, 'layer');
            }
          }
        })();
      }
    },
  };
};

/**
 * getStrokeBuffer: Gets currently active Stroke Buffer (for StrokePreview component reading)
 *
 * This function is exposed to components.tsx for real-time stroke preview on STAGE_OVERLAY.
 * When strokeBuffer is null, it indicates no active stroke.
 */
export function getStrokeBuffer(): OffscreenCanvas | null {
  return strokeBuffer?.canvas ?? null;
}

/**
 * getStrokeVersion: Gets current stroke version
 *
 * Increments on each onMove draw. StrokePreview's Ticker compares version numbers
 * to determine if preview canvas needs redraw (avoids redundant drawImage when no change).
 */
export function getStrokeVersion(): number {
  return strokeVersion;
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * findOrCreatePaintLayer: Determines target Paint Layer for writing the stroke
 *
 * Strategy (refer to document §3.3):
 * 1. Current active layer is paint type and unlocked -> reuse directly (unless forceNewLayerFlag=true)
 * 2. Current active layer is other type -> create new Paint Layer above it
 * 3. No layer on canvas -> create Paint Layer automatically
 *
 * forceNewLayerFlag: true when user holds Cmd/Ctrl, forcing creation of new Paint Layer
 * (skips reuse logic even if current active layer is reusable paint layer)
 */
function findOrCreatePaintLayer(
  e: InteractionEvent,
  frame: Frame,
): { layer: Layer; isNew: boolean } {
  const activeLayerId = frame.activeLayerId;
  const activeLayer = activeLayerId ? frame.layers.byId[activeLayerId] : null;

  // Case 1: Current active layer is a paintable paint layer (Paint Layer candidate)
  // Skip reuse and force create new layer when forceNewLayerFlag=true
  if (!forceNewLayerFlag && activeLayer && isPaintLayerCandidate(activeLayer)) {
    return { layer: activeLayer, isNew: false };
  }

  // Case 2 & 3: Need to create new Paint Layer (or force create new due to forceNewLayerFlag)
  const layersArray = frame.layers.order.map(id => frame.layers.byId[id]);
  const smartName = LayerFactory.getNewLayerName(layersArray, 'Paint');
  const newLayer = LayerFactory.getNewLayer({
    name: smartName,
    type: 'paint',  // dedicated paint layer type (different from user's image layer)
    cx: 0,
    cy: 0,
    bounding: { w: frame.canvas.w, h: frame.canvas.h },
    visible: true,
  });

  return { layer: newLayer, isNew: true };
}

/**
 * isPaintLayerCandidate: Determines if layer can be a target Paint Layer
 *
 * Conditions:
 * - type === 'paint' (dedicated paint layer type)
 * - unlocked and visible
 *
 * Note: Normal user image layer will not be treated as Paint Layer,
 * paint brush will create a new Paint Layer above it to avoid destroying original image.
 */
function isPaintLayerCandidate(layer: Layer): boolean {
  return (
    layer.type === 'paint' &&
    !layer.locked &&
    layer.visible &&
    !layer.bitmapMasks?.some(m => m.enabled) // Layer with active mask cannot be reused (eraser automatically creates new layer after erasing)
  );
}

/**
 * findEraserTarget: Determines target layer for eraser writing
 *
 * Eraser can erase any layer with content (image or paint type).
 * Strategy:
 * 1. Current active layer has bitmap content (non-empty src) -> erase directly
 * 2. No valid target -> return null (cannot erase)
 */
function findEraserTarget(frame: Frame): { layer: Layer; isNew: boolean } | null {
  const activeLayerId = frame.activeLayerId;
  const activeLayer = activeLayerId ? frame.layers.byId[activeLayerId] : null;

  // Eraser can only operate on layers with content
  if (
    activeLayer &&
    (activeLayer.type === 'image' || activeLayer.type === 'paint') &&
    activeLayer.src &&
    !activeLayer.locked &&
    activeLayer.visible
  ) {
    return { layer: activeLayer, isNew: false };
  }

  return null;
}

/**
 * loadImageBitmap: Loads image as ImageBitmap via URL
 *
 * Used to load existing bitmap of target layer during Bake.
 * Supports ObjectURL and normal URL.
 */
async function loadImageBitmap(src: string): Promise<ImageBitmap> {
  const response = await fetch(src);
  const blob = await response.blob();
  return createImageBitmap(blob);
}


