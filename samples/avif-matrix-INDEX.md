# AVIF Matrix Acceptance Samples (12MP Large Images, Generated 2026-10-13)

> 2026-10-14: flattened into `samples/` and renumbered 22–32 alongside the other test images; row tokens (15a / 15b / 16-wg / 17 / 18 / 26) reference `05_ingest_decision_spec.md` and are kept in the file names.

> Generator: `gpex-assets/probes/avif/make-large-samples.mjs` (4032×3024 scene: hue sweep + luminance gradient ramp + 12×5 saturated color patch grid (including skin tones and RGB secondaries) + radial detail star + vignette; 10/12-bit generated directly as YUV at native bit depths, not upsampled from 8-bit).
> Container facts verified per file using `structure-probe.mjs --scan`; expected routing follows `05_ingest_decision_spec.md` rows 15a / 15b / 16-wg / 17 / 18 / 26.

| File | Container Facts | Expected Behavior (Drop into Editor) |
|---|---|---|
| `22_avif_15a_sdr8_srgb_12mp.avif` | 8-bit · nclx 1/13/1 limited · 420 | Row 15a: Direct original file passthrough (`retainSourceBlob=false`), instant open |
| `23_avif_15a_p3_8bit_12mp.avif` | 8-bit · nclx 12/13/6 full · 444 | Row 15a: Direct P3 passthrough; saturated patches in the color grid should noticeably exceed sRGB gamut |
| `25_avif_15b_sdr10_12mp.avif` | **10-bit** · nclx 1/13/1 · 420 | Row 15b: avif-proxy → direct f16 ingest, `colorIdentity.bitDepth=10`; gradient ramp must exhibit no 8-bit banding; 1–3s initial warm-up delay on cold Worker start is a known behavior |
| `26_avif_15b_sdr12_12mp.avif` | **12-bit** · nclx 1/13/1 · 420 | Row 15b: Same as above, `bitDepth=12` |
| `27_avif_17_adobe8_icc_12mp.avif` | 8-bit · **colr prof (Adobe RGB)** · 444 | Row 17: wide-gamut-8 → linear f16 + collapsed P3 display proxy |
| `28_avif_16wg_adobe10_icc_12mp.avif` | **10-bit** · colr prof (Adobe RGB) · 444 identity | Row 16-wg: avif-proxy → degamma true linear f16 (mirrors 19-wg) |
| `29_avif_18_pq10_bt2020_12mp.avif` | 10-bit · nclx 9/**16**/9 | Row 18: **Reject import** ("Currently unsupported", HDR tone mapping out of scope) |
| `30_avif_18_hlg10_bt2020_12mp.avif` | 10-bit · nclx 9/**18**/9 | Row 18: Same as above |
| `31_avif_18_bt2020sdr10_12mp.avif` | 10-bit · nclx 9/**13**/9 | Row 18: Same as above (BT.2020 pending gap #8; error message must specify gamut reason) |
| `24_avif_15a_alpha_8bit_12mp.avif` | 8-bit + **alpha aux** (radial soft-edge transparency) | Row 15a: Outside of the radial disc must be genuinely transparent; `skipContentBoundsScan=false` |
| `32_avif_26_animated_720p.avifs` | 1280×720 · **moov sequence** · 16 frames | Row 26: **Reject import** (Animations currently unsupported — legacy pipeline silently ingested the first frame, this file serves as a regression anchor) |

Key Reminders:
- The acceptance focus for 10/12-bit samples is **banding in shadows / gradient ramps** (12-bit version should be a tier smoother than 8-bit) and the bit depth declaration in layer info (10/12, not 8).
- The expected behavior for the three negative cases (PQ / HLG / BT.2020) is an **explicit error**, not rendering an image — if an image is rendered (even if it looks normal), it is considered a regression.
- Same applies to animated samples: rendering a still frame = regression; throwing "Currently unsupported" = expected behavior.
