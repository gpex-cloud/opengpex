# Changelog

All notable changes to OpenGPEX are documented in this file.

---

## v1.0.0-beta.26

- Refactor BgRemovalDrawer into a new AIToolsDrawer providing AI-powered segmentation tools under a unified panel
- Update AIBridgeDrawer components and settings panel integration for the new AIToolsDrawer architecture
- Update SourceBitmapCache references and StorageInfoPanel import paths to reflect the drawer rename

---

## v1.0.0-beta.25

- Fix peel interaction losing layer adjustment effects on fragments and double-applying on merge
- Add edge snapping for resize handles — dragged edges snap to canvas/layer boundaries, with scope toggle in SmartGuides settings
- Show real-time move-delta label (Δ x, y) when dragging clip selections
- Refactor clip selection move to support smart guide alignment and pixel-accurate snapping
- Fix peel stamp (CMD+Alt drag) losing host pixels on repeated stamp operations
- Fix clear selection discarding peeled pixels instead of merging them back
- Refactor ClipOverlay interactions into modular tool subdirectories (regular, lasso, wand)
- Fix OptionBar z-index occlusion by DrawerBar

---

## v1.0.0-beta.24

- Unified source-bitmap cache across the editor, halving peak memory usage during heavy edits
- Bounded filter cache memory to prevent excessive retention on multi-layer 4K workflows
- Extracted shared `NumberField` component for consistent numeric input across panels
- Per-tile filter caching for large images (8K/16K) to eliminate flashing during adjustments
- Fixed Curves/Levels/Mixer having no visible effect during slider interaction (Fast-Track preview)
- Fixed preview artifacts: blank frame on mouse release, incorrect bounds on downsampled layers
- Renamed Color Grading drawer to Adjustment drawer (Photoshop-standard terminology)
- Added reusable `FancySlider` widget with custom house-shaped thumb shared across panels

---

## v1.0.0-beta.23

- Introduce the new **Color Grading** drawer that unifies Basic (Brightness / Contrast / Saturation / Hue / Blur), Curves, Levels, and Channel Mixer under a single entry, replacing the standalone Adjustment drawer and shrinking the sidebar from 7 to 6 icons
- Deliver real-time preview for Curves, Levels, and Channel Mixer — the canvas now updates smoothly as you drag any slider, without flashing back to the original image between ticks
- Support multi-page TIFF import with options to load pages as separate layers, independent animation frames, or first page only
- Add JPEG-in-TIFF compression on export with an interactive quality slider and advanced settings (Predictor, Byte Order, BigTIFF, custom tile sizes)
- Enable 16-bit multi-layer composite export end-to-end, with automatic 8-bit fallback when unsupported
- Prevent tiling seam artifacts for layers using non-default blend modes by isolating them into an offscreen composition pass

---

## v1.0.0-beta.22

- Implement Layer Blend Modes (Multiply, Screen, Overlay, etc.) and Opacity/Fill settings, including integrated UI controls in Layers Drawer and rendering pipeline updates
- Fix AnimationDrawer loop playback reset race condition by implementing render-phase sequence transitions and auto-pausing on active modal confirm/choice dialogs
- Implement 16-bit High Fidelity Exporter using WASM Libvips, supporting high-depth TIFF/PNG export from original source bytes, compression options, and export controls

---

## v1.0.0-beta.21

- Introduce unified `FileService` module to handle image decoding, encoding, and metadata management, replacing legacy format-specific helpers
- Add native TIFF format support (import/export) via `wasm-vips` client-side Web Worker, including None, LZW, and ZIP compression options
- Add native multi-frame GIF decoding and encoding support via `gifuct-js` and `gifenc` libraries
- Implement an Animation Drawer plugin (`drawers.animation`) providing animation playback controls, looping, frame rate overrides, and export capabilities (GIF/APNG)
- Add dedicated GIF Revert Path in the `Revert to Original` command to re-decode the original GIF from the asset store and rebuild all layers in-place
- Add a master expand/collapse toggle for all host layers in the Layers Drawer panel

