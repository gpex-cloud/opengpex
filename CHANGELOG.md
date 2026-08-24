# Changelog

All notable changes to OpenGPEX are documented in this file.

---

## v1.0.0-beta.58

- Clip Tool: added union merge — select multiple cut fragments and combine them into a single layer with full vector precision, no rasterization
- Clip Tool: adjusted union merge rules to allow parent-child fragment merging
- Clip Tool: improved geometry operations for polygon union and intersection
- Rendering: fixed sub-pixel seams between nested cut fragments at non-integer zoom levels (path-type visibleShape expansion)

---

## v1.0.0-beta.57

- Clip Tool: cut operations are now fully reversible — merge back restores the original layer with zero quality loss, even across multi-level recursive cuts
- Clip Tool: all selection × layer shape combinations (including path-on-path) now resolve with precise geometry, eliminating fallback to pixel rasterization

---

## v1.0.0-beta.56

- Clip Tool: unified cut/copy logic — lossless when possible, seamless fallback to physical
- Clip Tool: cut holes now use vector masks, eliminating visible edge seams on subsequent operations
- Clip Tool: added path-based ellipse selection for accurate ellipse clips without shape distortion

---

## v1.0.0-beta.55.1

- AI Tools: fixed upscaler commands not responding due to inconsistent naming

---

## v1.0.0-beta.55

- AI Tools: unified model cache with local export/import — all AI models share a single managed storage layer; cached models can be saved as zip and re-imported on another device without re-downloading
- Image Info: cleaner display for AI generation metadata and frame details

---

## v1.0.0-beta.54

- Code Quality: unified asset ID naming across all public APIs (`assetId` everywhere, no more `id`/`hash` inconsistency)
- Code Quality: renamed all internal `crop*` identifiers to `clip*` for consistent naming with the Clip tool system

---

## v1.0.0-beta.53

- Brush & Mosaic: fixed race condition on rapid strokes and eliminated flash artifact during bake
- Eraser: fixed not working on text layers

---

## v1.0.0-beta.52

- Export: unified to a single 8-bit composite pipeline, removed 16-bit paths (prep for WebGPU)
- Storage: removed in-memory rawBuffer cache — source files now stored directly in IndexedDB
- Storage Panel: added detailed storage info panel showing asset pool, frame metrics, history, and model cache usage

---

## v1.0.0-beta.51

- Import: batch progress indicator ("Loading 2/5…"), smarter duplicate handling (overwrite/keep both/skip), and separate GIF/TIFF pipelines for better reliability
- Re-Canvas: new interactive edge-resize mode — drag canvas edges directly to crop or expand
- Viewport: fixed a 1-frame stretch glitch when resizing the window
- PNG: orientation now reads correctly from AI-generated images (e.g. Gemini) that store it in XMP
- Layers: live displacement label shown while dragging a layer (e.g. "→ 42 ↓ 18")
- Smart Guides: toggle state saved to preferences (persists across sessions)

---

## v1.0.0-beta.50

- Selection: added **Invert Selection** using polygon boolean ops for clean geometry; fixed magic wand expand/contract missing edge pixels
- Re-Canvas: smart edge anchoring — numeric resize pins the aligned edge and expands from the opposite side; pixel grid rounding always applied
- Viewport: **fix canvas edge sub-pixel artifacts** — pixel-snap artboard clip & backdrop to eliminate ghost lines during pan/zoom
- Pixel Grid: fix ghost line residuals during panning (clearRect margin expansion)

---

## v1.0.0-beta.49

- Interaction: **fixed critical mis-detection** where micro-movements during click were misread as drag — click threshold tightened for precise control; move-delta indicator no longer flashes on trivial movements
- Selection: Re-Canvas now starts at 110% of the canvas size for easier expansion; ellipse handles always visible; tool switching preserves previous selection for quick round-trip editing

---

## v1.0.0-beta.48

- Interaction: redesigned transform gesture system with structured intents and declarative rules; added async handler for click-to-compute tools; pointer metadata (pressure, tilt, device type) now available in events; transaction state machine with lifecycle guards; Esc key gesture cancellation
- Perf: idle ticker no longer wakes on bare mouse movement, reducing GPU usage when hovering
- UI: improved tab grouping with stable identifiers for i18n

---

## v1.0.0-beta.47

- Cloud Gallery: add download progress display when opening files

---

## v1.0.0-beta.46

- AI Tools: new Inpaint Eraser tool for removing unwanted objects from images; added Transformers.js as an alternative inference engine for better compatibility; reorganized shared modules (download, inference, UI) to reduce duplication
- Perf: marching ants path simplification (Douglas–Peucker reduces complex selections from 5k–50k to ≤1200 vertices before SVG rendering, with reference-equality caching) and idle ticker skip (`useFastSync` subscribers skip execution when not interacting and buffer unchanged, eliminating continuous 60fps CPU overhead)
- Storage: improved storage usage display

---

## v1.0.0-beta.45

- ComfyBridge: unified Refresh button with auto-sync, connection timeout, auto-detect seed params on import, improved server history panel
- Export: simplified download pipeline with host-layer filtering; 16-bit toggle auto-syncs with source bit depth
- UI: increased font sizes in ComfyBridge panels for better readability

---

## v1.0.0-beta.44

- Linear-light blending: canvas preview now matches export for 16-bit and Display P3 documents, including HSL blend modes (hue, saturation, color, luminosity)
- Fix visible seam lines on tiled layers with blend modes or reduced opacity
- Layers panel: Blend & Opacity section is now collapsible (collapsed by default)

---

## v1.0.0-beta.43

- Fix filter flash when adjusting multiple layers simultaneously
- Fix exported images appearing rotated or color-shifted in certain viewers
- Middle-click pan, Ctrl+drag selection, and scroll-zoom fixes for better Windows/cross-platform support
- Text overflow indicator and improved layer thumbnails in panels
- Simplified tool-switching in the craft toolbar

---

## v1.0.0-beta.42.1

- TIFF EXIF round-trip: support extracting and re-embedding EXIF from TIFF sources on export, with automatic byte-order conversion when endianness differs
- Consolidate metadata type definitions into a single module for cleaner imports
- Resize & Export panel: add collapsible section header, simplify TIFF advanced options

---

## v1.0.0-beta.42

- Modular file handlers: each image format (JPEG, PNG, TIFF, AVIF, HEIC, WebP, RAW) is now split into separate encode, decode, and metadata modules for better maintainability
- Unified metadata model: a two-layer design (semantic + raw) ensures EXIF, ICC, and DPI data survive import→edit→export without loss
- Native metadata parsing: new ISOBMFF and TIFF IFD readers replace third-party workarounds for reading embedded metadata

---

## v1.0.0-beta.41

- Viewport scroll overhaul: fix erratic zoom/pan on Windows mouse wheels, normalize Firefox scroll units, add Shift+scroll for horizontal panning
- Fix tile flicker: layers no longer flash white blocks while tiles are loading; transparent tile areas are now skipped to save memory
- Mosaic tool: added XL size preset for larger pixelation blocks; hold Cmd/Ctrl to paint on a new layer
- Fix divider borders not visible in dark mode across drawer panels
- New Preferences panel in Settings: switch between Legacy and Modern scroll modes; changes apply instantly and persist across sessions
- User preferences infrastructure with automatic localStorage persistence and declarative manifest for future settings
- Decouple snap/smart-guide configuration from plugin layer into core PresetsFactory, eliminating reverse dependency from stage to plugins
- Add "Reset to Defaults" buttons to Preferences and SmartGuides settings panels
- DebugInfoPanel: add tile cache monitoring metrics
- AVIF export: add dedicated `avif-worker.js` (@jsquash/avif) and `USE_VIPS_FOR_ICC_AVIF` switch to route encoding between isolated Worker (default, crash-safe) and vips-heif (ICC embed)

---

## v1.0.0-beta.40

- New Mosaic tool: paint over areas to pixelate them, with S/M/L block-size presets (shortcut: M)
- Improved cursor badge positioning for all brush tools

---

## v1.0.0-beta.39

- Wide gamut color support: Display P3 and Adobe RGB images now keep their full colors on import
- Linear-light compositing: layer blending and Gaussian blur produce more natural results on bright areas
- Fast export: unedited single-layer images export instantly without re-encoding
- Smart canvas color space: automatically uses P3 when both image and display support it
- Each document now tracks its working color space
- Centralized color pipeline replacing scattered per-format logic
- New SVG slider widget (`FancySvgSlider`) replacing native range inputs in all adjustment panels; removed legacy `FancySlider`; renamed `FunctionGroup` → `FunctionTabs`

---

## v1.0.0-beta.38

- Zoom slider overhaul: piecewise scale mapping with center-pivot zoom, clickable tick marks (.25–32x) with snap-to-tick, larger hit areas
- TabDock frame navigation (Alt+←/→): restrict to trunk frames only, skip branch frames
- Unified filter pipeline: all adjustments now go through a single rendering path (no more legacy/advanced split)
- Improved brightness and contrast curves (midtone-weighted quadratic + tanh S-curve, preserves blacks and whites)
- Filter rendering performance: cache results during pan/zoom to avoid redundant recomputation
- Viewport zoom range expanded to 10%–12800% with centralized constants
- Fix LAN access: auto-detect local IPs for dev server cross-origin allowlist
- Fix image loading crash on HTTP LAN by adding MurmurHash3-128 fallback hash

---

## v1.0.0-beta.37

- Rework brush-related keyboard shortcuts and fix Alt/Option key issues on macOS
- Fix code-gen script parsing issue with commented-out lines
- UserGuidePanel: redesign as category-grouped layout with collapsible sections, deduplicate opacity digit keys into a single entry
- Keyboard shortcuts: add Settings Panel `⌘,`, fix Download to `⌘⇧S` (remove conflicting `⌘⇧E`), add `category` field to `EditorCommand` type for all commands

---

## v1.0.0-beta.36