---

## v1.0.0-beta.20

- Refactor global history into independent, per-frame undo/redo stacks (`state.history.byFrameId`) to isolate history state and prevent viewport jumps
- Implement continuous stamp copying with 0ms temporary layer (`role: 'frag'`) optimistic updates and offscreen Web Worker compositing
- Add Web Worker-driven selection operations (inversion, alpha-channel extraction, and polygon offset) with dedicated Option Bar controls
- Implement dual-path marching ants (black base path + animated white/red foreground path) to guarantee selection visibility against any background

---

## v1.0.0-beta.19

- Add DPI / resolution system: per-frame DPI, EXIF extraction on import, DPI preset dropdown with print-size display and resample toggle in Image Info panel
- Add EPS format import via Ghostscript WASM rasterization with user-selectable DPI dialog
- Enhance SVG import with user-selectable rasterization DPI and pixel-dimension preview

---

## v1.0.0-beta.18

- Lock background layer and branch base layer by default during frame/layer creation (Photoshop parity)
- Redesign Clip Mode navigation: Space key toggles clip mode (enter/exit), while Tab and Shift+Tab handle forward/backward tool cycling
- Eliminate opacity transitions on the Brush overlay badge to prevent a transient "+" symbol flash during mode switches
- Improve responsiveness of `FancyConfirm` dialogs by increasing max-width and enabling multi-line wrapping with auto word breaking to prevent truncation issues

---

## v1.0.0-beta.17

- Implement bitmap mask editing mode with integrated eraser/restore sub-modes (Tab key toggle) and active tool linkage in `LayerDrawer` and `CraftDrawer`
- Add visual mask focus isolation overlay showing masked (hidden) areas with a semi-transparent green tint
- Support OffscreenCanvas compositing and asset registration for irregular mask cutouts/drilled selection deletion
- Support rasterizing irregular selections (lasso, wand, AI) to alpha-channel mask PNG assets with optional edge feathering
- Fix subpixel anti-aliasing seam gaps in `cutToLayer` by calculating dynamic logical shrink based on rendering scale
- Enhance `ActionDropdown` with option dividers, improved viewport positioning relative to window scroll, and updated click event triggers

---

## v1.0.0-beta.16

- Add config-driven filtering for `SmartGuides` snapping targets and exclude layer types in a new settings panel
- Implement `useVolatileInteraction` hook for high-frequency interaction subscriptions to prevent unnecessary global React renders
- Optimize `DrawerBar` layout transitions: support double-click to isolate panels, smooth drag-and-drop animations, and styled side-dock/collapse buttons
- Refactor `AiGenerationPanel` in `ImageInfoDrawer` using CSS theme variables and a cleaner two-column details layout
- Improve authentication dialog mounting by portal-rendering the `LoginModal` to the document body to resolve z-index bugs

---

## v1.0.0-beta.15

- Add dynamic `FontService` supporting IndexedDB local caching, Google Fonts discovery, and local font access
- Add `FontPicker` widget to the text craft panel with fallback alignment to closest available weights
- Implement resolution-adaptive default text sizes and dynamic size slider limits based on canvas dimensions
- Scale text resize handles counter-proportionally to canvas zoom to keep their screen size constant (8px)
- Add custom canvas pixel `ColorSampler` with precision crosshairs and a magnifier grid overlay (shortcut 'I')
- Refactor inline text editing into a session-driven pattern (create/modify)
- Fix paint brush bake command not updating `cx`/`cy`/`visibleShape`, causing bounding box to stay stale on subsequent strokes

---

## v1.0.0-beta.14

- Add declarative drawer auto-reveal/auto-collapse system driven by editor state transitions (e.g., active tools, layer counts)
- Resolve TypeScript type resolution issues by introducing `gen-plugin-types` script to auto-generate `commands.d.ts` declarations for all plugins
- Refactor cross-plugin constants into namespace-grouped typed API schemas to enhance auto-completion and type safety

---

## v1.0.0-beta.13

- Add selection feather (0–250px edge softening) for masks, drill, layer-via-copy/cut operations
- Add camera RAW format support (CR2, CR3, NEF, ARW, DNG, etc. 1200+ formats) via libraw-wasm client-side decoding
- Improve magic wand selection quality: 4-neighbor BFS to prevent diagonal leakage, morphological closing to fill holes, connected-component filtering, Chaikin curve smoothing
- Reorganize sidebar drawer layout (left/right split), improve AI Bridge drawer UX, add hover glow on drawer bar items

---

## v1.0.0-beta.12

- Add AI background removal plugin (BgRemovalDrawer) with RMBG 1.4 and InSPyReNet models, custom HuggingFace model support, fully client-side inference (WebGPU → WASM fallback)
- Add application-level memory tracker (ResourceTracker) with per-category allocation stats and top-N large object visibility
- Redesign DebugInfoPanel with real-time FPS counter, JS heap metrics, and ResourceTracker integration
- Enhance LayoutInfoPanel and StorageInfoPanel with richer diagnostics
- Refine ClipOverlay interactions and ClipOptions commands

---

## v1.0.0-beta.11

- Add Onboarding plugin with spotlight bubbles and everyday tips guidance system
- Smart paste workflow: auto-create frame when pasting with no canvas, show choice dialog (New Layer / New Frame) when pasting with active frame
- Redesign landing page with animated orbs, mesh grid, and fluid blob accents (pure CSS GPU animations)
- Fix AI Bridge streaming error when calling gpt-image models via litellm gateway

---

## v1.0.0-beta.10

- Add custom cursors for clip tools (rect, ellipse, lasso, wand — each with crosshair + tool badge)
- Implement useClipCursor hook to auto-apply cursor override when clip mode is active
- Add dedicated TOOLTIP z-index (10100) to ensure tooltips always float above popovers
- Add tool identity badge to brush cursor (droplet for brush, × for eraser)
- Add anti-alias (AA) support for lasso and wand tools
- Decouple clip bake from Esc key, rebind to Enter

---

## v1.0.0-beta.9

- Migrate clip tool to per-frame model with independent imageCropBox / irregularCropBoxes per frame
- Simplify core type system (actions, primitives, models, state)
- Consolidate geometry operators (polygon, transform)
- Simplify reducer and useEditorStore with per-frame data flow
- Fix imageCropBox reset on frame create/resize
- Simplify camera init with layout-aware centering

---

## v1.0.0-beta.8

- Clip Polygon Overlay interaction
- Polygon / Lasso crop visualization overlay

---

## v1.0.0-beta.7

- Pinned ToolMenu layout as an icon-only dock with tooltips
- Adjust ToolMenu width to 280px
- Fix viewport camera centering skew when tool menu is pinned

---

## v1.0.0-beta.6

- Preparatory version bump (baseline before workspace layout refactor)

---

## v1.0.0-beta.5

- GIF and BMP format detection support
- HUD notification system (actions.notifyHUD)
- Refactor brush opacity/hardness keyboard shortcuts
- Snap brush size adjustments to multiples of 5

---

## v1.0.0-beta.4

- Optimize ImageInfoDrawer and widget layouts

---

## v1.0.0-beta.3

- SSO cross-site login sync with optimized auth flow UI
- Fix OAuth popup centering relative to browser window

---

## v1.0.0-beta.2

- Fix cloud save/open asset extraction bug

---

## v1.0.0-beta.1

- Editor core architecture (layer system, rendering pipeline, state management)
- Plugin system (base plugin: brush, text, crop, eraser, shapes, etc.)
- Tiled rendering engine with viewport interaction
- Local storage (IndexedDB + localForage)
- File format support: JPEG, PNG, WebP, AVIF, HEIC, PSD, SVG