- Color Balance: new adjustment panel for shadow/midtone/highlight color shifts with luminosity preservation and smooth tone-region blending (Cmd+B / Ctrl+B)
- Supports 8-bit and high-resolution (16-bit/32-bit) rendering paths
- Adjustment drawer panel switcher now shows keyboard-shortcut letters instead of icons

---

## v1.0.0-beta.35

- Channel View: view individual R/G/B/A channels as grayscale, or any two-channel combination in color
- New Channels panel in the Layers drawer with per-channel toggle buttons
- Refactor LayersDrawer: extract LayersPanel for cleaner code organization

---

## v1.0.0-beta.34

- ICC color management: accurate import conversion for non-sRGB profiles (Adobe RGB, ProPhoto, Display P3) and lossless profile round-trip across all formats (JPEG, PNG, WebP, AVIF, HEIC)
- AVIF encoding now uses the unified vips engine (vips-heif) — faster, smaller footprint, and supports ICC profile embedding and DPI metadata
- Histogram in Levels panel now computed at full resolution in a background Worker, matching Photoshop's RGB composite display without blocking the UI
- Cross-platform keyboard shortcuts (Cmd on Mac, Ctrl on Windows/Linux) for all major actions
- New hotkeys: Cmd+U/M/L to open adjustment panels, Cmd+A/D for select all/deselect, number keys 1–0 for quick layer opacity, Alt+Backspace for fill as new layer
- Fix snapping, layer movement, peel/merge, and birth-position guides for rotated/flipped layers

---

## v1.0.0-beta.33

- Landing page: refreshed feature badges, dynamic version, GitHub link, and clearer shortcut display
- Cloud login: dual-channel OAuth relay for SharedArrayBuffer environments
- Simplified viewport camera init and improved cloud sync state tracking

---

## v1.0.0-beta.32

- Redesign pixel engine: replace single monolithic service with a modular facade + dispatcher architecture for better maintainability and performance
- New dedicated worker handlers for compositing, decoding, resampling, tiling, high-depth processing, and file I/O
- Separate on-screen (interactive) and off-screen (export) rendering paths
- Rewrite Pixel Grid overlay from CSS gradients to Canvas2D — reduces per-frame cost from ~16ms to ~0.3ms with idle dirty-checking
- Overhaul overlay performance: tiered ticker scheduling, shared state snapshot caching, and inactive subscriber sleeping — sustains 120fps with 30+ active overlays
- Refactor brush tool internals into a stroke module with session-based paint and mask modes
- Refactor frame import pipeline into cleaner importer modules
- Add idle power management: automatically throttle animation ticker to 4fps after 2 seconds of inactivity, and fully sleep it when the browser tab is hidden — eliminates CPU heating when idle at high zoom

---

## v1.0.0-beta.31

- Unified composite pipeline: eliminate redundant decode round-trips during render and export
- ComfyUI Bridge: active-layer input now includes transforms, masks, and adjustments
- ComfyUI Bridge: sync workflow parameters directly from a live ComfyUI instance — types, ranges, and dropdown options are now auto-detected
- ComfyUI Bridge: settings panel split into dedicated Environments and Workflows tabs
- Tab Dock: Metrics HUD can now be toggled on/off in settings

---

## v1.0.0-beta.30

- Unify clip selection internal representation — all tool types (rect/ellipse/lasso/wand) now use a single polygon format, enabling consistent shape recognition and anti-alias routing across the entire pipeline
- Improve layer merge and export: color layers render natively without pre-rasterization; layer adjustments are now applied in 16-bit precision during high-res export
- Drawer auto-reveal: add `'restore'` mode — drawers that were closed before auto-reveal will close again when the trigger condition clears

---

## v1.0.0-beta.29

- Improve "Refocus Selection" in Layers Drawer to correctly restore irregular selections (lasso, wand, SAM) and switch back to the original clip tool
- Fix irregular selections (lasso, wand) not respecting the anti-alias setting when used for color fill or export crop
- Fix "Select from Alpha" not switching the active clip tool to wand after producing a polygon selection
- Fix Turbopack build warnings caused by over-broad Node File Tracing in plugin API routes

---

## v1.0.0-beta.28

- Add **ComfyUI Bridge** drawer — connect to ComfyUI, manage and run workflows with real-time progress, browse generation history
- Fix exported images missing text and solid-color fill layers
- Support color-fill into irregular selections (lasso, wand)
- New shared widgets: FancyGroup, ComfyNumberInput, StatusBanner
- Refresh AI drawer icons and simplify AIBridgeDrawer UI

---

## v1.0.0-beta.27

- Decompose monolithic AIToolsDrawer into feature-based sub-modules with per-feature panel, commands, protocols, hooks, settings, worker, and client
- Extract shared model infrastructure (ModelCard, ModelSettingsShell, ModelDownloader, download utilities, useModelManager)

---

## v1.0.0-beta.26

- Add AI Segmentation (SAM) clip tool with point/box prompts, dedicated Web Worker, and unified model download & cache service layer
- Improve selection move-delta label: directional arrows (→←↑↓) with absolute values, visible throughout drag
- Enhance FileLoader overlay UI and refactor widget system (remove legacy components)
- Extend gen-plugin-types auto-generation to cover all plugin command declarations

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
